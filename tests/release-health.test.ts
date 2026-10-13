import assert from 'node:assert/strict';
import test from 'node:test';
import release from '../src/middlewares/release';

test('release health proves database access and returns only the serving revision', async () => {
  let reads = 0;
  const headers: Record<string, string> = {};
  const ctx = { path: '/api/release', method: 'GET', status: 0, body: undefined as unknown, set: (name: string, value: string) => { headers[name] = value; } };
  const handler = release({}, { strapi: { db: { connection: { raw: async () => { reads++; } } } } } as any);
  await handler(ctx as any, async () => assert.fail('release must handle this route'));
  assert.equal(reads, 1);
  assert.equal(ctx.status, 200);
  assert.deepEqual(ctx.body, { status: 'ok', revision: process.env.GTHF_REVISION || process.env.GTHDF_REVISION || 'development' });
  assert.match(headers['Cache-Control'], /no-store/);
});

test('release health returns an unavailable response without leaking database failures', async () => {
  const headers: Record<string, string> = {};
  const ctx = { path: '/api/release', method: 'GET', status: 0, body: undefined as unknown, set: (name: string, value: string) => { headers[name] = value; } };
  const handler = release({}, { strapi: { db: { connection: { raw: async () => { throw new Error('private database detail'); } } } } } as any);
  await handler(ctx as any, async () => assert.fail('release must handle this route'));
  assert.equal(ctx.status, 503);
  assert.deepEqual(ctx.body, { status: 'unavailable' });
  assert.match(headers['Cache-Control'], /no-store/);
});

test('release revision prefers GTHF and keeps the previous image variable readable', async () => {
  const original = { current: process.env.GTHF_REVISION, legacy: process.env.GTHDF_REVISION };
  const handler = release({}, { strapi: { db: { connection: { raw: async () => {} } } } } as any);
  const servingRevision = async () => {
    const ctx = { path: '/api/release', method: 'GET', set: () => {}, body: undefined as any };
    await handler(ctx as any, async () => assert.fail('release must handle this route'));
    return ctx.body.revision;
  };
  try {
    process.env.GTHDF_REVISION = 'legacy-image';
    process.env.GTHF_REVISION = 'renamed-image';
    assert.equal(await servingRevision(), 'renamed-image');
    delete process.env.GTHF_REVISION;
    assert.equal(await servingRevision(), 'legacy-image');
    delete process.env.GTHDF_REVISION;
    assert.equal(await servingRevision(), 'development');
  } finally {
    for (const [key, value] of [['GTHF_REVISION', original.current], ['GTHDF_REVISION', original.legacy]]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});
