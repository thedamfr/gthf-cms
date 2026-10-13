import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFaultGate } from '../src/infrastructure/recovery/fault-gate';

const campaign = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
test('fault gates are inert without a campaign and refuse a production database', async () => {
  await createFaultGate({})('after-journal', { key, attempt: key });
  assert.throws(() => createFaultGate({ GTHF_RECOVERY_CAMPAIGN: campaign, GTHF_RECOVERY_FAULT_DIR: '/tmp/gates', GTHF_RECOVERY_ISOLATED: 'true', DATABASE_NAME: 'gthdf' }), /synthetic database/);
  assert.throws(() => createFaultGate({ GTHF_RECOVERY_CAMPAIGN: campaign, GTHF_RECOVERY_FAULT_DIR: '/tmp/gates', DATABASE_NAME: 'gthf_recovery_test' }), /isolated campaign/);
});
test('a gate requires exact campaign, operation and point and is claimed only once', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gthf-fault-gate-'));
  try {
    const gate = createFaultGate({ GTHF_RECOVERY_CAMPAIGN: campaign, GTHF_RECOVERY_FAULT_DIR: directory, GTHF_RECOVERY_ISOLATED: 'true', DATABASE_NAME: 'gthf_recovery_test' });
    await fs.writeFile(path.join(directory, 'gate.json'), JSON.stringify({ campaignId: campaign, key, point: 'after-object', objectIndex: 1 }));
    await gate('after-journal', { key, attempt: key });
    await gate('after-object', { key, attempt: key, objectIndex: 0 });
    assert.equal(await fs.stat(path.join(directory, 'observed.json')).catch(() => null), null);
    await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify({ campaignId: campaign, key, point: 'after-object' }));
    await gate('after-object', { key, attempt: key, objectIndex: 1 });
    const observed = JSON.parse(await fs.readFile(path.join(directory, 'observed.json'), 'utf8'));
    assert.deepEqual({ ...observed, pid: undefined, at: undefined }, { campaignId: campaign, key, point: 'after-object', attempt: key, objectIndex: 1, pid: undefined, at: undefined });
    await gate('after-object', { key, attempt: key, objectIndex: 1 });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
