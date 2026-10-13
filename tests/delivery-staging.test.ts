import assert from 'node:assert/strict';
import test from 'node:test';
import { requireStagingTarget, requireStagingReadToken, stagingMediaUrl, editableColumns, isCompletedMediaCopy, initialExampleTokens } from '../scripts/prepare-delivery-staging.mjs';

const staging = {
  GTHF_NAMESPACE: 'gthf-qualification', DATABASE_HOST: 'gthf-postgres', DATABASE_CLIENT: 'postgres',
  AWS_BUCKET: 'gthf-staging-media-bis', AWS_ENDPOINT: 'https://s3.gra.io.cloud.ovh.net',
};

test('data preparation refuses production, connection overrides and an unexpected bucket', () => {
  requireStagingTarget(staging);
  for (const override of [
    { GTHF_NAMESPACE: 'gthf-staging' }, { GTHF_NAMESPACE: 'gthdf-staging' }, { DATABASE_URL: 'postgres://elsewhere' },
    { POSTGRESQL_ADDON_HOST: 'production' }, { AWS_BUCKET: 'gthdf-staging-media' },
    { CELLAR_ADDON_HOST: 'production-cellar.example' },
  ]) assert.throws(() => requireStagingTarget({ ...staging, ...override }));
});

test('renamed staging accepts the legacy variable without allowing a production override', () => {
  const legacy = { ...staging, GTHF_NAMESPACE: undefined, GTHDF_NAMESPACE: 'gthdf-qualification', DATABASE_HOST: 'gthdf-postgres' };
  assert.doesNotThrow(() => requireStagingTarget(legacy));
  assert.doesNotThrow(() => requireStagingTarget({ ...legacy, GTHDF_NAMESPACE: 'gthf-qualification', DATABASE_HOST: 'gthf-postgres' }));
  assert.throws(() => requireStagingTarget({ ...legacy, GTHF_NAMESPACE: 'gthf-staging' }));
  assert.throws(() => requireStagingTarget({ ...legacy, DATABASE_HOST: 'production.example' }));
});

test('data preparation requires PostgreSQL explicitly', () => {
  assert.throws(() => requireStagingTarget({ ...staging, DATABASE_CLIENT: 'sqlite' }));
  assert.throws(() => requireStagingTarget({ ...staging, DATABASE_CLIENT: undefined }));
});

test('resuming requires an unchanged, read-only content token without expiration', () => {
  const token = { accessKey: 'test-hash', type: 'read-only', kind: 'content-api', lifespan: null, expiresAt: null };
  requireStagingReadToken(token, 'test-hash');
  for (const override of [
    { accessKey: 'changed' }, { type: 'full-access' }, { type: 'custom' },
    { kind: 'admin' }, { lifespan: 3600000 }, { expiresAt: '2030-01-01T00:00:00.000Z' },
  ]) assert.throws(() => requireStagingReadToken({ ...token, ...override }, 'test-hash'));
});

test('initial seeding removes default example tokens without touching later configured access', () => {
  const examples = [{ id: 1, name: 'Read Only', type: 'read-only' }, { id: 2, name: 'Full Access', type: 'full-access' }];
  const dedicated = { id: 3, name: 'gthdf-staging-read', type: 'read-only' };
  assert.deepEqual(initialExampleTokens([], [...examples, dedicated]), examples);
  assert.deepEqual(initialExampleTokens([{ id: 1 }], examples), []);
});

test('a resumed import reuses objects marked with the completed source checksum', () => {
  assert.equal(isCompletedMediaCopy({ ContentLength: 42, Metadata: { 'gthdf-source-sha256': 'a'.repeat(64) } }), true);
  assert.equal(isCompletedMediaCopy({ ContentLength: 42, Metadata: {} }), false);
  assert.equal(isCompletedMediaCopy({ ContentLength: 0, Metadata: { 'gthdf-source-sha256': 'a'.repeat(64) } }), false);
});

test('URL migration only targets writable base tables, including when PostGIS views expose text columns', () => {
  const fileUrl = { table_name: 'files', column_name: 'url', table_type: 'BASE TABLE' };
  const postgisView = { table_name: 'geometry_columns', column_name: 'f_table_name', table_type: 'VIEW' };
  assert.deepEqual(editableColumns([fileUrl, postgisView]), [fileUrl]);
});

test('media rewriting preserves the object key and refuses unrelated origins or credentials', () => {
  const expected = 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net/chapter_123.gpx';
  assert.equal(stagingMediaUrl('https://gthdf-staging-media.s3.eu-west-par.io.cloud.ovh.net/chapter_123.gpx'), expected);
  assert.equal(stagingMediaUrl(expected), expected);
  for (const unsafe of ['http://127.0.0.1/private', 'https://other.example/file', 'https://key@gthdf-staging-media.s3.eu-west-par.io.cloud.ovh.net/file']) {
    assert.throws(() => stagingMediaUrl(unsafe));
  }
});
