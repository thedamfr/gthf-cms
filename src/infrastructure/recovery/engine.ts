import { sanitize } from '@strapi/utils';
import { randomUUID } from 'node:crypto';
import { MediaJournal } from './journal';
import { createFaultGate, FaultPoint } from './fault-gate';
import { existingObjects, prepareMedia, requestFingerprint } from './prepare';
import { RecoveryStorage, sha256 } from './storage';
import { Actor, FILE_UID, Operation, OperationKind, RecoveryError, RECONCILE_MS, publicReceipt } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function operationKey(value?: string) {
  if (!value) return randomUUID();
  if (!UUID.test(value)) throw new RecoveryError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID');
  return value.toLowerCase();
}
export function actorFor(ctx: any, user?: any): Actor {
  if (ctx?.state?.userAbility && ctx.state.user?.id) return { id: `admin:${ctx.state.user.id}`, adminUserId: ctx.state.user.id };
  if (ctx?.state?.auth?.strategy?.name === 'api-token' && ctx.state.auth.credentials?.id) return { id: `api-token:${ctx.state.auth.credentials.id}` };
  if (ctx?.state?.user?.id) return { id: `user:${ctx.state.user.id}` };
  if (!ctx && user?.id) return { id: `admin:${user.id}`, adminUserId: user.id };
  if (!ctx) return { id: 'internal' };
  // A public permission accidentally granted to upload must not expose a shared receipt actor.
  throw new RecoveryError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required for media operations');
}
export class MediaRecovery {
  readonly journal: MediaJournal;
  private gate: ReturnType<typeof createFaultGate>;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  constructor(private readonly strapi: any, private readonly storage: RecoveryStorage) {
    this.journal = new MediaJournal(strapi);
    this.gate = createFaultGate();
  }
  async start() {
    await this.journal.initialize();
    this.timer = setInterval(() => { void this.reconcile(); }, RECONCILE_MS);
    this.timer.unref();
    void this.reconcile();
  }
  async stop() { this.stopped = true; clearInterval(this.timer); this.storage.close(); }
  private context(user?: any, targetId?: number) {
    const ctx = this.strapi.requestContext.get();
    const actor = actorFor(ctx, user);
    let key = operationKey(ctx?.get('Idempotency-Key'));
    // Bulk deletion uses one durable child intent per target. Ordinary uploads and
    // single-file endpoints preserve exactly the UUID sent by the client.
    if (ctx?.path?.endsWith('/actions/bulk-delete') && targetId !== undefined) {
      const hex = sha256(`${key}:delete:${targetId}`);
      key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    }
    ctx?.set('Idempotency-Key', key);
    return { ctx, actor, key };
  }
  private async checkpoint(point: FaultPoint, operation: Operation, objectIndex?: number) {
    await this.gate(point, { key: operation.key, attempt: operation.attempt, objectIndex });
  }
  private heartbeat(operation: Operation) {
    let active = false;
    const timer = setInterval(async () => {
      if (active) return;
      active = true;
      try { await this.journal.heartbeat(operation); }
      catch { /* Every storage mutation and final commit checks the lease again. */ }
      finally { active = false; }
    }, RECONCILE_MS);
    timer.unref();
    return () => clearInterval(timer);
  }
  private async execute(original: any, kind: OperationKind, data: any, files: any[], user?: any, oldFile?: any) {
    const { actor, key } = this.context(user, oldFile?.id);
    const requestHash = await requestFingerprint(kind, oldFile?.id, data, files);
    const { operation, acquired } = await this.journal.begin({ key, actor, kind, requestHash, targetId: oldFile?.id });
    if (!acquired) {
      if (operation.state === 'committed') return operation.receipt;
      if (operation.state === 'failed') throw new RecoveryError(409, operation.failure || 'OPERATION_FAILED', 'This media operation could not be completed');
      throw new RecoveryError(409, 'OPERATION_PENDING', 'This media operation is still being recovered');
    }
    const stopHeartbeat = this.heartbeat(operation);
    try {
      const prepared = kind === 'delete'
        ? { manifest: { files: [{ values: {}, targetId: oldFile.id, previousHash: oldFile.hash, previousUpdatedAt: new Date(oldFile.updatedAt).toISOString(), permissionSubject: oldFile }],
          objects: [], obsolete: existingObjects(oldFile, this.storage, this.strapi.config.get('plugin::upload').provider) }, bodies: new Map<string, Buffer>() }
        : await prepareMedia(this.strapi, original, this.storage, operation, data, files, oldFile);
      await this.journal.prepare(operation, prepared.manifest);
      await this.checkpoint('after-journal', operation);
      for (const [index, object] of operation.manifest.objects.entries()) {
        await this.journal.assertLease(operation);
        await this.storage.put(object, prepared.bodies.get(object.key)!);
        await this.checkpoint('after-object', operation, index);
      }
      await this.checkpoint('before-commit', operation);
      const result = await this.journal.commit(operation);
      await this.checkpoint('after-commit', operation);
      // Events are informational; they must not turn a committed durable receipt into a failure.
      try {
        for (const media of Array.isArray(result) ? result : [result]) {
          const output = await sanitize.sanitizers.defaultSanitizeOutput({ schema: this.strapi.getModel(FILE_UID), getModel: (uid) => this.strapi.getModel(uid) }, media);
          this.strapi.eventHub.emit(`media.${kind === 'upload' ? 'create' : kind === 'replace' ? 'update' : 'delete'}`, { media: output });
        }
      } catch {}
      return result;
    } catch (error: any) {
      if (error instanceof RecoveryError && ['MEDIA_CHANGED', 'OBJECT_CONFLICT', 'INVALID_MEDIA'].includes(error.code)) {
        try { await this.journal.interrupt(operation, true, error.code); } catch {}
        throw error;
      }
      // Preserve uncertainty after a lost storage response. Recovery checks every
      // immutable object before deciding whether it can commit or must interrupt.
      try { await this.journal.db('gthf_media_operations').where({ key: operation.key, attempt: operation.attempt, lease_owner: this.journal.owner })
        .whereIn('state', ['preparing', 'prepared']).update({ lease_until: this.journal.db.fn.now() }); } catch {}
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError(503, 'OPERATION_PENDING', 'Media recovery is pending; keep the operation key and retry');
    } finally { stopHeartbeat(); }
  }
  upload(original: any, request: any, opts?: any) {
    return this.execute(original, 'upload', request.data, Array.isArray(request.files) ? request.files : [request.files], opts?.user);
  }
  async replace(original: any, id: number, request: any, opts?: any) {
    const oldFile = await this.strapi.db.query(FILE_UID).findOne({ where: { id }, populate: ['createdBy', 'folder'] });
    if (!oldFile) throw new RecoveryError(404, 'MEDIA_NOT_FOUND', 'Media not found');
    return this.execute(original, 'replace', request.data, [request.file], opts?.user, oldFile);
  }
  remove(original: any, file: any) { return this.execute(original, 'delete', {}, [], undefined, file); }
  async receipt(key: string, actor: string) { return publicReceipt(await this.journal.getOwned(operationKey(key), actor)); }
  async reconcile() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (let count = 0; count < 8 && !this.stopped; count++) {
        const operation = await this.journal.claimExpired();
        if (!operation) break;
        const stopHeartbeat = this.heartbeat(operation);
        try {
          let complete = operation.state === 'prepared' && !!operation.manifest;
          for (const object of operation.manifest?.objects || []) {
            await this.journal.assertLease(operation);
            if (!await this.storage.exists(object)) { complete = false; break; }
          }
          if (complete) {
            await this.checkpoint('before-commit', operation);
            await this.journal.commit(operation);
            await this.checkpoint('after-commit', operation);
          } else {
            await this.journal.interrupt(operation);
          }
        } catch (error: any) {
          if (error instanceof RecoveryError && ['MEDIA_CHANGED', 'OBJECT_CONFLICT'].includes(error.code)) {
            try { await this.journal.interrupt(operation, true, error.code); } catch {}
          }
          this.strapi.log.warn('[media-recovery] Operation remains pending; dependency or lease unavailable');
        } finally { stopHeartbeat(); }
      }
      for (let count = 0; count < 8 && !this.stopped; count++) {
        const cleanup = await this.journal.claimCleanup();
        if (!cleanup) break;
        try {
          for (const [index, object] of cleanup.objects.entries()) {
            await this.storage.remove(object);
            await this.gate('during-cleanup', { key: cleanup.operation_key, attempt: cleanup.attempt, objectIndex: index });
          }
          await this.journal.finishCleanup(cleanup.id);
        } catch { this.strapi.log.warn('[media-recovery] Object cleanup will be resumed'); }
      }
    } catch { this.strapi.log.warn('[media-recovery] Reconciliation waits for the database'); }
    finally { this.running = false; }
  }
}
