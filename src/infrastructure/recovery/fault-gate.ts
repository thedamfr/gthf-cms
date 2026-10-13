import { promises as fs } from 'node:fs';
import path from 'node:path';

export type FaultPoint = 'after-journal' | 'after-object' | 'before-commit' | 'after-commit' | 'during-cleanup';
export type FaultContext = { key: string; attempt: string; objectIndex?: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only the isolated VM can install gates. Requests cannot activate this code. */
export function createFaultGate(env: NodeJS.ProcessEnv = process.env) {
  const directory = env.GTHF_RECOVERY_FAULT_DIR;
  const campaignId = env.GTHF_RECOVERY_CAMPAIGN;
  if (!directory && !campaignId) return async (_point: FaultPoint, _context: FaultContext) => {};
  if (!directory || !path.isAbsolute(directory) || !UUID.test(campaignId || '')
    || !/^gthf_recovery_[a-z0-9_]+$/.test(env.DATABASE_NAME || '')
    || env.GTHF_RECOVERY_ISOLATED !== 'true') {
    throw new Error('Recovery fault gates require the isolated campaign and synthetic database');
  }
  return async (point: FaultPoint, context: FaultContext) => {
    const gatePath = path.join(directory, 'gate.json');
    let gate: any;
    try { gate = JSON.parse(await fs.readFile(gatePath, 'utf8')); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    if (gate.campaignId !== campaignId || gate.key !== context.key || gate.point !== point
      || (gate.objectIndex !== undefined && gate.objectIndex !== context.objectIndex)) return;
    // Claim before publishing the observation: another process cannot enter this gate.
    try { await fs.rename(gatePath, path.join(directory, 'claimed.json')); }
    catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    const observed = { campaignId, point, ...context, pid: process.pid, at: new Date().toISOString() };
    const temporary = path.join(directory, `observed-${process.pid}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(observed), { mode: 0o600 });
    await fs.rename(temporary, path.join(directory, 'observed.json'));
    // The external controller performs a real process kill or VM power cut.
    // A release file allows the same gate to validate a successful control run.
    for (;;) {
      try {
        const release = JSON.parse(await fs.readFile(path.join(directory, 'release.json'), 'utf8'));
        if (release.campaignId === campaignId && release.key === context.key && release.point === point) return;
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}
