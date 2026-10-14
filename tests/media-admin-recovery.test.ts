import assert from 'node:assert/strict';
import test from 'node:test';
import { executeIntent, intentFromForm, MediaIntent, PendingMediaError, safeMediaPath } from '../src/admin/recovery/client-core';
const key = '22222222-2222-4222-8222-222222222222';
const makeIntent = (): MediaIntent => ({ key, owner: 'admin:4', path: '/upload', method: 'POST', shape: 'array', files: [], fields: [], status: 'pending', createdAt: '2026-10-13T00:00:00Z' });
function clock() { let now = 0; return { now: () => now, sleep: async () => { now += 1000; }, maxMs: 2500 }; }
test('a lost success response reads its receipt instead of repeating the write', async () => {
  const keys = []; const states = [];
  const result = await executeIntent(makeIntent(), { ...clock(), transport: async (sent) => { keys.push(sent); throw new Error('connection lost'); },
    receipt: async () => ({ key, status: 'committed', result: [{ id: 42 }] }), save: (intent) => states.push(intent.status) });
  assert.deepEqual(result, [{ id: 42 }]); assert.deepEqual(keys, [key]); assert.equal(states.at(-1), 'committed');
});
test('pending then interrupted replay uses the same identity and preserves the result shape', async () => {
  const keys = []; let reads = 0;
  const intent = makeIntent(); intent.shape = 'single';
  const result = await executeIntent(intent, { ...clock(), transport: async (sent) => { keys.push(sent); if (keys.length === 1) throw new Error('CMS crashed'); return { id: 7 }; },
    receipt: async () => ({ key, status: ++reads === 1 ? 'pending' : 'interrupted' }), save: () => {} });
  assert.deepEqual(result, { id: 7 }); assert.deepEqual(keys, [key, key]);
});
test('an unavailable receipt service never authorises a second write', async () => {
  let writes = 0;
  await assert.rejects(executeIntent(makeIntent(), { ...clock(), transport: async () => { writes++; throw new Error('unknown outcome'); },
    receipt: async () => { throw new Error('DB down'); }, save: () => {} }), PendingMediaError);
  assert.equal(writes, 1);
});
test('losing permission preserves the unresolved intent for later authorised consultation', async () => {
  const intent = makeIntent(); let reads = 0;
  await assert.rejects(executeIntent(intent, { ...clock(), transport: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); },
    receipt: async () => { reads++; return null; }, save: () => {} }), /forbidden/);
  assert.equal(intent.status, 'pending'); assert.equal(reads, 0);
});
test('a reused key with different bytes is never converted into the older successful result', async () => {
  const intent = makeIntent(); let reads = 0; const stored: MediaIntent[] = [];
  await assert.rejects(executeIntent(intent, { ...clock(), transport: async () => { throw Object.assign(new Error('different bytes'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' }); },
    receipt: async () => { reads++; return { key, status: 'committed', result: [{ id: 1 }] }; }, save: (value) => stored.push(structuredClone(value)) }), /different bytes/);
  assert.equal(reads, 0);
  assert.equal(stored.at(-1)?.status, 'failed');
  assert.equal(stored.at(-1)?.message, 'IDEMPOTENCY_CONFLICT');
});
test('explicit server failure stays failed and cannot be retried automatically', async () => {
  const intent = makeIntent(); let writes = 0;
  await assert.rejects(executeIntent(intent, { ...clock(), transport: async () => { writes++; throw new Error('unknown'); },
    receipt: async () => ({ key, status: 'failed', error: 'MEDIA_CHANGED' }), save: () => {} }), /ne peut pas/);
  assert.equal(intent.status, 'failed'); assert.equal(writes, 1);
});
test('an aborted selection that was never sent remains safely resumable', async () => {
  const intent = makeIntent(); let writes = 0;
  await assert.rejects(executeIntent(intent, { ...clock(), signal: AbortSignal.abort(), transport: async () => { writes++; },
    receipt: async () => null, save: () => {} }), PendingMediaError);
  assert.equal(writes, 0); assert.equal(intent.status, 'interrupted');
});
test('failure to persist the UUID prevents the first write', async () => {
  let writes = 0;
  await assert.rejects(executeIntent(makeIntent(), { ...clock(), transport: async () => { writes++; }, receipt: async () => null,
    save: () => { throw new Error('session storage unavailable'); } }), /session storage/);
  assert.equal(writes, 0);
});
test('pending metadata stores neither bytes nor credentials and rejects a foreign replay endpoint', () => {
  const formData = new FormData(); formData.append('files', new File(['private bytes'], 'private.txt', { type: 'text/plain' }));
  formData.append('fileInfo', '{"name":"private.txt"}');
  const intent = intentFromForm({ key, owner: 'admin:4', path: '/upload', shape: 'array', formData });
  assert.equal(JSON.stringify(intent).includes('private bytes'), false);
  assert.deepEqual(intent.files, [{ name: 'private.txt', size: 13, type: 'text/plain' }]);
  assert.equal(safeMediaPath('/upload?id=3', 'https://cms.example'), '/upload?id=3');
  assert.throws(() => safeMediaPath('https://attacker.example/upload', 'https://cms.example'), /endpoint/);
  assert.throws(() => safeMediaPath('/admin/users', 'https://cms.example'), /endpoint/);
});
