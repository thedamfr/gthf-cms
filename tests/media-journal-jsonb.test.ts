import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaJournal } from '../src/infrastructure/recovery/journal';
import { publicReceipt } from '../src/infrastructure/recovery/types';

const key = '11111111-1111-4111-8111-111111111111';
const manifest = { files: [{ values: { name: 'fixture' } }], objects: [{ key: 'immutable.txt' }], obsolete: [] };
const receipt = [{ id: 42, name: 'fixture' }];
// Match Strapi's PostgreSQL dialect: JSONB is returned as text, including
// RETURNING rows. This is deliberately different from node-pg's default parser.
function database(row: any) {
  const connection: any = () => {
    const query: any = {};
    for (const name of ['where', 'whereIn', 'andWhere', 'orderBy', 'forUpdate', 'skipLocked', 'insert', 'onConflict', 'ignore', 'update']) {
      query[name] = () => query;
    }
    query.first = async () => row ? { ...row } : undefined;
    query.returning = async (field: string) => field === 'key' ? [] : [{ ...row }];
    return query;
  };
  connection.raw = () => 'test SQL expression';
  connection.fn = { now: () => 'test current time' };
  connection.transaction = async (action) => action(connection);
  return { db: { connection } };
}
const row = { key, actor: 'admin:4', kind: 'upload', request_hash: 'same', target_id: null, state: 'committed',
  manifest: JSON.stringify(manifest), receipt: JSON.stringify(receipt), failure: null };

test('a durable receipt read through Strapi JSONB text returns the committed files', async () => {
  const journal = new MediaJournal(database(row));
  const operation = await journal.getOwned(key, 'admin:4');
  assert.deepEqual(operation.manifest, manifest);
  assert.deepEqual(publicReceipt(operation).result, receipt);
  const replay = await journal.begin({ key, actor: { id: 'admin:4' }, kind: 'upload', requestHash: 'same' });
  assert.equal(replay.acquired, false);
  assert.deepEqual(replay.operation.receipt, receipt);
});
test('lease validation and takeover decode a prepared manifest before recovery', async () => {
  const journal = new MediaJournal(database({ ...row, state: 'prepared', receipt: null }));
  assert.deepEqual((await journal.assertLease({ key, attempt: key, lease_owner: key })).manifest.files, manifest.files);
  assert.deepEqual((await journal.claimExpired(key))?.manifest.objects, manifest.objects);
});
test('cleanup claims decode the durable object list and preserve legacy native values', async () => {
  const journal = new MediaJournal(database({ id: key, objects: JSON.stringify(manifest.objects) }));
  assert.deepEqual((await journal.claimCleanup()).objects, manifest.objects);
  const native = new MediaJournal(database({ ...row, manifest, receipt }));
  assert.deepEqual((await native.get(key)).receipt, receipt);
  assert.equal(await new MediaJournal(database(undefined)).get(key), undefined);
});
