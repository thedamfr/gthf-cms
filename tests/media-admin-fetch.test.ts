import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import { adaptAdminFetchClient, adminRecoveryPlugin, ADMIN_FETCH_CONTRACTS } from '../scripts/recovery/admin-adapter';

const name = 'admin/src/utils/getFetchClient.mjs';
const file = path.join(path.dirname(require.resolve('@strapi/admin/package.json')), 'dist/admin', name);
const upstream = fs.readFileSync(file, 'utf8');
const actualRequire = createRequire(file);
const endpoint = '/upload/actions/upload-from-urls';
const operationKey = '22222222-2222-4222-8222-222222222222';
const payload = { urls: ['https://example.invalid/fixture.png'], folderId: 1, operationKeys: [operationKey] };
const sse = `event: file:complete\ndata: ${JSON.stringify({ index: 0, operationKey, file: { id: 42 } })}\n\nevent: stream:complete\ndata: {}\n\n`;
const conflict = JSON.stringify({ error: { name: 'IDEMPOTENCY_CONFLICT', message: 'payload differs' } });

type Reply = { status: number; body: string; contentType?: string };
async function loadTransport(replies: Reply[], adapted = true) {
  // Execute the actual pinned Strapi module and its real lodash/qs dependencies.
  // Only the browser's fetch/storage boundary is simulated; no client/refresh mock.
  const compiled = await transform(adapted ? adaptAdminFetchClient(upstream, name) : upstream, { loader: 'js', format: 'cjs' });
  const module = { exports: {} as any };
  const requests: { url: string; options: RequestInit }[] = [];
  const storage = new Map([['jwtToken', JSON.stringify('initial-token')]]);
  const remaining = [...replies];
  runInNewContext(compiled.code, {
    module, exports: module.exports, Headers, FormData,
    window: { strapi: { backendURL: 'https://cms.invalid' } },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    fetch: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      const next = remaining.shift();
      assert.ok(next, 'unexpected request');
      return new Response(next.body, { status: next.status, headers: { 'Content-Type': next.contentType ?? 'application/json' } });
    },
    require: (id: string) => {
      if (id === './cookies.mjs') return {
        AUTH_COOKIE_NAME: 'synthetic-access-token',
        getCookieValue: () => { throw new Error('persisted-token test must not read cookies'); },
        setCookie: () => { throw new Error('persisted-token test must not write cookies'); },
      };
      return actualRequire(id);
    },
    console: { warn() {}, error() {} },
  });
  return { client: module.exports.getFetchClient(), requests, storage, remaining };
}

test('the pinned admin adaptation changes only POST responseType and rejects upstream drift', async () => {
  assert.equal(Object.keys(ADMIN_FETCH_CONTRACTS).length, 1);
  const adapted = adaptAdminFetchClient(upstream, name);
  assert.equal(adapted.replace('responseInterceptor(response, options?.validateStatus, options?.responseType)',
    'responseInterceptor(response, options?.validateStatus)'), upstream);
  assert.throws(() => adaptAdminFetchClient(upstream + '\n', name), /Unreviewed Strapi admin module/);
  assert.equal(adaptAdminFetchClient('unrelated', 'other.mjs'), 'unrelated');
  const plugin = adminRecoveryPlugin(process.cwd());
  assert.equal(plugin.transform(upstream, file + '?v=fixture')?.code, adapted);
  assert.throws(() => plugin.transform(upstream + '\n', file), /Unreviewed/);
  assert.equal(plugin.transform('unrelated', file.replace('getFetchClient.mjs', 'cookies.mjs')), null);
});

test('actual POST returns the complete SSE response and HTTP status', async () => {
  const { client, requests, remaining } = await loadTransport([{ status: 200, body: sse, contentType: 'text/event-stream' }]);
  const result = await client.post(endpoint, payload, { responseType: 'text' });
  assert.equal(result.data, sse);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'text/event-stream');
  assert.equal(requests[0].options.body, JSON.stringify(payload));
  assert.equal(remaining.length, 0);
});

test('unadapted pinned POST reproduces loss of SSE data', async () => {
  const { client } = await loadTransport([{ status: 200, body: sse }], false);
  const result = await client.post(endpoint, payload, { responseType: 'text' });
  assert.equal(JSON.stringify(result.data), '{}');
});

test('actual POST returns an explicitly accepted 409 as text with its status', async () => {
  const { client } = await loadTransport([{ status: 409, body: conflict }]);
  const result = await client.post(endpoint, payload, { responseType: 'text', validateStatus: (status: number) => status === 409 });
  assert.equal(result.status, 409);
  assert.equal(result.data, conflict);
  assert.equal(JSON.parse(result.data).error.name, 'IDEMPOTENCY_CONFLICT');
});

test('actual POST rejects a 409 when it is not explicitly accepted', async () => {
  const { client, requests } = await loadTransport([{ status: 409, body: conflict }]);
  await assert.rejects(client.post(endpoint, payload, { responseType: 'text' }), (error: any) => error.name === 'FetchError' && error.status === 409);
  assert.equal(requests.length, 1);
});

test('actual POST refreshes a 401 once and preserves URL intent, signal and SSE', async () => {
  const { client, requests, storage, remaining } = await loadTransport([
    { status: 401, body: JSON.stringify({ error: { status: 401 } }) },
    { status: 200, body: JSON.stringify({ data: { token: 'refreshed-token' } }) },
    { status: 200, body: sse, contentType: 'text/event-stream' },
  ]);
  const signal = new AbortController().signal;
  const result = await client.post(endpoint, payload, { responseType: 'text', signal });
  assert.equal(result.data, sse);
  assert.equal(result.status, 200);
  assert.deepEqual(requests.map(({ url }) => url), ['https://cms.invalid' + endpoint, 'https://cms.invalid/admin/access-token', 'https://cms.invalid' + endpoint]);
  assert.deepEqual([requests[0], requests[2]].map(({ options }) => new Headers(options.headers).get('Authorization')), ['Bearer initial-token', 'Bearer refreshed-token']);
  for (const { options } of [requests[0], requests[2]]) {
    assert.equal(options.body, JSON.stringify(payload));
    assert.equal(options.signal, signal);
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'include');
  }
  assert.equal(requests[1].options.credentials, 'include');
  assert.equal(storage.get('jwtToken'), JSON.stringify('refreshed-token'));
  assert.equal(remaining.length, 0);
});

test('default JSON POST retains the upstream payload, shape and error behavior', async () => {
  for (const adapted of [false, true]) {
    const { client } = await loadTransport([
      { status: 200, body: JSON.stringify({ data: { id: 42 } }) },
      { status: 400, body: JSON.stringify({ error: { status: 400, message: 'invalid payload' } }) },
    ], adapted);
    const result = await client.post('/upload/actions/bulk-delete', { fileIds: [42] });
    assert.equal(JSON.stringify(result), JSON.stringify({ data: { data: { id: 42 } } }));
    await assert.rejects(client.post('/upload/actions/bulk-delete', {}),
      (error: any) => error.name === 'FetchError' && error.status === 400 && error.message === 'invalid payload');
  }
});
