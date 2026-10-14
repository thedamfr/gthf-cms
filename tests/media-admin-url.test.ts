import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import * as core from '../src/admin/recovery/client-core';
import * as urlCore from '../src/admin/recovery/url-client-core';
import { adaptAdminUpload } from '../scripts/recovery/admin-adapter';
const key = '22222222-2222-4222-8222-222222222222';
const owner = 'admin:4';
const event = (name: string, value: any) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
const intent = () => urlCore.urlIntent({ key, owner, url: 'https://source.invalid/image.png', folderId: 3 });
async function loadClient(options: { store?: Map<string, string>; receipt?: (key: string) => Promise<any>; post?: (...args: any[]) => Promise<any>; ownerId?: number; failStorage?: boolean } = {}) {
  const store = options.store || new Map<string, string>();
  const client = { get: async (url: string) => {
    if (url === '/admin/users/me') return { data: { data: { id: options.ownerId ?? 4 } } };
    const value = await options.receipt?.(url.split('/').at(-1)!);
    if (!value) throw Object.assign(new Error('absent'), { status: 404 }); return { data: value };
  }, post: options.post || (async () => assert.fail('Unexpected POST')) };
  const module = { exports: {} as any };
  const compiled = await transform(fs.readFileSync('src/admin/recovery/client.ts', 'utf8'), { loader: 'ts', format: 'cjs' });
  runInNewContext(compiled.code, { module, exports: module.exports, URL, AbortSignal, structuredClone, Event, crypto: { randomUUID },
    window: { strapi: { backendURL: 'https://cms.invalid' }, location: { origin: 'https://cms.invalid' }, dispatchEvent() {} },
    sessionStorage: { getItem: (name: string) => store.get(name), setItem: (name: string, value: string) => { if (options.failStorage) throw new Error('storage full'); store.set(name, value); } },
    require: (name: string) => name === './client-core' ? core : name === './url-client-core' ? urlCore : { getFetchClient: () => client },
  });
  return { ...module.exports, store };
}
test('URL selection validates its shape and keeps duplicate URLs as distinct entries', () => {
  assert.deepEqual(urlCore.canonicalUrlSelection(['https://source.invalid', 'https://source.invalid']), { urls: ['https://source.invalid/', 'https://source.invalid/'], folderId: null });
  for (const urls of [[], Array(21).fill('https://source.invalid'), ['file:///etc/passwd'], ['https://user:password@source.invalid'], ['https://source.invalid/' + 'x'.repeat(4096)]]) assert.throws(() => urlCore.canonicalUrlSelection(urls));
  assert.throws(() => urlCore.canonicalUrlSelection(['https://source.invalid'], 0));
  assert.equal(core.safeMediaPath('/upload/actions/upload-from-urls', 'https://cms.invalid'), '/upload/actions/upload-from-urls');
  assert.throws(() => core.safeMediaPath('/upload/actions/upload-from-urls?id=1', 'https://cms.invalid'));
});
test('all URL identities are persisted before send, retry keeps each key and a new selection gets new keys', async () => {
  const client = await loadClient(); const urls = ['https://source.invalid/a', 'https://source.invalid/a'];
  const first = await client.prepareUrlUploadIntents({ urls, folderId: 3 });
  assert.notEqual(first[0].key, first[1].key);
  assert.equal(JSON.stringify(client.readIntents(owner).map((item: any) => item.key)), JSON.stringify(first.map((item: any) => item.key)));
  assert.deepEqual((await client.prepareUrlUploadIntents({ urls, folderId: 3 })).map((item: any) => item.key), first.map((item: any) => item.key));
  assert.notEqual((await client.prepareUrlUploadIntents({ urls: [...urls], folderId: 3 }))[0].key, first[0].key);
  urls[0] = 'https://source.invalid/changed';
  assert.notEqual((await client.prepareUrlUploadIntents({ urls, folderId: 3 }))[0].key, first[0].key);
});
test('storage failure prevents obtaining a sendable URL selection', async () => {
  const client = await loadClient({ failStorage: true });
  await assert.rejects(client.prepareUrlUploadIntents({ urls: ['https://source.invalid/a'] }), /storage full/);
});
test('a lost SSE response after commit is recovered after reload without another POST or URL fetch', async () => {
  const before = await loadClient(); const [saved] = await before.prepareUrlUploadIntents({ urls: ['https://source.invalid/a'], folderId: 3 });
  let reads = 0;
  const after = await loadClient({ store: before.store, receipt: async (asked) => { reads++; assert.equal(asked, saved.key); return { key: asked, status: 'committed', result: [{ id: 17 }] }; } });
  assert.equal((await after.resumeIntent(after.readIntents(owner)[0])).id, 17); assert.equal(reads, 1);
  assert.equal(after.readIntents(owner)[0].status, 'committed');
});
test('an import absent from the server resumes the exact saved URL, folder and key through authenticated text transport', async () => {
  const store = new Map<string, string>(); let calls = 0;
  const client = await loadClient({ store, post: async (path, payload, options) => {
    calls++; assert.equal(path, '/upload/actions/upload-from-urls'); assert.equal(options.responseType, 'text');
    assert.deepEqual(JSON.parse(JSON.stringify(payload)), { urls: ['https://source.invalid/image.png'], folderId: 3, operationKeys: [key] });
    return { data: event('file:complete', { index: 0, operationKey: key, file: { id: 8 }, replayed: false }) + event('stream:complete', { data: [{ id: 8 }], errors: [] }) };
  } });
  client.saveIntent(intent()); assert.equal((await client.resumeIntent(client.readIntents(owner)[0])).id, 8); assert.equal(calls, 1);
});
test('owner changes and revoked permissions cannot resend a saved URL import', async () => {
  const client = await loadClient({ ownerId: 5 }); await assert.rejects(client.resumeIntent(intent()), /autre session/);
  const forbidden = await loadClient({ receipt: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } });
  forbidden.saveIntent(intent()); await assert.rejects(forbidden.resumeIntent(intent()), /forbidden/);
  assert.equal(forbidden.readIntents(owner)[0].key, key);
});
test('URL event identity and pending state are checked without mistaking a partial result for complete', () => {
  const item = intent();
  assert.throws(() => urlCore.applyUrlUploadEvent([item], 'file:complete', { index: 0, operationKey: randomUUID(), file: { id: 3 } }), /identity/);
  assert.throws(() => urlCore.applyUrlUploadEvent([item], 'file:complete', { index: 2, operationKey: key, file: { id: 3 } }), /index/);
  urlCore.applyUrlUploadEvent([item], 'file:error', { index: 0, operationKey: key, code: 'OPERATION_PENDING', retryable: false });
  assert.equal(item.status, 'pending');
  assert.throws(() => urlCore.urlUploadResult(event('file:complete', { index: 0, operationKey: key, file: { id: 3 } }), item), core.PendingMediaError);
  const pending = event('file:error', { index: 0, operationKey: key, code: 'OPERATION_PENDING', retryable: false }) + event('stream:complete', { data: [], errors: [{}] });
  assert.throws(() => urlCore.urlUploadResult(pending, item), (error: any) => error.status === 409 && error.code === 'OPERATION_PENDING');
});
async function actualAdapter(client: any, response: (request: any) => Response) {
  let definitions: any; const actions: any[] = [];
  const api: any = { enhanceEndpoints: () => api, injectEndpoints: ({ endpoints }: any) => {
    definitions = endpoints({ query: (value: any) => value, mutation: (value: any) => value });
    return { endpoints: { generateAiMetadata: { initiate: () => ({ type: 'AI' }) } } };
  } };
  const root = path.join(path.dirname(require.resolve('@strapi/upload/package.json')), 'dist/admin');
  const source = adaptAdminUpload(fs.readFileSync(path.join(root, 'future/services/api.mjs'), 'utf8'), 'future/services/api.mjs');
  const compiled = await transform(source, { loader: 'js', format: 'cjs' }); const module = { exports: {} as any };
  runInNewContext(compiled.code, { module, exports: module.exports, AbortController, AbortSignal, DOMException, TextDecoder, Error, console,
    window: { strapi: { backendURL: 'https://cms.invalid' } },
    fetch: async (_url: string, options: any) => response(JSON.parse(options.body)),
    require: (name: string) => {
      if (name === '@gthf/media-recovery') return client;
      if (name === '@strapi/admin/strapi-admin') return { adminApi: api };
      if (name.endsWith('/files.mjs')) return { getFilenameFromUrl: (url: string) => url.split('/').at(-1) };
      return new Proxy({}, { get: (_target, property) => (payload: any) => ({ type: property, payload }) });
    },
  });
  return { actions, run: (urls: string[]) => definitions.uploadFromUrls.queryFn({ urls, folderId: null, generateAiMetadata: true }, {
    dispatch: (action: any) => { actions.push(action); return { unwrap: async () => [] }; }, getState: () => ({ admin_app: { token: 'synthetic' }, uploadProgress: { uploadId: 'test' } }),
  }) };
}
test('actual adapted SSE mutation sends persisted keys, records per-file outcomes and does not generate AI on a replay', async () => {
  const client = await loadClient(); const adapter = await actualAdapter(client, (request) => {
    const saved = client.readIntents(owner); assert.equal(saved.length, 2); assert.equal(JSON.stringify(request.operationKeys), JSON.stringify(saved.map((item: any) => item.key)));
    return new Response(event('file:complete', { index: 0, operationKey: request.operationKeys[0], file: { id: 17 }, replayed: true })
      + event('file:error', { index: 1, operationKey: request.operationKeys[1], code: 'OPERATION_PENDING', retryable: false })
      + event('stream:complete', { data: [{ id: 17 }], errors: [{}] }));
  });
  const result = await adapter.run(['https://source.invalid/a', 'https://source.invalid/b']);
  assert.equal(result.data.data[0].id, 17); assert.equal(JSON.stringify(client.readIntents(owner).map((item: any) => item.status).sort()), JSON.stringify(['committed', 'pending']));
  assert.equal(adapter.actions.filter((action) => action.type === 'AI').length, 0);
});
test('actual adapted SSE mutation refuses an incomplete stream and preserves the pending identity', async () => {
  const client = await loadClient(); const adapter = await actualAdapter(client, () => new Response(event('file:fetching', { index: 0, url: 'https://source.invalid/a' })));
  const result = await adapter.run(['https://source.invalid/a']); assert.ok(result.error); assert.equal(result.data, undefined);
  assert.equal(client.readIntents(owner)[0].status, 'pending'); assert.ok(adapter.actions.some((action) => action.type === 'setUploadFailed'));
});
test('URL text transport keeps a named identity conflict and never accepts an older receipt afterward', async () => {
  let reads = 0;
  const client = await loadClient({ receipt: async () => { reads++; assert.equal(reads, 1, 'Do not read another payload receipt after conflict'); return null; },
    post: async (_path, _body, options) => {
      assert.equal(options.validateStatus(409), true); assert.equal(options.validateStatus(403), false);
      return { status: 409, data: JSON.stringify({ error: { name: 'IDEMPOTENCY_CONFLICT', message: 'Payload differs' } }) };
    } });
  client.saveIntent(intent()); await assert.rejects(client.resumeIntent(intent()), /Payload differs/);
  assert.equal(reads, 1); assert.equal(client.readIntents(owner)[0].status, 'failed'); assert.equal(client.readIntents(owner)[0].message, 'IDEMPOTENCY_CONFLICT');
});
