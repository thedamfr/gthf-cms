import { randomUUID } from 'node:crypto';
import { MediaJournal } from './journal';
import { existingObjects, mediaPermissionSubject, mediaVersion, requestFingerprint, stableJSON } from './prepare';
import { sha256, RecoveryStorage } from './storage';
import { Actor, FILE_UID, FOLDER_UID, MEDIA_BATCH_TABLE, MEDIA_OPERATION_TABLE, Operation, RecoveryError, RECONCILE_MS } from './types';
import type { FaultContext, FaultPoint } from './fault-gate';

export type BatchInput = { fileIds: number[]; folderIds: number[] };
export type BatchFile = { key: string; version: string; file: Record<string, any> };
export type BatchManifest = { files: BatchFile[]; folders: Record<string, any>[]; rootFolderIds: number[] };
export type MediaBatch = { key: string; actor: string; admin_user_id: number | null; request_hash: string;
  input: BatchInput; manifest: BatchManifest; state: 'pending' | 'committed' | 'failed'; receipt: any; failure: string | null;
  attempt: string; lease_owner: string | null; lease_until: Date | null };
const decode = (value: any) => typeof value === 'string' ? JSON.parse(value) : value;
const batchRow = (row: any): MediaBatch | undefined => row ? { ...row, input: decode(row.input), manifest: decode(row.manifest), receipt: decode(row.receipt) } : undefined;
export function normalizeBatchInput(value: any): BatchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['fileIds', 'folderIds'].includes(key))) {
    throw new RecoveryError(400, 'INVALID_MEDIA_BATCH', 'Select the files and folders to remove');
  }
  const ids = (values: any) => {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new RecoveryError(400, 'INVALID_MEDIA_BATCH', 'Media identifiers must be positive integers');
    return [...new Set<number>(values)].sort((a, b) => a - b);
  };
  return { fileIds: ids(value.fileIds), folderIds: ids(value.folderIds) };
}
export function batchChildKey(parent: string, id: number) {
  const hex = sha256(`${parent}:delete:${id}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const inPaths = (field: string, paths: string[]) => ({ $or: paths.flatMap((path) => [{ [field]: { $eq: path } }, { [field]: { $startsWith: `${path}/` } }]) });
const folderSnapshot = (folder: any) => JSON.parse(JSON.stringify(Object.fromEntries(
  ['id', 'name', 'path', 'pathId', 'createdAt', 'updatedAt'].map((key) => [key, folder[key]]))));
export function batchPermissionOperation(batch: MediaBatch): Operation {
  return { ...batch, kind: 'delete', target_id: null, manifest: { files: batch.manifest.files.map(({ file }) => ({ values: {}, permissionSubject: file })), objects: [], obsolete: [] } } as unknown as Operation;
}

/** A batch owns a frozen scope and receipts; each file keeps its own SQL transaction. */
export class MediaBatches {
  constructor(private readonly strapi: any, private readonly journal: MediaJournal, private readonly storage: RecoveryStorage,
    private readonly authorize: (batch: MediaBatch) => Promise<void>,
    private readonly gate: (point: FaultPoint, context: FaultContext) => Promise<void>) {}
  get db() { return this.journal.db; }
  async get(key: string) { return batchRow(await this.db(MEDIA_BATCH_TABLE).where({ key }).first()); }
  async getOwned(key: string, actor: string) {
    const batch = await this.get(key);
    if (!batch || batch.actor !== actor) throw new RecoveryError(404, 'OPERATION_NOT_FOUND', 'Media operation not found');
    return batch;
  }
  private async snapshot(key: string, input: BatchInput): Promise<BatchManifest> {
    const roots = input.folderIds.length ? await this.strapi.db.query(FOLDER_UID).findMany({ where: { id: { $in: input.folderIds } } }) : [];
    if (roots.length !== input.folderIds.length) throw new RecoveryError(404, 'FOLDER_NOT_FOUND', 'A selected folder no longer exists');
    const paths = roots.map((folder: any) => folder.path);
    const folders = paths.length ? await this.strapi.db.query(FOLDER_UID).findMany({ where: inPaths('path', paths) }) : [];
    if (roots.some((root: any) => {
      const included = folders.find((folder: any) => folder.id === root.id);
      return !included || stableJSON(folderSnapshot(included)) !== stableJSON(folderSnapshot(root));
    })) throw new RecoveryError(409, 'FOLDER_CHANGED', 'A selected folder moved while its deletion was being prepared');
    const predicates: any[] = [];
    if (input.fileIds.length) predicates.push({ id: { $in: input.fileIds } });
    if (paths.length) predicates.push(inPaths('folderPath', paths), { folder: { id: { $in: folders.map((folder: any) => folder.id) } } });
    const files = predicates.length ? await this.strapi.db.query(FILE_UID).findMany({ where: { $or: predicates },
      populate: { createdBy: { select: ['id'] }, updatedBy: { select: ['id'] }, folder: { select: ['id'] } } }) : [];
    if (input.fileIds.some((id) => !files.some((file: any) => file.id === id))) throw new RecoveryError(404, 'MEDIA_NOT_FOUND', 'A selected media no longer exists');
    return { files: files.sort((a: any, b: any) => a.id - b.id).map((file: any) => ({ key: batchChildKey(key, file.id), version: mediaVersion(file), file: mediaPermissionSubject(file) })),
      folders: folders.sort((a: any, b: any) => a.id - b.id).map(folderSnapshot), rootFolderIds: input.folderIds };
  }
  async begin(key: string, actor: Actor, rawInput: any) {
    const input = normalizeBatchInput(rawInput); const requestHash = sha256(stableJSON(input));
    return this.strapi.db.transaction(async ({ trx }) => {
      await trx.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
      if (await trx(MEDIA_OPERATION_TABLE).where({ key }).first()) throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key belongs to a different request');
      const previous = batchRow(await trx(MEDIA_BATCH_TABLE).where({ key }).forUpdate().first());
      if (previous) {
        if (previous.actor !== actor.id || previous.request_hash !== requestHash) throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key belongs to a different request');
        await this.authorize(previous);
        return { batch: previous, acquired: false };
      }
      const manifest = await this.snapshot(key, input);
      const draft = { key, actor: actor.id, admin_user_id: actor.adminUserId ?? null, request_hash: requestHash, input, manifest,
        state: 'pending', failure: null, receipt: null, attempt: randomUUID(), lease_owner: randomUUID() } as MediaBatch;
      await this.authorize(draft);
      const [row] = await trx(MEDIA_BATCH_TABLE).insert({ ...draft, input: JSON.stringify(input), manifest: JSON.stringify(manifest), lease_until: this.journal.lease(trx) }).returning('*');
      return { batch: batchRow(row)!, acquired: true };
    });
  }
  async assertLease(batch: MediaBatch, trx = this.db) {
    const row = await trx(MEDIA_BATCH_TABLE).where({ key: batch.key, attempt: batch.attempt, lease_owner: batch.lease_owner, state: 'pending' })
      .where('lease_until', '>', trx.raw('clock_timestamp()')).first();
    if (!row) throw new RecoveryError(409, 'OPERATION_LEASE_LOST', 'This media batch is being recovered');
    return batchRow(row)!;
  }
  async heartbeat(batch: MediaBatch) {
    const count = await this.db(MEDIA_BATCH_TABLE).where({ key: batch.key, attempt: batch.attempt, lease_owner: batch.lease_owner, state: 'pending' })
      .where('lease_until', '>', this.db.raw('clock_timestamp()')).update({ lease_until: this.journal.lease(), updated_at: this.db.fn.now() });
    if (!count) throw new RecoveryError(409, 'OPERATION_LEASE_LOST', 'This media batch is being recovered');
  }
  async claimExpired(key?: string) {
    return this.db.transaction(async (trx) => {
      const query = trx(MEDIA_BATCH_TABLE).where({ state: 'pending' }).where('lease_until', '<=', trx.raw('clock_timestamp()'));
      if (key) query.where({ key });
      const row = await query.orderBy('updated_at').forUpdate().skipLocked().first();
      if (!row) return undefined;
      const [claimed] = await trx(MEDIA_BATCH_TABLE).where({ key: row.key }).update({ lease_owner: randomUUID(), lease_until: this.journal.lease(trx), updated_at: trx.fn.now() }).returning('*');
      return batchRow(claimed)!;
    });
  }
  async receipt(batch: MediaBatch) {
    const keys = batch.manifest.files.map((file) => file.key);
    const rows = keys.length ? await this.db(MEDIA_OPERATION_TABLE).whereIn('key', keys).select('key', 'state', 'failure') : [];
    const children = batch.manifest.files.map(({ key, file }) => {
      const row = rows.find((item: any) => item.key === key);
      return { key, id: file.id, status: row?.state === 'committed' ? 'committed' : row?.state === 'failed' ? 'failed' : 'pending', ...(row?.failure ? { error: row.failure } : {}) };
    });
    return { key: batch.key, kind: 'bulk-delete', status: batch.state, retryable: false, error: batch.failure || undefined,
      result: batch.state === 'committed' ? batch.receipt : undefined,
      progress: { total: children.length, committed: children.filter((child) => child.status === 'committed').length,
        failed: children.filter((child) => child.status === 'failed').length, children } };
  }
  private async fail(batch: MediaBatch, failure: string) {
    await this.db.transaction(async (trx) => {
      await trx(MEDIA_BATCH_TABLE).where({ key: batch.key }).forUpdate().first(); await this.assertLease(batch, trx);
      await trx(MEDIA_BATCH_TABLE).where({ key: batch.key }).update({ state: 'failed', failure, lease_owner: null, lease_until: null, updated_at: trx.fn.now() });
    });
  }
  private async child(batch: MediaBatch, plan: BatchFile) {
    await this.authorize(batch);
    const { operation, acquired } = await this.journal.begin({ key: plan.key, actor: { id: batch.actor, adminUserId: batch.admin_user_id ?? undefined },
      kind: 'delete', requestHash: await requestFingerprint('delete', plan.file.id, {}, []), targetId: plan.file.id, targetVersion: plan.version });
    if (!acquired) {
      if (operation.state === 'committed') return operation.receipt;
      if (operation.state === 'failed') throw new RecoveryError(409, operation.failure || 'OPERATION_FAILED', 'A media in the batch could not be removed');
      throw new RecoveryError(409, 'OPERATION_PENDING', 'A media in this batch is still being recovered');
    }
    try {
      await this.journal.prepare(operation, { files: [{ values: {}, targetId: plan.file.id, previousHash: plan.file.hash,
        previousVersion: plan.version, permissionSubject: plan.file }], objects: [],
        obsolete: existingObjects(plan.file, this.storage, this.strapi.config.get('plugin::upload').provider) });
      return await this.journal.commit(operation);
    } catch (error: any) {
      if (error instanceof RecoveryError && ['MEDIA_CHANGED', 'AUTHORIZATION_REVOKED'].includes(error.code)) {
        try { await this.journal.interrupt(operation, true, error.code); } catch {}
      }
      throw error;
    }
  }
  private async finish(batch: MediaBatch, files: any[]) {
    return this.strapi.db.transaction(async ({ trx }) => {
      // No S3 or child work runs in this bounded metadata-only transaction.
      await trx.raw("SET LOCAL lock_timeout = '1500ms'"); await trx.raw("SET LOCAL statement_timeout = '3000ms'");
      await trx(MEDIA_BATCH_TABLE).where({ key: batch.key }).forUpdate().first(); await this.assertLease(batch, trx);
      await this.authorize(batch);
      if (batch.manifest.folders.length) {
        const fileMeta = this.strapi.db.metadata.get(FILE_UID); const folderMeta = this.strapi.db.metadata.get(FOLDER_UID);
        const tables = [...new Set<string>([fileMeta.tableName, folderMeta.tableName,
          fileMeta.attributes.folder?.joinTable?.name, folderMeta.attributes.parent?.joinTable?.name].filter(Boolean))].sort();
        await trx.raw(`LOCK TABLE ${tables.map(() => '??').join(', ')} IN SHARE ROW EXCLUSIVE MODE`, tables);
        const roots = batch.manifest.folders.filter((folder) => batch.manifest.rootFolderIds.includes(folder.id));
        const paths = roots.map((folder) => folder.path);
        const current = await this.strapi.db.query(FOLDER_UID).findMany({ where: { $or: [inPaths('path', paths), { id: { $in: batch.manifest.folders.map((folder) => folder.id) } }] } });
        if (stableJSON(current.sort((a: any, b: any) => a.id - b.id).map(folderSnapshot)) !== stableJSON(batch.manifest.folders)
          || await this.strapi.db.query(FILE_UID).count({ where: { $or: [inPaths('folderPath', paths), { folder: { id: { $in: batch.manifest.folders.map((folder) => folder.id) } } }] } })) {
          throw new RecoveryError(409, 'FOLDER_CHANGED', 'A selected folder changed; its new contents were preserved');
        }
        await this.strapi.db.query(FOLDER_UID).deleteMany({ where: { id: { $in: batch.manifest.folders.map((folder) => folder.id) } } });
      }
      await this.assertLease(batch, trx);
      const receipt = { files, folders: batch.manifest.folders.filter((folder) => batch.manifest.rootFolderIds.includes(folder.id)) };
      await trx(MEDIA_BATCH_TABLE).where({ key: batch.key }).update({ state: 'committed', receipt: JSON.stringify(receipt),
        lease_owner: null, lease_until: null, updated_at: trx.fn.now() });
      return receipt;
    });
  }
  async process(batch: MediaBatch) {
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => { if (!heartbeat) {
      heartbeat = this.heartbeat(batch).catch(() => {}).finally(() => { heartbeat = undefined; });
    } }, RECONCILE_MS); timer.unref();
    try {
      const files = [];
      for (const [index, plan] of batch.manifest.files.entries()) {
        await this.assertLease(batch); files.push(await this.child(batch, plan));
        await this.gate('after-batch-child', { key: batch.key, attempt: batch.attempt, objectIndex: index });
      }
      return await this.finish(batch, files);
    } catch (error: any) {
      if (error instanceof RecoveryError && ['MEDIA_CHANGED', 'FOLDER_CHANGED', 'AUTHORIZATION_REVOKED', 'IDEMPOTENCY_CONFLICT', 'OPERATION_FAILED'].includes(error.code)) {
        try { await this.fail(batch, error.code); } catch {}
        throw error;
      }
      try { await this.db(MEDIA_BATCH_TABLE).where({ key: batch.key, lease_owner: batch.lease_owner, state: 'pending' }).update({ lease_until: this.db.fn.now() }); } catch {}
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError(503, 'OPERATION_PENDING', 'Media batch recovery is pending; keep its operation key');
    } finally { clearInterval(timer); await heartbeat; }
  }
}
