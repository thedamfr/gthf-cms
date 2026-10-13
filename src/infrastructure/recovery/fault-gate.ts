import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

export type FaultPoint = 'after-journal' | 'after-object' | 'before-commit' | 'after-commit' | 'during-cleanup' | 'after-batch-child';
export type FaultContext = { key: string; attempt: string; objectIndex?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only the isolated VM can install gates. Requests cannot activate this code. */
export function createFaultGate(env: NodeJS.ProcessEnv = process.env) {
  const directory = env.GTHF_RECOVERY_FAULT_DIR;
  const campaignId = env.GTHF_RECOVERY_CAMPAIGN;
  if (!directory && !campaignId) return async (_point: FaultPoint, _context: FaultContext) => {};
  if (!directory || !path.isAbsolute(directory) || !UUID.test(campaignId || '')
    || env.DATABASE_NAME !== `gthf_recovery_${campaignId.replace(/-/g, '')}`
    || env.DATABASE_CLIENT !== 'postgres'
    || env.DATABASE_HOST !== 'postgres'
    || (env.DATABASE_PORT ?? '5432') !== '5432'
    || (env.DATABASE_SCHEMA ?? 'public') !== 'public'
    || env.GTHF_RECOVERY_NAMESPACE !== 'gthf-recovery'
    || env.DATABASE_URL || env.POSTGRESQL_ADDON_URI || env.POSTGRESQL_ADDON_HOST || env.POSTGRESQL_ADDON_DB || env.POSTGRESQL_ADDON_PORT
    || env.GTHF_RECOVERY_ISOLATED !== 'true') {
    throw new Error('Recovery fault gates require the isolated campaign and synthetic database');
  }
  let marker: any;
  try { marker = JSON.parse(readFileSync(path.join(directory, 'campaign.json'), 'utf8')); }
  catch { throw new Error('Recovery fault gates require the persistent isolated campaign marker'); }
  if (marker.campaignId !== campaignId || marker.databaseName !== env.DATABASE_NAME
    || marker.namespace !== env.GTHF_RECOVERY_NAMESPACE || marker.isolated !== true) {
    throw new Error('Recovery fault gate marker does not match the isolated campaign');
  }
  return async (point: FaultPoint, context: FaultContext) => {
    const gatePath = path.join(directory, 'gate.json');
    let gate: any;
    try { gate = JSON.parse(await fs.readFile(gatePath, 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    if (gate.campaignId !== campaignId || gate.key !== context.key || gate.point !== point
      || (gate.attempt !== undefined && gate.attempt !== context.attempt)
      || (gate.objectIndex !== undefined && gate.objectIndex !== context.objectIndex)) return;
    // Claim before publishing the observation: another process cannot enter this gate.
    try { await fs.rename(gatePath, path.join(directory, 'claimed.json')); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    const observed = { campaignId, point, ...context, pid: process.pid, at: new Date().toISOString() };
    const temporary = path.join(directory, `observed-${process.pid}.tmp`);
    const observation = await fs.open(temporary, 'w', 0o600);
    try {
      await observation.writeFile(JSON.stringify(observed));
      await observation.sync();
    } finally { await observation.close(); }
    await fs.rename(temporary, path.join(directory, 'observed.json'));
    const parent = await fs.open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    // The external controller performs a real process kill or VM power cut.
    // A release file allows the same gate to validate a successful control run.
    for (;;) {
      try {
        const release = JSON.parse(await fs.readFile(path.join(directory, 'release.json'), 'utf8'));
        if (release.campaignId === campaignId && release.key === context.key && release.point === point
          && release.attempt === context.attempt && release.objectIndex === context.objectIndex) {
          await fs.unlink(path.join(directory, 'release.json'));
          const parent = await fs.open(directory, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
          return;
        }
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}
