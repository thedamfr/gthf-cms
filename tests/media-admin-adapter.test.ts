import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { transform } from 'esbuild';
import { adaptAdminUpload, ADMIN_CONTRACTS } from '../scripts/recovery/admin-adapter';

const root = path.join(path.dirname(require.resolve('@strapi/upload/package.json')), 'dist/admin');
for (const name of Object.keys(ADMIN_CONTRACTS)) {
  test(`reviewed admin adaptation parses and refuses changed upstream: ${name}`, async () => {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    const adapted = adaptAdminUpload(source, name);
    assert.notEqual(adapted, source);
    await transform(adapted, { loader: 'js', format: 'esm' });
    assert.throws(() => adaptAdminUpload(source + '\n', name), /Unreviewed/);
  });
}
test('XHR identity survives the authentication refresh and reports a conflicting payload', () => {
  const code = adaptAdminUpload(fs.readFileSync(path.join(root, 'future/services/uploadFileViaXHR.mjs'), 'utf8'), 'future/services/uploadFileViaXHR.mjs');
  assert.match(code, /sendUploadViaXHR\(url, refreshedToken, formData, signal, onProgress, idempotencyKey\)/);
  assert.match(code, /code: recoveryCode/);
  assert.match(code, /xhr\.ontimeout/);
});

async function executeTransport(responses: { status: number; body: any }[]) {
  const { runInNewContext } = await import('node:vm');
  const sent: { headers: Record<string, string>; timeout: number }[] = [];
  class XHR {
    headers: Record<string, string> = {}; timeout = 0; status = 0; responseText = ''; upload = {}; onload?: () => void;
    open() {} setRequestHeader(key: string, value: string) { this.headers[key] = value; }
    send() {
      sent.push({ headers: this.headers, timeout: this.timeout });
      const next = responses.shift()!; this.status = next.status; this.responseText = JSON.stringify(next.body);
      queueMicrotask(() => this.onload!());
    }
    abort() {}
  }
  const name = 'future/services/uploadFileViaXHR.mjs';
  const source = adaptAdminUpload(fs.readFileSync(path.join(root, name), 'utf8'), name);
  const compiled = await transform(source, { loader: 'js', format: 'cjs' });
  const module = { exports: {} as any };
  runInNewContext(compiled.code, { module, exports: module.exports, XMLHttpRequest: XHR,
    require: () => ({ attemptTokenRefresh: async () => 'refreshed-token' }) });
  return { transport: module.exports.uploadFileViaXHR, sent };
}
test('actual transformed XHR resends the same intent after an authentication refresh', async () => {
  const { transport, sent } = await executeTransport([{ status: 401, body: {} }, { status: 200, body: { id: 42 } }]);
  const key = '22222222-2222-4222-8222-222222222222';
  const result = await transport('https://cms.example/upload', 'initial-token', new FormData(), new AbortController().signal, () => {}, key);
  assert.equal(result.id, 42);
  assert.deepEqual(sent.map((request) => request.headers['Idempotency-Key']), [key, key]);
  assert.deepEqual(sent.map((request) => request.headers.Authorization), ['Bearer initial-token', 'Bearer refreshed-token']);
  assert.deepEqual(sent.map((request) => request.timeout), [30000, 30000]);
});
test('actual transformed XHR exposes a server payload conflict to the retry decision', async () => {
  const { transport } = await executeTransport([{ status: 409, body: { error: { name: 'IDEMPOTENCY_CONFLICT', message: 'payload differs' } } }]);
  await assert.rejects(transport('https://cms.example/upload', 'token', new FormData(), new AbortController().signal, () => {}, 'key'),
    (error: any) => error.status === 409 && error.code === 'IDEMPOTENCY_CONFLICT');
});
