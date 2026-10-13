import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createUrlImportController, normalizeUrlImportInput, urlImportFingerprint } from '../src/infrastructure/recovery/url-import';
import { RecoveryError } from '../src/infrastructure/recovery/types';

const keys = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const url = 'https://media.example.invalid/fixture.png';
function fixture() {
  const state = { allowed: true, fetches: 0, uploads: 0, mimeChecks: 0, metadataChecks: 0, metrics: 0, heads: 0, ended: false, validated: true };
  const rows = new Map<string, any>(); const writes: string[] = []; const intents: any[] = [];
  const ctx = { state: { user: { id: 4 }, userAbility: { allowed: true }, gthfMediaCommittedReplay: false },
    request: { body: { urls: [url], folderId: null, operationKeys: [keys[0]] } }, respond: true,
    res: { destroyed: false, writeHead() { state.heads++; }, write(value: string) { writes.push(value); }, end() { state.ended = true; } } };
  const permission = { engine: { generateUserAbility: async () => ({ allowed: state.allowed }) },
    createPermissionsManager: ({ ability, action }: any) => ({ action, isAllowed: ability.allowed,
      ability: { cannot: () => !state.allowed }, toSubject: (value: any) => value, sanitizeOutput: async (value: any) => value }) };
  const fileService = { fetchUrlToInputFile: async () => { state.fetches++; return { file: { originalFilename: 'fixture.png', size: 10 } }; }, signFileUrls: async (file: any) => file };
  const strapi = { service: (name: string) => name === 'admin::permission' ? permission : { findOne: async (id: number) => ({ id, isActive: true }) },
    plugin: () => ({ service: (name: string) => name === 'file' ? fileService : name === 'metrics' ? { trackUsage: async () => { state.metrics++; } } : {} }),
    config: { get: () => ({ sizeLimit: 100 }) } };
  const recovery: any = { batches: { get: async () => undefined }, journal: { get: async (key: string) => rows.get(key),
    getOwned: async (key: string, actor: string) => { const row = rows.get(key); if (row.actor !== actor) throw new RecoveryError(404, 'OPERATION_NOT_FOUND', 'Operation not found'); return row; } },
    uploadFromUrl: async (_original: any, _request: any, intent: any) => {
      state.uploads++; intents.push(intent);
      const receipt = [{ id: state.uploads, mime: 'image/png', name: 'fixture.png' }];
      rows.set(intent.key, { actor: 'admin:4', admin_user_id: 4, kind: 'upload', request_hash: intent.requestHash, state: 'committed', receipt });
      return receipt;
    } };
  const validators = { prepareUploadRequest: async (file: any) => { state.mimeChecks++; return { validFiles: state.validated ? [file] : [], errors: [] }; },
    validateUploadBody: async (data: any) => { state.metadataChecks++; return data; } };
  const controller = createUrlImportController(strapi, recovery, validators);
  const events = () => writes.map((value) => { const [event, data] = value.trim().split('\n'); return { event: event.slice(7), data: JSON.parse(data.slice(6)) }; });
  const committed = (key = keys[0], stateValue = 'committed') => rows.set(key, { key, actor: 'admin:4', admin_user_id: 4, kind: 'upload',
    request_hash: urlImportFingerprint(url, null), state: stateValue, failure: stateValue === 'failed' ? 'INVALID_MEDIA' : null,
    receipt: [{ id: 42, mime: 'image/png', name: 'existing.png' }] });
  return { ctx, state, rows, intents, writes, events, committed, recovery, controller, fileService };
}

test('URL import validates one distinct explicit identity per HTTP(S) URL and binds its destination', () => {
  const normalized = normalizeUrlImportInput({ urls: ['https://MEDIA.example.invalid', url], operationKeys: keys, folderId: 4 });
  assert.equal(normalized.urls[0], 'https://media.example.invalid/');
  assert.notEqual(urlImportFingerprint(url, null), urlImportFingerprint(url, 4));
  for (const input of [null, { urls: [url] }]) assert.throws(() => normalizeUrlImportInput(input), (e: any) => e.code === 'ADMIN_RELOAD_REQUIRED');
  for (const input of [
    { urls: [url], operationKeys: [] }, { urls: [url, url], operationKeys: [keys[0], keys[0]] },
    { urls: ['file:///etc/passwd'], operationKeys: [keys[0]] }, { urls: ['https://user:password@example.invalid'], operationKeys: [keys[0]] },
    { urls: [url], operationKeys: [keys[0]], folderId: -1 }, { urls: [url], operationKeys: [keys[0]], force: true },
    { urls: [url], operationKeys: [''] }, { urls: [url + ' '], operationKeys: [keys[0]] },
  ]) assert.throws(() => normalizeUrlImportInput(input));
});
test('a legacy URL import fails before SSE headers or any external effect', async () => {
  const f = fixture(); delete (f.ctx.request.body as any).operationKeys;
  await assert.rejects(f.controller(f.ctx), (e: any) => e.code === 'ADMIN_RELOAD_REQUIRED');
  assert.equal(f.state.heads, 0); assert.equal(f.state.fetches, 0); assert.equal(f.state.uploads, 0);
});
test('a URL response lost after commit replays its receipt without downloading or uploading twice', async () => {
  const f = fixture(); await f.controller(f.ctx);
  assert.equal(f.state.fetches, 1); assert.equal(f.state.uploads, 1); assert.equal(f.state.mimeChecks, 1); assert.equal(f.state.metadataChecks, 1);
  assert.deepEqual(f.intents, [{ key: keys[0], requestHash: urlImportFingerprint(url, null) }]);
  const first = f.events().find((event) => event.event === 'file:complete')!.data;
  assert.equal(first.operationKey, keys[0]); assert.equal(first.replayed, false);
  f.writes.length = 0; f.fileService.fetchUrlToInputFile = async () => { throw new Error('Source has changed and must not be consulted'); };
  await f.controller(f.ctx);
  const second = f.events().find((event) => event.event === 'file:complete')!.data;
  assert.equal(second.replayed, true); assert.deepEqual(second.file, first.file);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.metrics, 1); assert.equal(f.state.ended, true);
});
test('new URL intentions remain separate even when their source and resulting bytes are identical', async () => {
  const f = fixture(); f.ctx.request.body = { urls: [url, url], operationKeys: keys, folderId: null };
  await f.controller(f.ctx);
  assert.equal(f.state.uploads, 2); assert.deepEqual(f.intents.map((intent) => intent.key), keys);
  assert.equal(f.events().filter((event) => event.event === 'file:complete').length, 2);
});
test('URL ownership, destination and source conflicts are rejected before SSE starts', async () => {
  for (const change of ['url', 'folder', 'actor', 'kind']) {
    const f = fixture(); f.committed();
    if (change === 'url') f.ctx.request.body.urls = ['https://other.example.invalid/changed.png'];
    if (change === 'folder') (f.ctx.request.body as any).folderId = 2;
    if (change === 'actor') f.rows.get(keys[0]).actor = 'admin:9';
    if (change === 'kind') f.rows.get(keys[0]).kind = 'delete';
    await assert.rejects(f.controller(f.ctx), (e: any) => e.code === (change === 'actor' ? 'OPERATION_NOT_FOUND' : 'IDEMPOTENCY_CONFLICT'));
    assert.equal(f.state.heads, 0); assert.equal(f.state.fetches, 0);
  }
});
test('pending and terminal URL entries are not refetched while independent entries may succeed', async () => {
  for (const state of ['prepared', 'failed']) {
    const f = fixture(); f.committed(keys[0], state); f.ctx.request.body = { urls: [url, url], operationKeys: keys, folderId: null };
    await f.controller(f.ctx);
    const error = f.events().find((event) => event.event === 'file:error')!.data;
    assert.equal(error.operationKey, keys[0]); assert.equal(error.retryable, false);
    assert.equal(error.code, state === 'prepared' ? 'OPERATION_PENDING' : 'INVALID_MEDIA');
    assert.equal(f.state.fetches, 1); assert.equal(f.state.uploads, 1);
    assert.equal(f.events().find((event) => event.event === 'stream:complete')!.data.data.length, 1);
  }
});
test('a proven interrupted URL entry retries with the same key and no parent journal', async () => {
  const f = fixture(); f.committed(keys[0], 'interrupted'); await f.controller(f.ctx);
  assert.equal(f.intents[0].key, keys[0]); assert.equal(f.state.fetches, 1); assert.equal(f.state.uploads, 1);
});
test('current permissions are checked before receipt replay and again before every URL fetch', async () => {
  const f = fixture(); f.committed(); f.state.allowed = false;
  await assert.rejects(f.controller(f.ctx), (e: any) => e.code === 'AUTHORIZATION_REVOKED'); assert.equal(f.state.heads, 0);
  const g = fixture(); g.ctx.request.body = { urls: [url, url], operationKeys: keys, folderId: null };
  const upload = g.recovery.uploadFromUrl;
  g.recovery.uploadFromUrl = async (...args: any[]) => { const result = await upload(...args); g.state.allowed = false; return result; };
  await g.controller(g.ctx);
  assert.equal(g.state.fetches, 1); assert.equal(g.events().find((event) => event.event === 'file:error')!.data.code, 'AUTHORIZATION_REVOKED');
});
test('MIME validation and real Strapi SSRF protection remain ahead of upload effects', async () => {
  const f = fixture(); f.state.validated = false; await f.controller(f.ctx);
  assert.equal(f.state.uploads, 0); assert.equal(f.events().find((event) => event.event === 'file:error')!.data.code, 'INVALID_MEDIA');
  const g = fixture(); g.ctx.request.body.urls = ['http://127.0.0.1/private'];
  const root = path.dirname(require.resolve('@strapi/upload/package.json'));
  const fetchFile = require(path.join(root, 'dist/server/services/file.js')).fetchUrlToInputFile;
  assert.equal(typeof fetchFile, 'function');
  await assert.rejects(fetchFile('http://127.0.0.1/private', '/tmp', 100), /blocked address/);
  g.fileService.fetchUrlToInputFile = fetchFile;
  await g.controller(g.ctx); assert.equal(g.state.uploads, 0);
  assert.equal(g.events().find((event) => event.event === 'file:error')!.data.code, 'URL_IMPORT_UNCERTAIN');
});
