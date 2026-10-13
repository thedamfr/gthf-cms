import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFaultGate } from '../src/infrastructure/recovery/fault-gate';

const campaign = '11111111-1111-4111-8111-111111111111';
const databaseName = `gthf_recovery_${campaign.replace(/-/g, '')}`;
const campaignMarker = { campaignId: campaign, databaseName, namespace: 'gthf-recovery', isolated: true };
const campaignEnv = (directory: string) => ({ GTHF_RECOVERY_CAMPAIGN: campaign, GTHF_RECOVERY_FAULT_DIR: directory, GTHF_RECOVERY_ISOLATED: 'true', GTHF_RECOVERY_NAMESPACE: 'gthf-recovery', DATABASE_CLIENT: 'postgres', DATABASE_HOST: 'postgres', DATABASE_PORT: '5432', DATABASE_SCHEMA: 'public', DATABASE_NAME: databaseName });
const key = '22222222-2222-4222-8222-222222222222';
test('fault gates are inert without a campaign and refuse a production database', async () => {
  await createFaultGate({})('after-journal', { key, attempt: key });
  assert.throws(() => createFaultGate({ GTHF_RECOVERY_CAMPAIGN: campaign, GTHF_RECOVERY_FAULT_DIR: '/tmp/gates', GTHF_RECOVERY_ISOLATED: 'true', DATABASE_NAME: 'gthdf' }), /synthetic database/);
  assert.throws(() => createFaultGate({ GTHF_RECOVERY_CAMPAIGN: campaign, GTHF_RECOVERY_FAULT_DIR: '/tmp/gates', DATABASE_NAME: 'gthf_recovery_test' }), /isolated campaign/);
});
test('a gate requires exact campaign, operation and point and is claimed only once', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gthf-fault-gate-'));
  try {
    await fs.writeFile(path.join(directory, 'campaign.json'), JSON.stringify(campaignMarker));
    const gate = createFaultGate(campaignEnv(directory));
    await fs.writeFile(path.join(directory, 'gate.json'), JSON.stringify({ campaignId: campaign, key, point: 'after-object', objectIndex: 1 }));
    await gate('after-journal', { key, attempt: key });
    await gate('after-object', { key, attempt: key, objectIndex: 0 });
    assert.equal(await fs.stat(path.join(directory, 'observed.json')).catch(() => null), null);
    await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify({ campaignId: campaign, key, point: 'after-object', attempt: key, objectIndex: 1 }));
    await gate('after-object', { key, attempt: key, objectIndex: 1 });
    assert.equal(await fs.stat(path.join(directory, 'release.json')).catch(() => null), null);
    const observed = JSON.parse(await fs.readFile(path.join(directory, 'observed.json'), 'utf8'));
    assert.deepEqual({ ...observed, pid: undefined, at: undefined }, { campaignId: campaign, key, point: 'after-object', attempt: key, objectIndex: 1, pid: undefined, at: undefined });
    await gate('after-object', { key, attempt: key, objectIndex: 1 });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('fault gates refuse missing, mismatched markers, namespace and connection overrides', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gthf-fault-guard-'));
  try {
    assert.throws(() => createFaultGate(campaignEnv(directory)), /persistent isolated campaign marker/);
    for (const marker of [
      { ...campaignMarker, campaignId: key }, { ...campaignMarker, databaseName: 'gthdf' },
      { ...campaignMarker, namespace: 'gthf-staging' }, { ...campaignMarker, isolated: false },
    ]) {
      await fs.writeFile(path.join(directory, 'campaign.json'), JSON.stringify(marker));
      assert.throws(() => createFaultGate(campaignEnv(directory)), /marker does not match/);
    }
    await fs.writeFile(path.join(directory, 'campaign.json'), JSON.stringify(campaignMarker));
    for (const override of [
      { GTHF_RECOVERY_NAMESPACE: 'gthf-staging' }, { DATABASE_NAME: 'gthf_recovery_other' },
      { DATABASE_URL: 'postgres://example.invalid/other' }, { POSTGRESQL_ADDON_URI: 'postgres://example.invalid/other' },
      { DATABASE_HOST: 'database.example.invalid' }, { DATABASE_HOST: '127.0.0.1' }, { DATABASE_PORT: '5433' }, { DATABASE_SCHEMA: 'private' },
      { POSTGRESQL_ADDON_PORT: '5433' }, { POSTGRESQL_ADDON_DB: 'other' }, { POSTGRESQL_ADDON_HOST: 'example.invalid' },
    ]) assert.throws(() => createFaultGate({ ...campaignEnv(directory), ...override }), /synthetic database/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
