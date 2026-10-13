import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { transform } from 'esbuild';
import * as core from '../src/admin/recovery/client-core';
import { adaptAdminUpload } from '../scripts/recovery/admin-adapter';
const key = '22222222-2222-4222-8222-222222222222';
const childKey = '33333333-3333-4333-8333-333333333333';
const payload = { fileIds: [5, 2, 5], folderIds: [7] };
const frozen = { fileIds: [2, 5], folderIds: [7] };
const result = { files: [{ id: 2 }, { id: 5 }], folders: [{ id: 7 }] };
const progress: core.BulkProgress = { total: 2, committed: 1, failed: 0, children: [
  { key: childKey, id: 2, status: 'committed' }, { key: '44444444-4444-4444-8444-444444444444', id: 5, status: 'pending' },
] };
async function loadClient(store = new Map<string, string>(), receipt: () => Promise<core.MediaReceipt | null> = async () => ({ key, kind: 'bulk-delete', status: 'committed', result })) {
  const client = { get: async (url: string) => {
    if (url === '/admin/users/me') return { data: { data: { id: 4 } } };
    const value = await receipt(); if (!value) throw Object.assign(new Error('absent'), { status: 404 });
    return { data: value };
  } };
  const compiled = await transform(fs.readFileSync('src/admin/recovery/client.ts', 'utf8'), { loader: 'ts', format: 'cjs' });
  const module = { exports: {} as any };
  runInNewContext(compiled.code, { module, exports: module.exports, URL, AbortSignal, structuredClone, crypto: { randomUUID }, Event,
    window: { strapi: { backendURL: 'https://cms.invalid' }, location: { origin: 'https://cms.invalid' }, dispatchEvent() {} },
    sessionStorage: { getItem: (name: string) => store.get(name), setItem: (name: string, value: string) => store.set(name, value) },
    require: (name: string) => name === './client-core' ? core : { getFetchClient: () => client } });
  return module.exports;
}
test('bulk selection is canonical, copied and refuses invalid or empty IDs', () => {
  const value = core.canonicalBulkPayload(payload); payload.fileIds.push(6);
  assert.deepEqual(value, frozen); payload.fileIds.pop();
  for (const input of [{ fileIds: [0] }, { fileIds: [1.5] }, { folderIds: ['2'] }, {}]) assert.throws(() => core.canonicalBulkPayload(input as any));
  assert.equal(core.safeMediaPath('/upload/actions/bulk-delete', 'https://cms.invalid'), '/upload/actions/bulk-delete');
  assert.throws(() => core.safeMediaPath('/upload/actions/bulk-delete?id=1', 'https://cms.invalid'));
});
test('first bulk POST observes its persisted parent identity and frozen canonical payload', async () => {
  const store = new Map<string, string>(); const client = await loadClient(store);
  const value = await client.runBulkDeleteIntent({ key, payload }, async (sent: string, body: core.BulkDeletePayload) => {
    const saved = JSON.parse(store.get('gthf-media-intents-v1:admin:4')!)[0];
    assert.equal(saved.key, sent); assert.deepEqual(saved.payload, frozen); assert.deepEqual(body, frozen);
    body.fileIds.push(999); // A transport cannot mutate the saved future retry.
    assert.deepEqual(saved.payload, frozen); return result;
  });
  assert.deepEqual(value, result);
  assert.deepEqual(JSON.parse(store.get('gthf-media-intents-v1:admin:4')!)[0].payload, frozen);
});
test('reload consults the same parent receipt without repeating committed bulk deletion', async () => {
  const store = new Map<string, string>(); const before = await loadClient(store); before.saveIntent(core.bulkIntent({ key, owner: 'admin:4', payload }));
  let reads = 0; const after = await loadClient(store, async () => { reads++; return { key, kind: 'bulk-delete', status: 'committed', result, progress }; });
  const value = await after.runBulkDeleteIntent({ key, payload }, async () => { throw new Error('Must not POST after reload'); });
  assert.deepEqual(value, result); assert.equal(reads, 1);
  assert.deepEqual(JSON.parse(store.get('gthf-media-intents-v1:admin:4')!)[0].progress, progress);
});
test('one selection preserves its UUID while a deliberate new identical selection gets another', async () => {
  const client = await loadClient(); const selection = [{ id: 2 }];
  assert.equal(client.bulkSelectionKey(selection), client.bulkSelectionKey(selection));
  assert.notEqual(client.bulkSelectionKey(selection), client.bulkSelectionKey([{ id: 2 }]));
});
test('bulk identity cannot be reused for another payload before any write or receipt', async () => {
  const store = new Map<string, string>(); const client = await loadClient(store, async () => { throw new Error('Must not read old receipt'); });
  client.saveIntent(core.bulkIntent({ key, owner: 'admin:4', payload }));
  await assert.rejects(client.runBulkDeleteIntent({ key, payload: { fileIds: [99] } }, async () => { throw new Error('Must not POST'); }), /autre sélection/);
});
test('partial pending parent progresses autonomously, preserving exact children and never reposting', async () => {
  const intent = core.bulkIntent({ key, owner: 'admin:4', payload }); let now = 0; let reads = 0; let writes = 0;
  const saved: core.MediaIntent[] = [];
  const value = await core.executeIntent(intent, { now: () => now, sleep: async () => { now += 1000; }, maxMs: 3000,
    transport: async () => { writes++; throw Object.assign(new Error('pending'), { status: 409, code: 'OPERATION_PENDING' }); },
    receipt: async () => ({ key, kind: 'bulk-delete', retryable: false, progress, status: ++reads < 3 ? 'pending' : 'committed', result }),
    save: (value) => saved.push(structuredClone(value)) });
  assert.deepEqual(value, result); assert.equal(writes, 1); assert.equal(reads, 3);
  assert.ok(saved.some((value) => value.status === 'pending' && value.progress?.committed === 1));
});
test('terminal partial batch preserves completed children and never announces overall success', async () => {
  const intent = core.bulkIntent({ key, owner: 'admin:4', payload }); let writes = 0;
  const partial = { ...progress, failed: 1, children: progress.children.map((child) => child.id === 5 ? { ...child, status: 'failed' as const, error: 'AUTHORIZATION_REVOKED' } : child) };
  await assert.rejects(core.executeIntent(intent, { receiptFirst: true, save() {}, transport: async () => { writes++; },
    receipt: async () => ({ key, kind: 'bulk-delete', status: 'failed', retryable: false, error: 'AUTHORIZATION_REVOKED', progress: partial }) }), /ne peut pas/);
  assert.equal(writes, 0); assert.equal(intent.status, 'failed'); assert.equal(intent.message, 'AUTHORIZATION_REVOKED'); assert.deepEqual(intent.progress, partial);
});
test('an absent parent alone permits resending the same frozen selection after reload', async () => {
  const intent = core.bulkIntent({ key, owner: 'admin:4', payload }); let reads = 0; let now = 0; const keys: string[] = [];
  await core.executeIntent(intent, { receiptFirst: true, now: () => now, sleep: async () => { now += 1000; }, maxMs: 2500, save() {},
    transport: async (sent) => { keys.push(sent); return result; }, receipt: async () => { reads++; return null; } });
  assert.equal(reads, 1); assert.deepEqual(keys, [key]); assert.deepEqual(intent.payload, frozen);
});
test('changed receipt identity never commits a bulk intent or authorises another POST', async () => {
  const intent = core.bulkIntent({ key, owner: 'admin:4', payload }); let now = 0;
  await assert.rejects(core.executeIntent(intent, { receiptFirst: true, now: () => now, sleep: async () => { now += 1000; }, maxMs: 1000, save() {},
    transport: async () => assert.fail('must not send'), receipt: async () => ({ key: childKey, status: 'committed', result }) }), core.PendingMediaError);
  assert.equal(intent.status, 'pending');
});
async function transformed(name: string, requireHook: (name: string) => any) {
  const root = path.join(path.dirname(require.resolve('@strapi/upload/package.json')), 'dist/admin');
  const source = adaptAdminUpload(fs.readFileSync(path.join(root, name), 'utf8'), name);
  const compiled = await transform(source, { loader: 'js', format: 'cjs' }); const module = { exports: {} as any };
  runInNewContext(compiled.code, { module, exports: module.exports, AbortSignal, require: requireHook }); return module.exports;
}
test('real transformed legacy bulk hook preserves Strapi response shape and stable selection key', async () => {
  const keys: string[] = []; const selected = [{ id: 5, type: 'asset' }, { id: 7, type: 'folder' }];
  const client = await loadClient();
  const hooks = { useDispatch: () => () => {}, useNotification: () => ({}), useIntl: () => ({}), useQueryClient: () => ({}),
    useMutation: (action: any) => ({ mutateAsync: action }), bulkSelectionKey: client.bulkSelectionKey,
    runBulkDeleteIntent: async (options: any, transport: any) => { keys.push(options.key); return transport(options.key, options.payload); },
    useFetchClient: () => ({ post: async (_url: string, data: any, options: any) => { assert.deepEqual(JSON.parse(JSON.stringify(data)), { fileIds: [5], folderIds: [7] }); assert.equal(options.headers['Idempotency-Key'], keys.at(-1)); return { data: { data: result } }; } }),
  };
  const exports = await transformed('hooks/useBulkRemove.mjs', () => hooks); const hook = exports.useBulkRemove();
  assert.deepEqual(JSON.parse(JSON.stringify(await hook.remove(selected))), { data: { data: result } });
  await hook.remove(selected); await hook.remove([...selected]); assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
});
test('real transformed beta bulk mutation uses parent key and returns errors instead of false success', async () => {
  let definitions: any; let fail = false;
  const api = { enhanceEndpoints: () => api, injectEndpoints: ({ endpoints }: any) => { definitions = endpoints({ query: (x: any) => x, mutation: (x: any) => x }); return {}; } };
  await transformed('future/services/assets.mjs', (name) => {
    if (name === './api.mjs') return { uploadApi: api };
    return { runBulkDeleteIntent: async (options: any, transport: any) => { assert.equal(options.key, key); if (fail) throw new core.PendingMediaError(key); return transport(key, frozen); },
      getFetchClient: () => ({ post: async (_url: string, body: any, options: any) => { assert.deepEqual(body, frozen); assert.equal(options.headers['Idempotency-Key'], key); return { data: { data: result } }; } }) };
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await definitions.bulkDeleteItems.queryFn({ ...frozen, operationKey: key }))), { data: { data: result } });
  fail = true; const failed = await definitions.bulkDeleteItems.queryFn({ ...frozen, operationKey: key }); assert.ok(failed.error); assert.equal(failed.data, undefined);
});
