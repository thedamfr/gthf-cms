import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import release from '../../src/middlewares/release';

/** Uses only the already-guarded Job's PostgreSQL pool; never changes server settings. */
export async function checkRelease(application: any, checks: string[]) {
  const db = application.db.connection;
  const probe = async (handler: any) => {
    const ctx = { path: '/api/release', method: 'GET', status: 0, set() {}, body: undefined };
    const started = Date.now(); await handler(ctx, async () => assert.fail('Readiness route must be handled'));
    return { status: ctx.status, elapsedMs: Date.now() - started };
  };
  const waitFor = async (check: () => Promise<boolean>, limit: number) => {
    const end = Date.now() + limit;
    do { if (await check()) return; await sleep(25); } while (Date.now() < end);
    assert.fail('The isolated PostgreSQL readiness condition exceeded its deadline');
  };
  const max = db.client.pool.max;
  assert.ok(Number.isInteger(max) && max >= 2 && max <= 10, 'The isolated readiness fixture requires a small pool with at least two connections');
  const held = [];
  let reads = 0;
  const handler = release({ timeoutMs: 150 }, { strapi: { db: { connection: { client: db.client, raw: (...args: any[]) => { reads++; return db.raw(...args); } } } } } as any);
  try {
    for (let index = 0; index < max; index++) held.push(await db.client.acquireConnection());
    const first = probe(handler); const second = probe(handler);
    await waitFor(async () => db.client.pool.numPendingAcquires() === 1, 500);
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((result) => result.status), [503, 503]);
    assert.ok(responses.every((result) => result.elapsedMs < 1500)); assert.equal(reads, 1);
    await db.client.releaseConnection(held.pop());
    await waitFor(async () => db.client.pool.numPendingAcquires() === 0 && (await probe(handler)).status === 200, 2000);
    process.stdout.write(JSON.stringify({ readinessProof: 'pool-saturation', connectionsHeld: max, pendingAcquires: 1,
      unavailableElapsedMs: responses.map((result) => result.elapsedMs), recovered: true }) + '\n');
  } finally { for (const connection of held) await db.client.releaseConnection(connection); }
  checks.push('real pool saturation yields bounded 503 responses with one waiter and recovers to 200 after a connection returns');

  const sql = `select pg_sleep(10) /* gthf_recovery_release_${randomUUID().replace(/-/g, '')} */`;
  let queryFinishedAt = 0;
  let slow = true;
  const cancellationHandler = release({ timeoutMs: 500 }, { strapi: { db: { connection: { client: db.client,
    raw: () => {
      if (!slow) return db.raw('select 1');
      const query = db.raw(sql);
      query.once('query-error', () => { queryFinishedAt = Date.now(); });
      return query;
    },
  } } } } as any);
  const active = async () => {
    const result = await db.raw("select count(*) AS count from pg_stat_activity where pid <> pg_backend_pid() AND datname=current_database() AND state='active' AND query=?", [sql]);
    return Number(result.rows[0].count);
  };
  const started = Date.now(); const pending = probe(cancellationHandler);
  await waitFor(async () => await active() === 1, 400);
  const result = await pending;
  assert.equal(result.status, 503); assert.ok(result.elapsedMs < 1500);
  await waitFor(async () => queryFinishedAt > 0 && await active() === 0, 2000);
  const cancellationElapsedMs = Date.now() - started;
  assert.ok(cancellationElapsedMs < 2500, 'The actual sleep must end through cancellation, not its ten-second completion');
  slow = false;
  await waitFor(async () => (await probe(cancellationHandler)).status === 200, 2000);
  assert.equal(await active(), 0, 'No slow probe is left running before the next test');
  process.stdout.write(JSON.stringify({ readinessProof: 'postgresql-cancellation', runningSleepObserved: true,
    unavailableElapsedMs: result.elapsedMs, cancellationElapsedMs, slowQueriesRemaining: 0, recovered: true }) + '\n');
  checks.push('a real pg_sleep is observed, its readiness request returns bounded 503, PostgreSQL cancellation completes and the next probe returns 200');
}
