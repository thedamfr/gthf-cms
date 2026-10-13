import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStrapi } from '@strapi/strapi';
import { stopRecoveryForJournalQualification } from '../../src/extensions/upload/strapi-server';
import { MediaJournal } from '../../src/infrastructure/recovery/journal';
import { FILE_UID, MEDIA_CLEANUP_TABLE, MEDIA_OPERATION_TABLE } from '../../src/infrastructure/recovery/types';
import { mediaVersion } from '../../src/infrastructure/recovery/prepare';
import { sha256 } from '../../src/infrastructure/recovery/storage';

async function main() {
  const campaign = process.env.GTHF_RECOVERY_CAMPAIGN || '';
  assert.match(campaign, /^[a-f0-9-]{36}$/i);
  assert.equal(process.env.GTHF_RECOVERY_ISOLATED, 'true', 'Only the isolated qualification VM may run this check');
  assert.equal(process.env.DATABASE_NAME, `gthf_recovery_${campaign.replace(/-/g, '')}`);
  for (const name of ['DATABASE_URL', 'POSTGRESQL_ADDON_URI', 'POSTGRESQL_ADDON_HOST', 'POSTGRESQL_ADDON_DB']) {
    assert.equal(Boolean(process.env[name]), false, `${name} must not override the synthetic database`);
  }
  const application = await createStrapi({ appDir: process.cwd(), distDir: `${process.cwd()}/dist` }).load();
  // Its bootstrap starts a normal reconciler. Drain only this test process
  // before deliberately expiring leases; long-lived CMS pods must not run yet.
  await stopRecoveryForJournalQualification();
  const db = application.db.connection;
  const journal = new MediaJournal(application);
  const actor = { id: `qualification:${campaign}` };
  const keys: string[] = [];
  const hashes: string[] = [];
  const checks: string[] = [];
  try {
    const input = { key: randomUUID(), actor, kind: 'upload' as const, requestHash: sha256(randomUUID()) };
    keys.push(input.key);
    const first = await journal.begin(input);
    assert.equal(first.acquired, true);
    assert.equal((await new MediaJournal(application).begin(input)).acquired, false);
    await assert.rejects(journal.begin({ ...input, requestHash: sha256('different payload') }), (error: any) => error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(journal.getOwned(input.key, 'qualification:another-actor'), (error: any) => error.status === 404);
    checks.push('concurrent claim, immutable request fingerprint and actor separation');

    await db(MEDIA_OPERATION_TABLE).where({ key: input.key }).update({ lease_until: db.raw("clock_timestamp() - interval '1 second'") });
    const recovered = await journal.claimExpired(input.key);
    assert.ok(recovered, 'this isolated test must claim its expired operation');
    assert.notEqual(recovered.lease_owner, first.operation.lease_owner);
    await assert.rejects(journal.heartbeat(first.operation), (error: any) => error.code === 'OPERATION_LEASE_LOST');
    await assert.rejects(journal.assertLease(first.operation), (error: any) => error.code === 'OPERATION_LEASE_LOST');
    checks.push('a previous request is fenced when the same process recovers its expired lease');

    const hash = `gthf_journal_test_${randomUUID().replace(/-/g, '')}`;
    hashes.push(hash);
    const manifest = { files: [{ values: { name: 'isolated journal fixture', hash, ext: '.txt', mime: 'text/plain', size: 0.001,
      url: `https://example.invalid/${hash}.txt`, provider: 'aws-s3' } }], objects: [], obsolete: [] };
    await journal.prepare(recovered, manifest);
    const originalQuery = application.db.query.bind(application.db);
    (application.db as any).query = (uid: any) => {
      const query = originalQuery(uid);
      return uid === FILE_UID ? { ...query, create: async (params: any) => {
        await query.create(params); throw new Error('qualification failure after real file INSERT');
      } } : query;
    };
    try { await assert.rejects(journal.commit(recovered), /qualification failure/); }
    finally { (application.db as any).query = originalQuery; }
    assert.equal(await application.db.query(FILE_UID).count({ where: { hash } }), 0);
    assert.equal((await journal.get(input.key)).state, 'prepared');
    checks.push('a real file INSERT rolls back with the receipt when the transaction fails');

    const result = await journal.commit(recovered);
    const replay = await journal.begin(input);
    assert.equal(replay.acquired, false);
    assert.equal(replay.operation.state, 'committed');
    assert.deepEqual(replay.operation.receipt.map((file: any) => file.id), result.map((file: any) => file.id));
    assert.equal(await application.db.query(FILE_UID).count({ where: { hash } }), 1);
    checks.push('commit followed by a lost response reuses one durable receipt and one file');

    const next = { ...input, key: randomUUID() }; keys.push(next.key);
    const pending = (await journal.begin(next)).operation;
    await journal.interrupt(pending);
    const retry = (await journal.begin(next)).operation;
    assert.notEqual(retry.attempt, pending.attempt);
    assert.notEqual(retry.lease_owner, pending.lease_owner);
    await assert.rejects(journal.heartbeat(pending), (error: any) => error.code === 'OPERATION_LEASE_LOST');
    checks.push('an interrupted intent gets fresh immutable attempt keys and fences the old writer');

    const current = await application.db.query(FILE_UID).findOne({ where: { hash } });
    const replacement = { key: randomUUID(), actor, kind: 'replace' as const, requestHash: sha256(randomUUID()), targetId: current.id, targetVersion: mediaVersion(current) };
    keys.push(replacement.key);
    const operation = (await journal.begin(replacement)).operation;
    await journal.prepare(operation, { files: [{ values: { ...manifest.files[0].values, name: 'replacement' }, targetId: current.id,
      previousHash: current.hash, previousUpdatedAt: new Date(current.updatedAt).toISOString() }], objects: [], obsolete: [] });
    await application.db.query(FILE_UID).update({ where: { id: current.id }, data: { name: 'concurrent editorial change' } });
    await assert.rejects(journal.commit(operation), (error: any) => error.code === 'MEDIA_CHANGED');
    assert.equal((await application.db.query(FILE_UID).findOne({ where: { id: current.id } })).name, 'concurrent editorial change');
    checks.push('a concurrent editorial update prevents a stale replacement commit');
    await journal.interrupt(operation);
    const changed = await application.db.query(FILE_UID).findOne({ where: { id: current.id } });
    const refusedRetry = await journal.begin({ ...replacement, targetVersion: mediaVersion(changed) });
    assert.equal(refusedRetry.acquired, false);
    assert.equal(refusedRetry.operation.state, 'failed');
    assert.equal(refusedRetry.operation.failure, 'MEDIA_CHANGED');
    assert.equal((await journal.get(replacement.key)).attempt, operation.attempt);
    checks.push('retrying an interrupted key cannot re-baseline a concurrently edited target');
    process.stdout.write(JSON.stringify({ status: 'passed', campaign, revision: process.env.GTHF_REVISION || 'development', checkedAt: new Date().toISOString(), checks }, null, 2) + '\n');
  } finally {
    // Only the UUIDs and file hashes generated by this invocation are removed.
    for (const hash of hashes) await application.db.query(FILE_UID).deleteMany({ where: { hash } });
    if (keys.length) {
      await db(MEDIA_CLEANUP_TABLE).whereIn('operation_key', keys).delete();
      await db(MEDIA_OPERATION_TABLE).whereIn('key', keys).delete();
    }
    await application.destroy();
  }
}
main().catch((error) => { process.stderr.write(`Isolated journal check failed: ${error.name}\n`); process.exitCode = 1; });
