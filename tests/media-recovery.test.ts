import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { actorFor, operationKey } from '../src/infrastructure/recovery/engine';
import { existingObjects, prepareMedia, requestFingerprint, stableJSON } from '../src/infrastructure/recovery/prepare';
import { sha256 } from '../src/infrastructure/recovery/storage';
import { publicReceipt } from '../src/infrastructure/recovery/types';

const key = '22222222-2222-4222-8222-222222222222';
const attempt = '33333333-3333-4333-8333-333333333333';
test('one explicit intent is stable, while two new intents remain distinct for identical input', () => {
  assert.equal(operationKey(key.toUpperCase()), key);
  assert.notEqual(operationKey(), operationKey());
  assert.throws(() => operationKey('another/file'), /UUID/);
});
test('receipt ownership separates admin, users and API tokens and rejects anonymous HTTP', () => {
  assert.deepEqual(actorFor({ state: { userAbility: {}, user: { id: 4 } } }), { id: 'admin:4', adminUserId: 4 });
  assert.deepEqual(actorFor({ state: { user: { id: 4 } } }), { id: 'user:4' });
  assert.deepEqual(actorFor({ state: { auth: { strategy: { name: 'api-token' }, credentials: { id: 4 } } } }), { id: 'api-token:4' });
  assert.throws(() => actorFor({ state: {} }), /Authentication/);
});
test('public pending receipts expose neither journal manifests nor another actor identity', () => {
  const receipt = publicReceipt({ key, kind: 'upload', state: 'prepared', actor: 'admin:8', manifest: { internal: 'private-path' }, receipt: { unsafe: 'not committed' } } as any);
  assert.deepEqual(receipt, { key, kind: 'upload', status: 'pending', result: undefined, retryable: false, error: undefined });
});
test('fingerprints bind the bytes, metadata, destination and operation without global file deduplication', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gthf-fingerprint-'));
  try {
    const filepath = path.join(directory, 'file'); await fs.writeFile(filepath, 'first');
    const file = { filepath, originalFilename: 'test.txt', mimetype: 'text/plain' };
    const a = await requestFingerprint('upload', undefined, { b: 2, a: 1 }, [file]);
    assert.equal(a, await requestFingerprint('upload', undefined, { a: 1, b: 2 }, [file]));
    assert.notEqual(a, await requestFingerprint('replace', 1, { a: 1, b: 2 }, [file]));
    await fs.writeFile(filepath, 'other');
    assert.notEqual(a, await requestFingerprint('upload', undefined, { a: 1, b: 2 }, [file]));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('replacement preparation leaves old objects intact and describes all new immutable bytes before storage writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gthf-prepare-'));
  try {
    const filepath = path.join(directory, 'file'); await fs.writeFile(filepath, 'new body');
    let writes = 0;
    const storage = { key: (file) => file.hash + file.ext, url: (objectKey) => 'https://media.example/' + objectKey,
      put: async () => { writes++; }, remove: async () => { writes++; } };
    const original = { formatFileInfo: async ({ filename, type, size }, info) => ({ name: filename, mime: type, size: size / 1000, ext: '.txt', hash: 'random', ...info }) };
    const strapi = { config: { get: () => ({ provider: 'aws-s3' }) }, getModel: () => ({ attributes: Object.fromEntries(['name', 'mime', 'size', 'ext', 'hash', 'url', 'provider', 'provider_metadata', 'formats'].map((key) => [key, {}])) }),
      plugin: () => ({ service: (name) => name === 'image-manipulation' ? { isImage: async () => false } : { checkFileSize: async () => {} } }) };
    const old = { id: 42, hash: 'old-immutable', ext: '.txt', provider: 'aws-s3', updatedAt: '2026-10-13T00:00:00.000Z' };
    const { manifest, bodies } = await prepareMedia(strapi, original, storage as any, { key, attempt } as any, { fileInfo: {} }, [{ filepath, originalFilename: 'example.txt', mimetype: 'text/plain', size: 8 }], old);
    assert.equal(writes, 0);
    assert.deepEqual(manifest.obsolete, [{ key: 'old-immutable.txt' }]);
    assert.equal(manifest.files[0].targetId, 42);
    assert.notEqual(manifest.files[0].values.hash, old.hash);
    assert.equal(manifest.objects[0].sha256, sha256('new body'));
    assert.equal(bodies.get(manifest.objects[0].key)?.toString(), 'new body');
    assert.equal(JSON.stringify(manifest).includes(filepath), false);
    assert.equal(JSON.stringify(manifest).includes('tmpWorkingDirectory'), false);
    assert.equal(old.hash, 'old-immutable');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('cleanup never assumes ownership of media stored by a different provider', () => {
  const storage = { key: (file) => file.hash + file.ext } as any;
  assert.deepEqual(existingObjects({ hash: 'old', ext: '.jpg', provider: 'local' }, storage, 'aws-s3'), []);
});
test('canonical JSON preserves arrays ordering while ignoring absent optional fields', () => {
  assert.equal(stableJSON({ b: undefined, a: ['b', 'a'] }), '{"a":["b","a"]}');
});
