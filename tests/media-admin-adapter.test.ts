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
