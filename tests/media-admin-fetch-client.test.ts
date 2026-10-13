import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import * as core from '../src/admin/recovery/client-core';

async function realClients(responses: { status: number; body: any }[]) {
  const root = path.dirname(require.resolve('@strapi/admin/package.json'));
  const source = fs.readFileSync(path.join(root, 'dist/admin/admin/src/utils/getFetchClient.mjs'), 'utf8');
  const compiled = await transform(source, { loader: 'js', format: 'cjs' });
  const module = { exports: {} as any }; const calls: string[] = [];
  runInNewContext(compiled.code, { module, exports: module.exports, Headers, FormData, Error,
    localStorage: { getItem: () => null }, window: { strapi: { backendURL: 'https://cms.invalid' } },
    require: (name) => name === './cookies.mjs' ? { getCookieValue: () => null } : require(name),
    fetch: async (url) => { calls.push(url); const next = responses.shift(); assert.ok(next); return new Response(JSON.stringify(next.body), { status: next.status }); },
  });
  const clientSource = await transform(fs.readFileSync(path.join(process.cwd(), 'src/admin/recovery/client.ts'), 'utf8'), { loader: 'ts', format: 'cjs' });
  const clientModule = { exports: {} as any };
  runInNewContext(clientSource.code, { module: clientModule, exports: clientModule.exports, AbortSignal,
    require: (name) => name === '@strapi/admin/strapi-admin' ? module.exports : core });
  return { fetchReceipt: clientModule.exports.fetchReceipt, client: module.exports.getFetchClient(), calls };
}
const key = '22222222-2222-4222-8222-222222222222';
const intent = (): core.MediaIntent => ({ key, owner: 'admin:4', path: '/upload', method: 'POST', shape: 'array', files: [], fields: [], status: 'pending', createdAt: '2026-10-13' });
const failure = (status: number, name: string) => ({ status, body: { data: null, error: { status, name, message: name } } });

test('actual Strapi FetchError404 allows the same intent to retry a request never received', async () => {
  const clients = await realClients([failure(404, 'OPERATION_NOT_FOUND')]);
  const keys: string[] = []; let clock = 0;
  const result = await core.executeIntent(intent(), { receipt: clients.fetchReceipt, save() {},
    transport: async (key) => { keys.push(key); if (keys.length === 1) throw new Error('connection reset'); return [{ id: 7 }]; },
    now: () => clock, sleep: async () => { clock += 1000; }, maxMs: 2000 });
  assert.deepEqual(result, [{ id: 7 }]);
  assert.deepEqual(keys, [key, key]); assert.equal(clients.calls.length, 1);
});
test('actual Strapi numeric FetchError code does not make OPERATION_PENDING terminal', async () => {
  const clients = await realClients([failure(409, 'OPERATION_PENDING'), { status: 200, body: { key, status: 'committed', result: { id: 7 } } }]);
  const value = intent(); value.shape = 'single';
  const result = await core.executeIntent(value, { receipt: clients.fetchReceipt, save() {},
    transport: () => clients.client.post('/upload?id=7', new FormData()), maxMs: 2000 });
  assert.equal(result.id, 7); assert.equal(value.status, 'committed'); assert.equal(clients.calls.length, 2);
});
test('actual Strapi payload conflict persists failed with its named code and never reads another receipt', async () => {
  const clients = await realClients([failure(409, 'IDEMPOTENCY_CONFLICT')]);
  const value = intent(); const saved: string[] = [];
  await assert.rejects(core.executeIntent(value, { receipt: clients.fetchReceipt, save: (item) => saved.push(item.status),
    transport: () => clients.client.post('/upload', new FormData()) }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(value.message, 'IDEMPOTENCY_CONFLICT'); assert.equal(saved.at(-1), 'failed'); assert.equal(clients.calls.length, 1);
});
