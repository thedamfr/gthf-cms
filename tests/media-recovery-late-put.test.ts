import assert from 'node:assert/strict';
import test from 'node:test';
import { S3Client, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createRecoveryStorage, sha256 } from '../src/infrastructure/recovery/storage';
import { MediaRecovery } from '../src/infrastructure/recovery/engine';
import { MEDIA_CLEANUP_TABLE, MEDIA_OPERATION_TABLE } from '../src/infrastructure/recovery/types';

// Only the persistence plumbing and remote completion order are simulated. The
// engine, journal.interrupt/finishCleanup and storage ownership checks are real.
function persistence() {
  let clock = 1_000;
  const tables: Record<string, any[]> = { [MEDIA_OPERATION_TABLE]: [], [MEDIA_CLEANUP_TABLE]: [] };
  const db: any = (name: string) => {
    const predicates: ((row: any) => boolean)[] = [];
    const selected = () => tables[name].filter((row) => predicates.every((match) => match(row)));
    const query: any = {
      where(field: any, operator?: string, expected?: any) {
        predicates.push(typeof field === 'object'
          ? (row) => Object.entries(field).every(([key, value]) => row[key] === value)
          : (row) => operator === '>' ? row[field] > expected : row[field] === expected);
        return query;
      },
      forUpdate() { return query; },
      async first() { const row = selected()[0]; return row && { ...row }; },
      async insert(value: any) {
        tables[name].push({ state: 'pending', recurring: false, lease_owner: null, lease_until: null, ...value });
      },
      async update(values: any) { const rows = selected(); rows.forEach((row) => Object.assign(row, values)); return rows.length; },
      async delete() { const rows = selected(); tables[name] = tables[name].filter((row) => !rows.includes(row)); return rows.length; },
    };
    return query;
  };
  db.raw = (sql: string, bindings: number[] = []) => clock + (sql.includes('interval') ? bindings[0] : 0);
  db.fn = { now: () => clock };
  db.transaction = async (work: (trx: any) => any) => work(db);
  return { db, tables, now: () => clock, advance: (milliseconds: number) => { clock += milliseconds; } };
}

test('a late PUT is cleaned on a later sweep while retry bytes and a foreign collision survive', async () => {
  const originalSend = S3Client.prototype.send;
  const bytes = Buffer.from('synthetic delayed server write');
  const old = { key: 'attempt-a/immutable.txt', sha256: sha256(bytes), bytes: bytes.length };
  const collision = { key: 'attempt-a/derivative.txt', sha256: sha256('planned derivative'), bytes: 18 };
  const retry = { key: 'attempt-b/immutable.txt', sha256: sha256('retry'), bytes: 5 };
  const foreign = { key: collision.key, sha256: sha256('foreign bytes'), bytes: 13 };
  const objects = new Map<string, typeof old>();
  const deleted: string[] = [];
  let finishServerPut: (() => void) | undefined;
  S3Client.prototype.send = (async (command: any) => {
    if (command instanceof PutObjectCommand) {
      finishServerPut = () => { objects.set(old.key, old); };
      throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    }
    if (command instanceof DeleteObjectCommand) {
      deleted.push(command.input.Key); objects.delete(command.input.Key); return {};
    }
    assert.ok(command instanceof HeadObjectCommand);
    const found = objects.get(command.input.Key);
    if (!found) throw Object.assign(new Error('absent'), { $metadata: { httpStatusCode: 404 } });
    return { Metadata: { gthfsha256: found.sha256 }, ContentLength: found.bytes };
  }) as any;
  const storage = createRecoveryStorage({ provider: 'aws-s3', providerOptions: { s3Options: {
    region: 'us-east-1', params: { Bucket: 'synthetic-no-network' },
  } } });
  const state = persistence();
  const operation: any = { key: '22222222-2222-4222-8222-222222222222',
    attempt: '33333333-3333-4333-8333-333333333333', state: 'prepared',
    lease_owner: '44444444-4444-4444-8444-444444444444', lease_until: state.now() + 90_000,
    manifest: { files: [], objects: [old, collision], obsolete: [] } };
  state.tables[MEDIA_OPERATION_TABLE].push(operation);
  let expired = true; let claimed = 0;
  const engine = new MediaRecovery({ db: { connection: state.db }, log: { warn(message: string) { throw new Error(message); } } }, storage);
  engine.batches.claimExpired = async () => undefined;
  engine.journal.claimExpired = async () => { if (!expired) return undefined; expired = false; return operation; };
  engine.journal.claimCleanup = async (_key, recurring) => {
    const row = state.tables[MEDIA_CLEANUP_TABLE].find((entry) => entry.recurring === recurring && entry.not_before <= state.now()
      && (!entry.lease_until || entry.lease_until <= state.now()));
    if (!row) return undefined;
    claimed++;
    Object.assign(row, { lease_owner: 'cleanup-' + claimed, lease_until: state.now() + 90_000 });
    return { ...row, objects: JSON.parse(row.objects) };
  };
  try {
    await assert.rejects(storage.put(old, bytes), /timed out/);
    await engine.reconcile();
    assert.equal(operation.state, 'interrupted');
    const intention = state.tables[MEDIA_CLEANUP_TABLE][0];
    assert.ok(intention, 'An absent object must not erase the cleanup intention for an interrupted attempt');
    assert.equal(intention.recurring, true);
    assert.equal(intention.state, 'pending');
    assert.equal(intention.lease_owner, null);
    assert.equal(intention.not_before - state.now(), 60_000);
    assert.equal(claimed, 1, 'One recurring intention is visited only once per cycle');
    assert.equal(objects.size, 0);

    // A successful new attempt replaces the operation manifest. The previous
    // attempt must remain independently watched through its own cleanup row.
    operation.attempt = '55555555-5555-4555-8555-555555555555';
    operation.state = 'committed'; operation.manifest = { files: [], objects: [retry], obsolete: [] };
    objects.set(retry.key, retry); objects.set(foreign.key, foreign);
    finishServerPut!();
    await engine.reconcile();
    assert.equal(objects.has(old.key), true, 'The next sweep must respect its durable due date');
    state.advance(60_000);
    await engine.reconcile();
    assert.equal(objects.has(old.key), false);
    assert.deepEqual(objects.get(retry.key), retry);
    assert.deepEqual(objects.get(foreign.key), foreign);
    assert.deepEqual(deleted, [old.key]);
    assert.equal(state.tables[MEDIA_CLEANUP_TABLE].length, 1);
    assert.equal(intention.attempt, '33333333-3333-4333-8333-333333333333');
    assert.equal(intention.not_before - state.now(), 60_000);

    // There is no finite server-completion bound: another later appearance must
    // also be removed, without deleting the foreign object or the retry keys.
    finishServerPut!(); state.advance(60_000); await engine.reconcile();
    assert.equal(objects.has(old.key), false);
    assert.deepEqual([...objects.keys()].sort(), [retry.key, foreign.key].sort());
    assert.equal(state.tables[MEDIA_CLEANUP_TABLE].length, 1);
  } finally { await engine.stop(); S3Client.prototype.send = originalSend; }
});

test('cleanup of previously committed objects remains finalizable', async () => {
  const state = persistence();
  const engine = new MediaRecovery({ db: { connection: state.db } }, {} as any);
  state.tables[MEDIA_CLEANUP_TABLE].push({ id: 'committed-cleanup', recurring: false,
    lease_owner: 'owner', lease_until: state.now() + 90_000 });
  await engine.journal.finishCleanup('committed-cleanup', 'owner');
  assert.equal(state.tables[MEDIA_CLEANUP_TABLE].length, 0);
});

test('an expired cleanup lease can neither remove nor reschedule a recurring intention', async () => {
  const state = persistence();
  const engine = new MediaRecovery({ db: { connection: state.db } }, {} as any);
  const row = { id: 'recurring-cleanup', recurring: true, not_before: state.now(),
    lease_owner: 'owner', lease_until: state.now() - 1 };
  state.tables[MEDIA_CLEANUP_TABLE].push(row);
  const before = { ...row };
  await assert.rejects(engine.journal.finishCleanup(row.id, 'owner'), (error: any) => error.code === 'CLEANUP_LEASE_LOST');
  assert.deepEqual(row, before);
  assert.equal(state.tables[MEDIA_CLEANUP_TABLE].length, 1);
});


test('a cleanup heartbeat extends a live lease but cannot revive expiry or another owner', async () => {
  const state = persistence(); const engine = new MediaRecovery({ db: { connection: state.db } }, {} as any);
  const row = { id: 'long-cleanup', state: 'pending', lease_owner: 'owner', lease_until: state.now() + 90_000 };
  state.tables[MEDIA_CLEANUP_TABLE].push(row);
  state.advance(80_000); await engine.journal.heartbeatCleanup(row.id, 'owner');
  assert.equal(row.lease_until, state.now() + 90_000);
  await engine.journal.assertCleanupLease(row.id, 'owner');
  await assert.rejects(engine.journal.heartbeatCleanup(row.id, 'other'), (e: any) => e.code === 'CLEANUP_LEASE_LOST');
  state.advance(90_001);
  await assert.rejects(engine.journal.assertCleanupLease(row.id, 'owner'), (e: any) => e.code === 'CLEANUP_LEASE_LOST');
  await assert.rejects(engine.journal.heartbeatCleanup(row.id, 'owner'), (e: any) => e.code === 'CLEANUP_LEASE_LOST');
});

test('finite cleanup and recurring tombstones retain separate capacity under backlog', async () => {
  const claimed = { finite: 0, recurring: 0 }; const completed: string[] = [];
  const engine = new MediaRecovery({ db: { connection: {} }, log: { warn() {} } }, { remove: async () => {} } as any);
  engine.batches.claimExpired = async () => undefined; engine.journal.claimExpired = async () => undefined;
  engine.journal.claimCleanup = async (_key, recurring) => {
    const kind = recurring ? 'recurring' : 'finite'; claimed[kind]++;
    return { id: kind + claimed[kind], recurring, lease_owner: 'owner', objects: [{ key: 'immutable' }] };
  };
  engine.journal.assertCleanupLease = async () => {}; engine.journal.heartbeatCleanup = async () => {};
  engine.journal.finishCleanup = async (id) => { completed.push(id); };
  await engine.reconcile();
  assert.deepEqual(claimed, { finite: 8, recurring: 2 });
  assert.equal(completed.filter((id) => id.startsWith('finite')).length, 8);
  assert.equal(completed.filter((id) => id.startsWith('recurring')).length, 2);
});

test('cleanup spanning more than ninety seconds renews its lease and finalizes once', async () => {
  const state = persistence(); let tick: () => void; const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  (globalThis as any).setInterval = (fn: () => void) => { tick = fn; return { unref() {} }; };
  (globalThis as any).clearInterval = () => {};
  const row = { id: 'slow-row', state: 'pending', recurring: false, lease_owner: 'owner', lease_until: state.now() + 90_000,
    objects: [{ key: 'one' }, { key: 'two' }, { key: 'three' }] };
  state.tables[MEDIA_CLEANUP_TABLE].push(row);
  let claimed = false; let removals = 0; let renewals = 0;
  const engine = new MediaRecovery({ db: { connection: state.db }, log: { warn(message: string) { assert.fail(message); } } }, {
    remove: async (_object: any, assertLease: () => Promise<void>) => {
      for (let request = 0; request < 3; request++) {
        await assertLease(); state.advance(20_000); tick!(); await new Promise((resolve) => setImmediate(resolve));
      }
      removals++;
    }, close() {},
  } as any);
  engine.batches.claimExpired = async () => undefined; engine.journal.claimExpired = async () => undefined;
  engine.journal.claimCleanup = async (_key, recurring) => { if (claimed || recurring) return undefined; claimed = true; return row; };
  const heartbeat = engine.journal.heartbeatCleanup.bind(engine.journal);
  engine.journal.heartbeatCleanup = async (...args) => { renewals++; return heartbeat(...args); };
  try {
    await engine.reconcile(); assert.equal(removals, 3); assert.equal(renewals, 9);
    assert.ok(state.now() > 90_000); assert.equal(state.tables[MEDIA_CLEANUP_TABLE].length, 0);
  } finally { await engine.stop(); globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; }
});
