import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MediaBatches } from '../../src/infrastructure/recovery/batches';
import { MediaJournal } from '../../src/infrastructure/recovery/journal';
import { Actor, FILE_UID, FOLDER_UID, MEDIA_BATCH_TABLE, MEDIA_OPERATION_TABLE, RecoveryError } from '../../src/infrastructure/recovery/types';
import { sha256 } from '../../src/infrastructure/recovery/storage';

/** Called only after check-journal's strict VM guards and worker drain. */
export async function checkBatches(application: any, journal: MediaJournal, actor: Actor,
  keys: string[], hashes: string[], folderIds: number[], checks: string[]) {
  const db = application.db.connection;
  const storage: any = { key: (file: any) => file.hash + (file.ext || '') };
  let denied = false; let pauseAfterFirst = false;
  const batches = new MediaBatches(application, journal, storage,
    async () => { if (denied) throw new RecoveryError(403, 'AUTHORIZATION_REVOKED', 'qualification revoked batch permission'); },
    async (_point, context) => { if (pauseAfterFirst && context.objectIndex === 0) { pauseAfterFirst = false; throw new Error('qualification loss after first committed child'); } });
  const fixture = async (count = 2) => {
    const root = await application.plugin('upload').service('folder').create({ name: `journal-batch-${randomUUID()}` });
    folderIds.push(root.id);
    const child = await application.plugin('upload').service('folder').create({ name: 'nested', parent: root.id }); folderIds.push(child.id);
    const creator = await application.db.query('admin::user').findOne({ select: ['id'] });
    const files = [];
    for (let index = 0; index < count; index++) {
      const hash = `gthf_journal_test_${randomUUID().replace(/-/g, '')}`; hashes.push(hash);
      files.push(await application.db.query(FILE_UID).create({ data: { name: 'batch fixture', hash, ext: '.txt', mime: 'text/plain', size: 0.001,
        url: `https://example.invalid/${hash}.txt`, provider: 'aws-s3', folder: child.id, folderPath: child.path, ...(creator ? { createdBy: creator.id } : {}) } }));
    }
    return { root, child, files, creator };
  };
  const begin = async (fixture: any) => {
    const key = randomUUID(); keys.push(key);
    const started = await batches.begin(key, actor, { folderIds: [fixture.root.id] });
    keys.push(...started.batch.manifest.files.map((file) => file.key));
    return started.batch;
  };
  const first = await fixture(); const batch = await begin(first);
  assert.equal(batch.manifest.files.length, 2); assert.equal(batch.manifest.folders.length, 2);
  assert.equal(batch.manifest.files[0].file.createdBy, first.creator?.id ?? null);
  assert.equal(batch.manifest.files[0].file.folder, first.child.id);
  assert.equal((await batches.begin(batch.key, actor, { folderIds: [first.root.id, first.root.id] })).acquired, false);
  await assert.rejects(batches.getOwned(batch.key, 'qualification:foreign'), (error: any) => error.status === 404);
  await assert.rejects(batches.begin(batch.key, actor, { fileIds: [first.files[0].id] }), (error: any) => error.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(journal.begin({ key: batch.key, actor, kind: 'upload', requestHash: sha256('fixture') }), (error: any) => error.code === 'IDEMPOTENCY_CONFLICT');
  const operationKey = randomUUID(); keys.push(operationKey);
  await journal.begin({ key: operationKey, actor, kind: 'upload', requestHash: sha256('fixture') });
  await assert.rejects(batches.begin(operationKey, actor, { folderIds: [first.root.id] }), (error: any) => error.code === 'IDEMPOTENCY_CONFLICT');
  checks.push('batch scope freezes recursive files, creator IDs and folders; canonical identity is unique across both journals');

  pauseAfterFirst = true;
  await assert.rejects(batches.process(batch), (error: any) => error.code === 'OPERATION_PENDING');
  assert.equal(await application.db.query(FILE_UID).count({ where: { id: first.files[0].id } }), 0);
  assert.equal(await application.db.query(FILE_UID).count({ where: { id: first.files[1].id } }), 1);
  assert.equal(await application.db.query(FOLDER_UID).count({ where: { id: first.root.id } }), 1);
  assert.equal((await batches.receipt(await batches.get(batch.key))).progress.committed, 1);
  const resumed = await batches.claimExpired(batch.key); assert.ok(resumed); assert.notEqual(resumed.lease_owner, batch.lease_owner);
  await assert.rejects(batches.assertLease(batch), (error: any) => error.code === 'OPERATION_LEASE_LOST');
  const result = await batches.process(resumed);
  assert.deepEqual(result.files.map((file) => file.id), first.files.map((file: any) => file.id));
  assert.equal(await application.db.query(FOLDER_UID).count({ where: { id: { $in: [first.root.id, first.child.id] } } }), 0);
  const replay = await batches.begin(batch.key, actor, { folderIds: [first.root.id] });
  assert.equal(replay.acquired, false); assert.deepEqual(replay.batch.receipt, result);
  assert.equal(Number((await db(MEDIA_OPERATION_TABLE).whereIn('key', batch.manifest.files.map((file) => file.key)).count('* as count'))[0].count), 2);
  checks.push('a batch interrupted after its first child resumes with unique receipts and removes its nested folders only at completion');

  const revokedFixture = await fixture(); const revoked = await begin(revokedFixture);
  pauseAfterFirst = true; await assert.rejects(batches.process(revoked));
  denied = true;
  await assert.rejects(batches.process(await batches.claimExpired(revoked.key)), (error: any) => error.code === 'AUTHORIZATION_REVOKED');
  denied = false;
  const revokedReceipt = await batches.receipt(await batches.get(revoked.key));
  assert.equal(revokedReceipt.status, 'failed'); assert.equal(revokedReceipt.error, 'AUTHORIZATION_REVOKED');
  assert.equal(revokedReceipt.progress.committed, 1); assert.equal(revokedReceipt.progress.total, 2);
  assert.equal(await application.db.query(FILE_UID).count({ where: { id: revokedFixture.files[1].id } }), 1);
  assert.equal(await application.db.query(FOLDER_UID).count({ where: { id: revokedFixture.root.id } }), 1);
  checks.push('revoked batch rights expose a terminal partial receipt and preserve the remaining file and folders');

  const changedFixture = await fixture(1); const changed = await begin(changedFixture);
  const addedHash = `gthf_journal_test_${randomUUID().replace(/-/g, '')}`; hashes.push(addedHash);
  const addition = await application.db.query(FILE_UID).create({ data: { name: 'new concurrent media', hash: addedHash, ext: '.txt', mime: 'text/plain', size: 0.001,
    url: `https://example.invalid/${addedHash}.txt`, provider: 'aws-s3', folder: changedFixture.child.id, folderPath: changedFixture.child.path } });
  await assert.rejects(batches.process(changed), (error: any) => error.code === 'FOLDER_CHANGED');
  assert.equal((await batches.get(changed.key)).state, 'failed');
  assert.equal(await application.db.query(FILE_UID).count({ where: { id: addition.id } }), 1);
  assert.equal(await application.db.query(FOLDER_UID).count({ where: { id: changedFixture.root.id } }), 1);
  checks.push('a media added after the batch snapshot survives and blocks folder deletion with FOLDER_CHANGED');

  const rollbackFixture = await fixture(0); const rollback = await begin(rollbackFixture);
  const originalQuery = application.db.query.bind(application.db);
  application.db.query = (uid: any) => {
    const query = originalQuery(uid);
    return uid === FOLDER_UID ? { ...query, deleteMany: async (args: any) => { await query.deleteMany(args); throw new Error('qualification failure after folder DELETE'); } } : query;
  };
  try { await assert.rejects(batches.process(rollback), (error: any) => error.code === 'OPERATION_PENDING'); }
  finally { application.db.query = originalQuery; }
  assert.equal(await application.db.query(FOLDER_UID).count({ where: { id: rollbackFixture.root.id } }), 1);
  assert.equal((await batches.get(rollback.key)).state, 'pending');
  await batches.process(await batches.claimExpired(rollback.key));
  assert.equal((await batches.get(rollback.key)).state, 'committed');
  assert.equal(await application.db.query(FOLDER_UID).count({ where: { id: rollbackFixture.root.id } }), 0);
  checks.push('folder metadata and the final batch receipt roll back together and resume without S3 or a batch-wide file transaction');
}
