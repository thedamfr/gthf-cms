import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import * as core from '../src/admin/recovery/client-core';
import * as urlCore from '../src/admin/recovery/url-client-core';
import { adaptAdminUpload } from '../scripts/recovery/admin-adapter';

const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
const file = () => new File(['same synthetic image bytes'], 'crop.png', { type: 'image/png' });

async function fixture() {
  const store = new Map<string, string>();
  const receipts = new Map<string, core.MediaReceipt>();
  const posts: { key: string; url: string; name: string; fields: string | null; signal: AbortSignal }[] = [];
  const reads: string[] = [];
  const fault = { beforeSend: false, afterCommit: false, forbidden: false, storage: false, owner: 4 };
  const saved = () => [...store.values()].flatMap((value) => JSON.parse(value)) as core.MediaIntent[];
  const transport = {
    get: async (url: string) => {
      if (url === '/admin/users/me') return { data: { data: { id: fault.owner } } };
      const key = url.split('/').at(-1)!; reads.push(key);
      if (fault.forbidden) throw Object.assign(new Error('current permission denied'), { status: 403 });
      if (!receipts.has(key)) throw Object.assign(new Error('receipt absent'), { status: 404 });
      return { data: receipts.get(key) };
    },
    post: async (url: string, form: FormData, options: any) => {
      const key = options.headers['Idempotency-Key'];
      assert.match(key, /^[a-f0-9-]{36}$/);
      const intent = saved().find((item) => item.key === key)!;
      assert.ok(intent, 'The intent must be persisted before its first request');
      assert.equal(intent.path, url); assert.equal(intent.owner, 'admin:' + fault.owner);
      const upload = form.get('files') as File;
      assert.equal(intent.files[0].name, upload.name);
      assert.equal(JSON.stringify(intent).includes('same synthetic image bytes'), false);
      assert.equal(options.signal.aborted, false);
      posts.push({ key, url, name: upload.name, fields: form.get('fileInfo') as string | null, signal: options.signal });
      if (fault.forbidden) throw Object.assign(new Error('current permission denied'), { status: 403 });
      if (fault.beforeSend) { fault.beforeSend = false; throw new TypeError('Request did not reach server'); }
      const result = { id: Number(url.split('/')[3]), name: upload.name, hash: 'version-' + key };
      receipts.set(key, { key, status: 'committed', result });
      if (fault.afterCommit) { fault.afterCommit = false; throw new TypeError('Committed response was lost'); }
      return { data: result };
    },
  };
  const clientCode = await transform(fs.readFileSync('src/admin/recovery/client.ts', 'utf8'), { loader: 'ts', format: 'cjs' });
  const clientModule = { exports: {} as any };
  const globals = { URL, FormData, AbortSignal, File, Event, structuredClone, crypto: { randomUUID },
    window: { strapi: { backendURL: 'https://cms.invalid' }, location: { origin: 'https://cms.invalid' }, dispatchEvent() {} } };
  runInNewContext(clientCode.code, { ...globals, module: clientModule, exports: clientModule.exports,
    sessionStorage: { getItem: (name: string) => store.get(name), setItem: (name: string, value: string) => {
      if (fault.storage) throw new Error('storage unavailable'); store.set(name, value);
    } },
    require: (name: string) => name === './client-core' ? core : name === './url-client-core' ? urlCore : { getFetchClient: () => transport },
  });
  const name = 'future/services/assets.mjs';
  const root = path.join(path.dirname(require.resolve('@strapi/upload/package.json')), 'dist/admin');
  const moduleCode = await transform(adaptAdminUpload(fs.readFileSync(path.join(root, name), 'utf8'), name), { loader: 'js', format: 'cjs' });
  let definitions: any;
  const api = { injectEndpoints: ({ endpoints }: any) => {
    definitions = endpoints({ query: (value: any) => value, mutation: (value: any) => value }); return {};
  } };
  const uploadModule = { exports: {} as any };
  runInNewContext(moduleCode.code, { ...globals, module: uploadModule, exports: uploadModule.exports,
    require: (dependency: string) => dependency === './api.mjs' ? { uploadApi: api }
      : dependency === '@gthf/media-recovery' ? clientModule.exports : { getFetchClient: () => transport },
  });
  assert.equal(definitions.replaceAsset.query, undefined, 'The unprotected upstream transport must be replaced');
  return { replace: definitions.replaceAsset.queryFn, posts, reads, receipts, saved, fault, client: clientModule.exports };
}

test('actual beta replacement persists its identity and recovers a lost commit without another POST', async () => {
  const current = await fixture(); current.fault.afterCommit = true;
  const result = await current.replace({ id: 42, file: file(), fileInfo: { name: 'kept.png' } });
  assert.equal(result.data.id, 42); assert.equal(result.error, undefined);
  assert.equal(current.posts.length, 1); assert.deepEqual(current.reads, [current.posts[0].key]);
  assert.equal(current.posts[0].fields, '{"name":"kept.png"}');
  assert.equal(current.saved()[0].status, 'committed');
});

test('actual beta replacement retries a request lost before sending with the same identity', async () => {
  const current = await fixture(); current.fault.beforeSend = true;
  const result = await current.replace({ id: 42, file: file() });
  assert.equal(result.data.id, 42); assert.equal(current.posts.length, 2);
  assert.equal(current.posts[0].key, current.posts[1].key);
  assert.equal(current.saved().length, 1); assert.equal(current.saved()[0].status, 'committed');
});

test('same beta replacement selection reads its receipt; a deliberate new identical selection gets a new key', async () => {
  const current = await fixture(); const selected = file();
  const first = await current.replace({ id: 42, file: selected });
  const repeated = await current.replace({ id: 42, file: selected });
  assert.deepEqual(clone(repeated), clone(first)); assert.equal(current.posts.length, 1);
  const next = await current.replace({ id: 42, file: file() });
  assert.equal(next.data.id, 42); assert.equal(current.posts.length, 2);
  assert.notEqual(current.posts[0].key, current.posts[1].key);
});

test('replacement identities distinguish target, owner and metadata, including crop focal point', async () => {
  const current = await fixture(); const selected = file();
  for (const input of [{ id: 42 }, { id: 43 }, { id: 43, fileInfo: { focalPoint: { x: 0.2, y: 0.8 } } }]) {
    assert.ok((await current.replace({ ...input, file: selected })).data);
  }
  assert.equal(current.posts[2].fields, '{"focalPoint":{"x":0.2,"y":0.8}}');
  current.fault.owner = 5;
  assert.ok((await current.replace({ id: 43, file: selected, fileInfo: { focalPoint: { x: 0.2, y: 0.8 } } })).data);
  assert.equal(new Set(current.posts.map((item) => item.key)).size, 4);
});

test('replacement and crop never turn a current permission denial into success or another intent', async () => {
  const current = await fixture(); current.fault.forbidden = true;
  const selected = file();
  const failed = await current.replace({ id: 42, file: selected, fileInfo: { focalPoint: { x: 0.5, y: 0.5 } } });
  assert.match(failed.error.message, /permission denied/); assert.equal(failed.data, undefined);
  assert.equal(current.saved()[0].status, 'pending'); assert.equal(current.posts.length, 1);
  const again = await current.replace({ id: 42, file: selected, fileInfo: { focalPoint: { x: 0.5, y: 0.5 } } });
  assert.ok(again.error); assert.equal(current.posts.length, 1); assert.equal(current.saved().length, 1);
});

test('a committed replacement still consults current receipt permissions on a repeated selection', async () => {
  const current = await fixture(); const selected = file();
  assert.ok((await current.replace({ id: 42, file: selected })).data);
  current.fault.forbidden = true;
  const denied = await current.replace({ id: 42, file: selected });
  assert.ok(denied.error); assert.equal(denied.data, undefined); assert.equal(current.posts.length, 1);
});

test('replacement does not send without durable client storage and keeps RTK error shape', async () => {
  const current = await fixture(); current.fault.storage = true;
  const result = await current.replace({ id: 42, file: file() });
  assert.match(result.error.message, /storage unavailable/);
  assert.equal(result.data, undefined); assert.equal(current.posts.length, 0);
});

test('reloaded replacement intent consults the stored receipt before requiring another upload', async () => {
  const current = await fixture(); const selected = file(); current.fault.afterCommit = true;
  const result = await current.replace({ id: 42, file: selected });
  const intent = clone(current.saved()[0]);
  const recovered = await current.client.resumeIntent(intent, [selected]);
  assert.equal(recovered.id, result.data.id); assert.equal(current.posts.length, 1);
});
