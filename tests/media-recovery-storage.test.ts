import assert from 'node:assert/strict';
import test from 'node:test';
import { S3Client, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createRecoveryStorage, sha256 } from '../src/infrastructure/recovery/storage';

const config = () => ({ provider: 'aws-s3', providerOptions: { rootPath: 'old root/', s3Options: { region: 'us-east-1', params: { Bucket: 'synthetic' } } } });
test('legacy S3 cleanup uses the exact key computed by the pinned provider', async () => {
  const original = S3Client.prototype.send;
  const keys: string[] = [];
  S3Client.prototype.send = (async (command: any) => { keys.push(command.input.Key); return {}; }) as any;
  const recovery = createRecoveryStorage(config());
  try {
    const provider = require('@strapi/provider-upload-aws-s3').init(config().providerOptions);
    for (const file of [
      { path: 'campaign 2026/a+b', hash: 'image é (1)', ext: '.jpg' },
      { path: '/a//../b/', hash: '../sub//x', ext: '.p-n_g' },
    ]) {
      await provider.delete(file);
      assert.equal(recovery.key(file), keys.pop());
    }
  } finally { recovery.close(); S3Client.prototype.send = original; }
});
test('cleanup preserves conflicting foreign objects and deletes only an exact owned object', async () => {
  const original = S3Client.prototype.send;
  let foreign = true; let deleted = false; let deletes = 0;
  const bytes = Buffer.from('owned');
  const object = { key: 'immutable-key', sha256: sha256(bytes), bytes: bytes.length };
  S3Client.prototype.send = (async (command: any) => {
    if (command instanceof DeleteObjectCommand) { deletes++; deleted = true; return {}; }
    assert.ok(command instanceof HeadObjectCommand);
    if (deleted) throw Object.assign(new Error('absent'), { $metadata: { httpStatusCode: 404 } });
    return { Metadata: { gthfsha256: foreign ? 'another-operation' : object.sha256 }, ContentLength: bytes.length };
  }) as any;
  const recovery = createRecoveryStorage(config());
  try {
    await recovery.remove(object); assert.equal(deletes, 0);
    foreign = false;
    await recovery.remove(object); assert.equal(deletes, 1);
    await recovery.remove(object); assert.equal(deletes, 1);
  } finally { recovery.close(); S3Client.prototype.send = original; }
});
test('a conditional PUT conflict is accepted only for the same immutable bytes', async () => {
  const original = S3Client.prototype.send;
  const bytes = Buffer.from('owned'); const object = { key: 'immutable', sha256: sha256(bytes), bytes: bytes.length };
  let matching = true;
  S3Client.prototype.send = (async (command: any) => {
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfNoneMatch, '*');
      throw Object.assign(new Error('already exists'), { $metadata: { httpStatusCode: 412 } });
    }
    return { Metadata: { gthfsha256: matching ? object.sha256 : 'foreign' }, ContentLength: bytes.length };
  }) as any;
  const recovery = createRecoveryStorage(config());
  try {
    await recovery.put(object, bytes);
    matching = false;
    await assert.rejects(recovery.put(object, bytes), (error: any) => error.code === 'OBJECT_CONFLICT');
  } finally { recovery.close(); S3Client.prototype.send = original; }
});
