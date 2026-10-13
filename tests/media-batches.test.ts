import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaBatches, batchChildKey, batchPermissionOperation, normalizeBatchInput } from '../src/infrastructure/recovery/batches';
import { RecoveryError } from '../src/infrastructure/recovery/types';

const key = '11111111-1111-4111-8111-111111111111';
const file = { id: 42, hash: 'immutable', ext: '.png', provider: 'aws-s3', updatedAt: '2026-10-13T22:00:00Z', createdBy: 8, folder: 3 };
const plan = { key: batchChildKey(key, file.id), version: 'frozen-original-version', file };
const batch: any = { key, actor: 'admin:8', admin_user_id: 8, attempt: key, lease_owner: key, state: 'pending', input: { fileIds: [42], folderIds: [] }, manifest: { files: [plan], folders: [], rootFolderIds: [] } };
function setup({ acquired = true, state = 'prepared', failure = undefined as string | undefined, denied = false } = {}) {
  const prepared: any[] = []; const committed: any[] = []; const inputs: any[] = []; const interrupted: any[] = [];
  const operation: any = { state, failure, receipt: file };
  const journal: any = {
    begin: async (input: any) => { inputs.push(input); return { operation, acquired }; },
    prepare: async (_operation: any, manifest: any) => { prepared.push(manifest); },
    commit: async (value: any) => { committed.push(value); return file; },
    interrupt: async (...args: any[]) => { interrupted.push(args); },
  };
  const engine = new MediaBatches({ config: { get: () => ({ provider: 'aws-s3' }) } }, journal,
    { key: (value: any) => value.hash + value.ext } as any,
    async () => { if (denied) throw new RecoveryError(403, 'AUTHORIZATION_REVOKED', 'revoked'); }, async () => {});
  return { engine, journal, prepared, committed, inputs, interrupted };
}
test('batch input has one canonical identity and refuses unsafe IDs or additional instructions', () => {
  assert.deepEqual(normalizeBatchInput({ folderIds: [3, 2, 3], fileIds: [42, 1, 42] }), { fileIds: [1, 42], folderIds: [2, 3] });
  for (const value of [null, [], { fileIds: ['42'] }, { folderIds: [-1] }, { folderIds: [0] }, { fileIds: [Infinity] }, { force: true }]) {
    assert.throws(() => normalizeBatchInput(value), (error: any) => error.code === 'INVALID_MEDIA_BATCH');
  }
});
test('batch child identities are stable per file and distinct across parents or files', () => {
  assert.match(plan.key, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(batchChildKey(key, 42), plan.key); assert.notEqual(batchChildKey(key, 43), plan.key);
  assert.notEqual(batchChildKey('22222222-2222-4222-8222-222222222222', 42), plan.key);
});
test('a batch child retains the original media version and permission subject before deletion', async () => {
  const current = setup(); assert.equal(await (current.engine as any).child(batch, plan), file);
  assert.equal(current.inputs[0].key, plan.key); assert.equal(current.inputs[0].targetVersion, plan.version);
  assert.deepEqual(current.inputs[0].actor, { id: 'admin:8', adminUserId: 8 });
  assert.equal(current.prepared[0].files[0].permissionSubject.createdBy, 8);
  assert.equal(current.prepared[0].files[0].previousVersion, plan.version);
  assert.deepEqual(current.prepared[0].obsolete, [{ key: 'immutable.png' }]);
});
test('a committed batch child replays its receipt after its file has disappeared', async () => {
  const current = setup({ acquired: false, state: 'committed' });
  assert.equal(await (current.engine as any).child(batch, plan), file);
  assert.equal(current.prepared.length, 0); assert.equal(current.committed.length, 0);
});
test('a pending child blocks batch completion and a failed child stays terminal', async () => {
  for (const [state, failure, expected] of [['prepared', undefined, 'OPERATION_PENDING'], ['failed', 'MEDIA_CHANGED', 'MEDIA_CHANGED']]) {
    const current = setup({ acquired: false, state, failure });
    await assert.rejects((current.engine as any).child(batch, plan), (error: any) => error.code === expected);
    assert.equal(current.committed.length, 0);
  }
});
test('revoked current rights prevent even replaying a committed child through its parent', async () => {
  const current = setup({ acquired: false, state: 'committed', denied: true });
  await assert.rejects((current.engine as any).child(batch, plan), (error: any) => error.code === 'AUTHORIZATION_REVOKED');
  assert.equal(current.inputs.length, 0);
});
test('a target changed after preparation becomes a terminal child rather than a rebased delete', async () => {
  const current = setup(); current.journal.commit = async () => { throw new RecoveryError(409, 'MEDIA_CHANGED', 'changed'); };
  await assert.rejects((current.engine as any).child(batch, plan), (error: any) => error.code === 'MEDIA_CHANGED');
  assert.equal(current.interrupted.length, 1); assert.equal(current.interrupted[0][1], true);
});
test('batch permission checks use the original creators of every selected media', () => {
  const operation = batchPermissionOperation(batch);
  assert.equal(operation.kind, 'delete'); assert.equal(operation.actor, batch.actor);
  assert.equal(operation.manifest.files[0].permissionSubject.createdBy, 8);
});

for (const moved of [[], [{ id: 7, name: 'selected', path: '/moved', pathId: 7, updatedAt: '2026-10-13T22:00:01Z' }]]) {
  test('a folder moved between root and descendant reads cannot become a successful empty batch: ' + (moved.length ? 'changed root' : 'missing root'), async () => {
    const root = { id: 7, name: 'selected', path: '/7', pathId: 7, updatedAt: '2026-10-13T22:00:00Z' };
    let reads = 0; let fileReads = 0;
    const strapi = { db: { query: (uid: string) => ({ findMany: async () => {
      if (uid === 'plugin::upload.file') { fileReads++; return []; }
      return reads++ === 0 ? [root] : moved;
    } }) } };
    const engine = new MediaBatches(strapi, {} as any, {} as any, async () => {}, async () => {});
    await assert.rejects((engine as any).snapshot(key, { fileIds: [], folderIds: [7] }), (error: any) => error.code === 'FOLDER_CHANGED');
    assert.equal(fileReads, 0, 'The inconsistent folder scope must fail before planning file deletions');
  });
}


test('newly committed batch children emit sanitized media events but their replays do not', async () => {
  const emitted: any[] = []; const current = setup();
  (current.engine as any).strapi.getModel = () => ({ attributes: { id: { type: 'integer' }, hash: { type: 'string' }, privateValue: { type: 'string', private: true } } });
  (current.engine as any).strapi.eventHub = { emit: (...args: any[]) => emitted.push(args) };
  current.journal.commit = async () => ({ id: 42, hash: 'immutable', privateValue: 'never expose' });
  const previousStrapi = (globalThis as any).strapi;
  (globalThis as any).strapi = { config: { get: () => [] } };
  try { await (current.engine as any).child(batch, plan); }
  finally { (globalThis as any).strapi = previousStrapi; }
  assert.deepEqual(emitted, [['media.delete', { media: { id: 42, hash: 'immutable' } }]]);
  current.journal.begin = async () => ({ acquired: false, operation: { state: 'committed', receipt: file } });
  await (current.engine as any).child(batch, plan); assert.equal(emitted.length, 1);
});

test('a committed batch emits its folder event and original bulk metric once after metadata commit', async () => {
  const events: any[] = []; const metric: any[] = []; const order: string[] = []; const current = setup();
  const instance: any = current.engine;
  instance.strapi.eventHub = { emit: (...args: any[]) => { order.push('folder-event'); events.push(args); } };
  instance.strapi.plugin = () => ({ service: () => ({ trackUsage: async (...args: any[]) => metric.push(args) }) });
  instance.assertLease = async () => {}; instance.child = async () => file;
  instance.finish = async () => { order.push('committed'); return { files: [file], folders: [{ id: 3 }] }; };
  const input = { ...batch, manifest: { files: [plan, { ...plan, file: { ...file, id: 43 } }], folders: [{ id: 3 }, { id: 4 }], rootFolderIds: [3] } };
  const result = await instance.process(input);
  assert.deepEqual(order, ['committed', 'folder-event']); assert.deepEqual(events, [['media-folder.delete', { folders: result.folders }]]);
  assert.deepEqual(metric, [['didBulkDeleteMediaLibraryElements', { eventProperties: { rootFolderNumber: 1, rootAssetNumber: 1, totalFolderNumber: 2, totalAssetNumber: 2 } }]]);
  instance.strapi.eventHub.emit = () => { throw new Error('informational event unavailable'); };
  instance.strapi.plugin = () => ({ service: () => ({ trackUsage: async () => { throw new Error('telemetry unavailable'); } }) });
  assert.deepEqual(await instance.process(input), result, 'post-commit effects cannot turn the durable result into failure');
});
