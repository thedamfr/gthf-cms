import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { actorFor, MediaRecovery, operationKey } from './engine';
import { authorizeAdminMediaReceipt } from './authorization';
import { sha256 } from './storage';
import { stableJSON } from './prepare';
import { Operation, RecoveryError } from './types';

export type UrlImportInput = { urls: string[]; folderId: number | null; operationKeys: string[] };
export function normalizeUrlImportInput(input: any): UrlImportInput {
  if (!input || !Array.isArray(input.operationKeys)) throw new RecoveryError(409, 'ADMIN_RELOAD_REQUIRED', 'Actualisez l’administration avant d’importer des médias par URL.');
  if (Object.keys(input).some((key) => !['urls', 'folderId', 'operationKeys'].includes(key))
    || !Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 20
    || input.operationKeys.length !== input.urls.length
    || !(input.folderId == null || Number.isSafeInteger(input.folderId) && input.folderId > 0)) {
    throw new RecoveryError(400, 'INVALID_URL_IMPORT', 'Provide one operation key per URL and a valid destination folder');
  }
  const urls = input.urls.map((value: any) => {
    if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value) throw new RecoveryError(400, 'INVALID_URL_IMPORT', 'An import URL is invalid');
    let url: URL;
    try { url = new URL(value); } catch { throw new RecoveryError(400, 'INVALID_URL_IMPORT', 'An import URL is invalid'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RecoveryError(400, 'INVALID_URL_IMPORT', 'Only HTTP(S) URLs without credentials are accepted');
    return url.href;
  });
  const operationKeys = input.operationKeys.map((value: any) => {
    if (typeof value !== 'string' || !value) throw new RecoveryError(400, 'INVALID_URL_IMPORT', 'Each URL requires an explicit operation key');
    return operationKey(value);
  });
  if (new Set(operationKeys).size !== operationKeys.length) throw new RecoveryError(400, 'INVALID_URL_IMPORT', 'Each URL requires a distinct operation key');
  return { urls, operationKeys, folderId: input.folderId ?? null };
}
export function urlImportFingerprint(url: string, folderId: number | null) {
  return sha256(stableJSON({ intent: 'url-import-v1', url, folderId }));
}
function strapiValidators() {
  const root = path.dirname(require.resolve('@strapi/upload/package.json'));
  if (require(path.join(root, 'package.json')).version !== '5.52.3') throw new Error('Review URL import before changing Strapi upload');
  return { ...require(path.join(root, 'dist/server/utils/mime-validation.js')),
    ...require(path.join(root, 'dist/server/controllers/validation/admin/upload.js')) };
}
/** Pinned Strapi SSE contract with one existing durable upload receipt per URL. */
export function createUrlImportController(strapi: any, recovery: MediaRecovery, validators = strapiValidators()) {
  return async (ctx: any) => {
    const input = normalizeUrlImportInput(ctx.request.body);
    const actor = actorFor(ctx);
    const principal = { actor: actor.id, admin_user_id: actor.adminUserId, kind: 'upload' } as Operation;
    const pm = await authorizeAdminMediaReceipt(strapi, ctx.state.userAbility, principal);
    // Identity, ownership and current permissions fail before starting an SSE response.
    for (const [index, key] of input.operationKeys.entries()) {
      const batch = await recovery.batches.get(key);
      if (batch) {
        await recovery.batches.getOwned(key, actor.id);
        throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'This key already belongs to another operation');
      }
      const candidate = await recovery.journal.get(key);
      const operation = candidate ? await recovery.journal.getOwned(key, actor.id) : undefined;
      if (operation && (operation.kind !== 'upload' || operation.request_hash !== urlImportFingerprint(input.urls[index], input.folderId))) {
        throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'This key already belongs to a different URL or destination');
      }
      if (operation) await authorizeAdminMediaReceipt(strapi, ctx.state.userAbility, operation);
    }
    const service = (name: string) => strapi.plugin('upload').service(name);
    const files = service('file'); const upload = service('upload');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gthf-url-upload-'));
    const response = ctx.res;
    const write = (event: string, data: any) => {
      // A disconnected client may still recover each receipt; keep completing the selected intents.
      if (!response.destroyed) { try { response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
    };
    const successful: any[] = []; const errors: any[] = [];
    let newImage = false;
    try {
      ctx.respond = false;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      for (const [index, url] of input.urls.entries()) {
        const key = input.operationKeys[index];
        write('file:fetching', { url, index, total: input.urls.length });
        try {
          // Reload between entries: another request may have completed this key during the stream.
          const candidate = await recovery.journal.get(key);
          const operation = candidate ? await recovery.journal.getOwned(key, actor.id) : undefined;
          if (operation && (operation.kind !== 'upload' || operation.request_hash !== urlImportFingerprint(url, input.folderId))) {
            throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'The operation key belongs to a different URL or destination');
          }
          if (operation) await authorizeAdminMediaReceipt(strapi, ctx.state.userAbility, operation);
          else await authorizeAdminMediaReceipt(strapi, ctx.state.userAbility, principal);
          let uploaded: any; let replayed = false;
          if (operation?.state === 'committed') {
            uploaded = structuredClone(operation.receipt[0]); replayed = true;
          } else {
            if (operation?.state === 'failed') throw new RecoveryError(409, operation.failure || 'OPERATION_FAILED', 'This URL import could not be completed');
            if (operation && operation.state !== 'interrupted') throw new RecoveryError(409, 'OPERATION_PENDING', 'This URL import is being recovered');
            const { file } = await files.fetchUrlToInputFile(url, directory, strapi.config.get('plugin::upload').sizeLimit);
            const fileInfo = { name: file.originalFilename, caption: null, alternativeText: null, folder: input.folderId };
            write('file:uploading', { name: file.originalFilename, index, total: input.urls.length, size: file.size });
            const prepared = await validators.prepareUploadRequest(file, { fileInfo: JSON.stringify(fileInfo) }, strapi);
            if (!prepared.validFiles.length) throw new RecoveryError(400, 'INVALID_MEDIA', 'The downloaded media failed Strapi validation');
            const data = await validators.validateUploadBody({ fileInfo }, false);
            [uploaded] = await recovery.uploadFromUrl(upload, { data, files: [prepared.validFiles[0]] },
              { key, requestHash: urlImportFingerprint(url, input.folderId) }, { user: ctx.state.user });
            replayed = ctx.state.gthfMediaCommittedReplay === true;
            ctx.state.gthfMediaCommittedReplay = false;
            if (!replayed && uploaded.mime?.startsWith('image/')) newImage = true;
          }
          const signed = await files.signFileUrls(uploaded);
          const output = await pm.sanitizeOutput(signed, { action: 'plugin::upload.read' });
          successful.push(output);
          write('file:complete', { name: uploaded.name, index, file: output, operationKey: key, replayed });
        } catch (error: any) {
          const code = error instanceof RecoveryError ? error.code : 'URL_IMPORT_UNCERTAIN';
          const retryable = !(error instanceof RecoveryError) || ['URL_IMPORT_UNCERTAIN'].includes(code);
          const message = error instanceof RecoveryError ? error.message : 'The URL import could not be confirmed; consult its receipt before retrying';
          errors.push({ name: url, message, operationKey: key, index, code, retryable });
          write('file:error', { url, index, message, operationKey: key, code, retryable });
        }
      }
      if (newImage) { try { await service('metrics').trackUsage('didUploadImage'); } catch {} }
      write('stream:complete', { data: successful, errors });
    } finally { await fs.rm(directory, { recursive: true, force: true }); try { response.end(); } catch {} }
  };
}
