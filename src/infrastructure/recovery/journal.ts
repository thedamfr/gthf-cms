import { mediaVersion } from './prepare';
import { randomUUID } from 'node:crypto';
import { Actor, FILE_UID, LEASE_MS, INTERRUPTED_SWEEP_MS, Manifest, MEDIA_CLEANUP_TABLE, MEDIA_OPERATION_TABLE, Operation, OperationKind, RecoveryError, StoredObject } from './types';

// Strapi disables pg's JSONB parser globally. These private Knex tables bypass
// Strapi's model-field decoder, so decode only their JSON columns at read time.
function json(value: any) { return typeof value === 'string' ? JSON.parse(value) : value; }
function operationRow(row: any): Operation | undefined {
  return row ? { ...row, manifest: json(row.manifest), receipt: json(row.receipt) } : undefined;
}

/** Private additive tables: never registered as a content type or exposed by REST. */
export class MediaJournal {
  constructor(private readonly strapi: any, private readonly authorize: (operation: Operation) => Promise<void> = async () => {}) {}
  get db() { return this.strapi.db.connection; }
  async initialize() {
    await this.db.transaction(async (trx) => {
      await trx.raw('select pg_advisory_xact_lock(?)', [0x47544852]);
      if (!await trx.schema.hasTable(MEDIA_OPERATION_TABLE)) {
        await trx.schema.createTable(MEDIA_OPERATION_TABLE, (table) => {
          table.uuid('key').primary(); table.string('actor', 160).notNullable();
          table.integer('admin_user_id').nullable(); table.string('kind', 16).notNullable();
          table.string('request_hash', 64).notNullable(); table.integer('target_id').nullable();
          table.uuid('attempt').notNullable(); table.string('state', 20).notNullable();
          table.jsonb('manifest').nullable(); table.jsonb('receipt').nullable(); table.string('failure', 64).nullable();
          table.uuid('lease_owner').nullable(); table.timestamp('lease_until', { useTz: true }).nullable();
          table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(trx.fn.now());
          table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(trx.fn.now());
          table.index(['state', 'lease_until']); table.index(['actor', 'created_at']);
        });
      }
      if (!await trx.schema.hasColumn(MEDIA_OPERATION_TABLE, 'target_version')) {
        await trx.schema.alterTable(MEDIA_OPERATION_TABLE, (table) => table.string('target_version', 64).nullable());
      }
      if (!await trx.schema.hasTable(MEDIA_CLEANUP_TABLE)) {
        await trx.schema.createTable(MEDIA_CLEANUP_TABLE, (table) => {
          table.uuid('id').primary(); table.uuid('operation_key').notNullable();
          table.uuid('attempt').notNullable(); table.jsonb('objects').notNullable();
          table.string('state', 16).notNullable().defaultTo('pending');
          table.timestamp('not_before', { useTz: true }).notNullable().defaultTo(trx.fn.now());
          table.uuid('lease_owner').nullable(); table.timestamp('lease_until', { useTz: true }).nullable();
          table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(trx.fn.now());
          table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(trx.fn.now());
          table.index(['state', 'not_before', 'lease_until']);
        });
      }
      if (!await trx.schema.hasColumn(MEDIA_CLEANUP_TABLE, 'recurring')) {
        await trx.schema.alterTable(MEDIA_CLEANUP_TABLE, (table) => table.boolean('recurring').notNullable().defaultTo(false));
      }
    });
  }
  lease(trx = this.db) { return trx.raw("clock_timestamp() + (? * interval '1 millisecond')", [LEASE_MS]); }
  async get(key: string): Promise<Operation | undefined> { return operationRow(await this.db(MEDIA_OPERATION_TABLE).where({ key }).first()); }
  async getOwned(key: string, actor: string) {
    const row = await this.get(key);
    if (!row || row.actor !== actor) throw new RecoveryError(404, 'OPERATION_NOT_FOUND', 'Media operation not found');
    return row;
  }
  async begin(input: { key: string; actor: Actor; kind: OperationKind; requestHash: string; targetId?: number; targetVersion?: string }): Promise<{ operation: Operation; acquired: boolean }> {
    return this.db.transaction(async (trx) => {
      const inserted = await trx(MEDIA_OPERATION_TABLE).insert({ key: input.key, actor: input.actor.id,
        admin_user_id: input.actor.adminUserId ?? null, kind: input.kind, request_hash: input.requestHash,
        target_id: input.targetId ?? null, target_version: input.targetVersion ?? null, attempt: randomUUID(), state: 'preparing',
        lease_owner: randomUUID(), lease_until: this.lease(trx) }).onConflict('key').ignore().returning('key');
      const row = operationRow(await trx(MEDIA_OPERATION_TABLE).where({ key: input.key }).forUpdate().first())!;
      if (row.actor !== input.actor.id) throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key is unavailable');
      if (row.kind !== input.kind || row.request_hash !== input.requestHash || row.target_id !== (input.targetId ?? null)) {
        throw new RecoveryError(409, 'IDEMPOTENCY_CONFLICT', 'This operation key belongs to a different request');
      }
      if (row.state === 'committed' || row.state === 'failed') return { operation: row, acquired: false };
      if (inserted.length) return { operation: row, acquired: true };
      if (row.state !== 'interrupted') return { operation: row, acquired: false };
      if (row.kind !== 'upload' && (!row.target_version || row.target_version !== input.targetVersion)) {
        const [failed] = await trx(MEDIA_OPERATION_TABLE).where({ key: row.key }).update({ state: 'failed',
          failure: 'MEDIA_CHANGED', lease_owner: null, lease_until: null, updated_at: trx.fn.now() }).returning('*');
        return { operation: operationRow(failed)!, acquired: false };
      }
      const [next] = await trx(MEDIA_OPERATION_TABLE).where({ key: row.key }).update({
        attempt: randomUUID(), state: 'preparing', manifest: null, failure: null,
        lease_owner: randomUUID(), lease_until: this.lease(trx), updated_at: trx.fn.now(),
      }).returning('*');
      return { operation: operationRow(next)!, acquired: true };
    });
  }
  async assertLease(operation: Pick<Operation, 'key' | 'attempt' | 'lease_owner'>, trx = this.db) {
    const row = await trx(MEDIA_OPERATION_TABLE).where({ key: operation.key, attempt: operation.attempt, lease_owner: operation.lease_owner })
      .where('lease_until', '>', trx.raw('clock_timestamp()')).first();
    if (!row || !['preparing', 'prepared'].includes(row.state)) throw new RecoveryError(409, 'OPERATION_LEASE_LOST', 'This media operation is being recovered');
    return operationRow(row)!;
  }
  async heartbeat(operation: Pick<Operation, 'key' | 'attempt' | 'lease_owner'>) {
    const count = await this.db(MEDIA_OPERATION_TABLE).where({ key: operation.key, attempt: operation.attempt, lease_owner: operation.lease_owner })
      .whereIn('state', ['preparing', 'prepared']).where('lease_until', '>', this.db.raw('clock_timestamp()'))
      .update({ lease_until: this.lease(), updated_at: this.db.fn.now() });
    if (!count) throw new RecoveryError(409, 'OPERATION_LEASE_LOST', 'This media operation is being recovered');
  }
  async prepare(operation: Operation, manifest: Manifest) {
    await this.db.transaction(async (trx) => {
      await trx(MEDIA_OPERATION_TABLE).where({ key: operation.key }).forUpdate().first();
      await this.assertLease(operation, trx);
      await trx(MEDIA_OPERATION_TABLE).where({ key: operation.key }).update({ state: 'prepared', manifest: JSON.stringify(manifest), updated_at: trx.fn.now() });
    });
    operation.manifest = manifest; operation.state = 'prepared';
  }
  private async queueCleanup(trx: any, operation: Operation, objects: StoredObject[], delayMs = 0, recurring = false) {
    if (!objects.length) return;
    await trx(MEDIA_CLEANUP_TABLE).insert({ id: randomUUID(), operation_key: operation.key, attempt: operation.attempt,
      objects: JSON.stringify(objects), recurring, not_before: trx.raw("clock_timestamp() + (? * interval '1 millisecond')", [delayMs]) });
  }
  async interrupt(operation: Operation, permanent = false, reason = 'TRANSFER_INTERRUPTED') {
    await this.db.transaction(async (trx) => {
      await trx(MEDIA_OPERATION_TABLE).where({ key: operation.key }).forUpdate().first();
      const row = await this.assertLease(operation, trx);
      await this.queueCleanup(trx, row, row.manifest?.objects || [], 0, true);
      await trx(MEDIA_OPERATION_TABLE).where({ key: operation.key }).update({
        state: permanent ? 'failed' : 'interrupted', failure: reason, lease_owner: null, lease_until: null, updated_at: trx.fn.now(),
      });
    });
  }
  async commit(operation: Operation) {
    return this.strapi.db.transaction(async ({ trx }) => {
      await trx(MEDIA_OPERATION_TABLE).where({ key: operation.key }).forUpdate().first();
      const row = await this.assertLease(operation, trx);
      if (!row.manifest) throw new Error('Cannot commit an unprepared media operation');
      await this.authorize(row);
      await this.assertLease(operation, trx);
      const results = [];
      const fileTable = this.strapi.db.metadata.get(FILE_UID).tableName;
      for (const plan of row.manifest.files) {
        if (plan.targetId !== undefined) {
          await trx(fileTable).where({ id: plan.targetId }).forUpdate().first();
          const existing = await this.strapi.db.query(FILE_UID).findOne({ where: { id: plan.targetId } });
          if (!existing || existing.hash !== plan.previousHash
            || (plan.previousVersion && mediaVersion(existing) !== plan.previousVersion)
            || (plan.previousUpdatedAt && new Date(existing.updatedAt).toISOString() !== plan.previousUpdatedAt)) {
            throw new RecoveryError(409, 'MEDIA_CHANGED', 'The media changed while this operation was pending');
          }
        }
        const audit = row.admin_user_id ? { updatedBy: row.admin_user_id } : {};
        if (row.kind === 'delete') {
          results.push(await this.strapi.db.query(FILE_UID).delete({ where: { id: plan.targetId } }));
        } else if (row.kind === 'replace') {
          results.push(await this.strapi.db.query(FILE_UID).update({ where: { id: plan.targetId }, data: { ...plan.values, ...audit } }));
        } else {
          results.push(await this.strapi.db.query(FILE_UID).create({ data: { ...plan.values, ...audit, ...(row.admin_user_id ? { createdBy: row.admin_user_id } : {}) } }));
        }
      }
      const receipt = row.kind === 'upload' ? results : results[0];
      await this.queueCleanup(trx, row, row.manifest.obsolete, row.kind === 'replace' ? 600_000 : 0);
      await trx(MEDIA_OPERATION_TABLE).where({ key: row.key }).update({ state: 'committed', receipt: JSON.stringify(receipt),
        lease_owner: null, lease_until: null, updated_at: trx.fn.now() });
      return receipt;
    });
  }
  async claimExpired(key?: string): Promise<Operation | undefined> {
    return this.db.transaction(async (trx) => {
      const query = trx(MEDIA_OPERATION_TABLE).whereIn('state', ['preparing', 'prepared'])
        .where('lease_until', '<=', trx.fn.now());
      if (key) query.where({ key });
      const row = await query.orderBy('updated_at').forUpdate().skipLocked().first();
      if (!row) return undefined;
      const [claimed] = await trx(MEDIA_OPERATION_TABLE).where({ key: row.key }).update({ lease_owner: randomUUID(),
        lease_until: this.lease(trx), updated_at: trx.fn.now() }).returning('*');
      return operationRow(claimed);
    });
  }
  async claimCleanup() {
    return this.db.transaction(async (trx) => {
      const row = await trx(MEDIA_CLEANUP_TABLE).where({ state: 'pending' }).where('not_before', '<=', trx.fn.now())
        .andWhere((q) => q.whereNull('lease_until').orWhere('lease_until', '<=', trx.fn.now()))
        .orderBy('not_before').orderBy('created_at').forUpdate().skipLocked().first();
      if (!row) return undefined;
      const [claimed] = await trx(MEDIA_CLEANUP_TABLE).where({ id: row.id }).update({ lease_owner: randomUUID(),
        lease_until: this.lease(trx), updated_at: trx.fn.now() }).returning('*');
      return { ...claimed, objects: json(claimed.objects) };
    });
  }
  async finishCleanup(id: string, leaseOwner: string) {
    const claimed = () => this.db(MEDIA_CLEANUP_TABLE).where({ id, lease_owner: leaseOwner })
      .where('lease_until', '>', this.db.raw('clock_timestamp()'));
    // An aborted client cannot prove that the server will not finish an earlier
    // PUT later. Retain these immutable-key tombstones and inspect them again.
    const recurring = await claimed().where({ recurring: true }).update({
      not_before: this.db.raw("clock_timestamp() + (? * interval '1 millisecond')", [INTERRUPTED_SWEEP_MS]),
      lease_owner: null, lease_until: null, updated_at: this.db.fn.now(),
    });
    if (recurring) return;
    const count = await claimed().where({ recurring: false }).delete();
    if (!count) throw new RecoveryError(409, 'CLEANUP_LEASE_LOST', 'Cleanup will be resumed');
  }
}
