import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const CMS = 'http://127.0.0.1:33137';
const MEDIA = 'http://127.0.0.1:33190';
const ROOT = '/home/ubuntu/.local/state/infra-sincere/qualification-vm';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const { values } = parseArgs({ options: { manifest: { type: 'string' }, campaign: { type: 'string' } } });
process.umask(0o077);
function privateFile(file) {
  assert.ok(path.isAbsolute(file));
  assert.equal(realpathSync(file), file);
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o077, 0);
  return JSON.parse(readFileSync(file, 'utf8'));
}
assert.match(values.campaign || '', UUID, 'An explicit campaign UUID is required');
const manifest = privateFile(values.manifest || '');
assert.equal(manifest.consumer, 'gthf'); assert.equal(manifest.target, 'vm');
assert.equal(manifest.namespace, 'gthf-recovery');
assert.equal(manifest.vm.uuid, values.campaign);
assert.equal(manifest.vm.hostname, 'infra-qualification-vm');
assert.equal(manifest.vm.host, 'game-prod-ovh-gra');
assert.match(manifest.runId, /^gthf-recovery-[a-z0-9-]{1,64}$/);
assert.equal(manifest.database, 'gthf_recovery_' + values.campaign.replaceAll('-', ''));
assert.equal(manifest.bucket, 'gthf-recovery-' + values.campaign);
assert.match(manifest.sourceRevisions.cms, SHA);
assert.equal(manifest.images.cms.revision, manifest.sourceRevisions.cms);
const campaignRoot = path.join(ROOT, manifest.runId);
assert.equal(path.dirname(values.manifest), campaignRoot);
assert.equal(realpathSync(campaignRoot), campaignRoot);
assert.equal(lstatSync(campaignRoot).mode & 0o077, 0);
const credentials = privateFile(path.join(campaignRoot, 'credentials.json'));
assert.ok(typeof credentials.RECOVERY_ADMIN_PASSWORD === 'string' && credentials.RECOVERY_ADMIN_PASSWORD.length >= 20);
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'Run a committed clean browser candidate');
const directory = path.join(campaignRoot, 'media-admin-' + new Date().toISOString().replaceAll(':', '-'));
await fs.mkdir(directory, { mode: 0o700 });
const report = { status: 'running', campaignId: values.campaign, sourceRevision, cmsRevision: manifest.sourceRevisions.cms,
  cmsDigest: manifest.images.cms.digest, checkedAt: new Date().toISOString(), scenarios: [], limits: [
    'Browser transport loss is simulated with Playwright; this command performs no SIGKILL or VM power cut.',
    'Only the isolated MinIO origin is remapped to its loopback tunnel for browser media display.',
    'Created synthetic media remain in the campaign for cross-checking and final isolated cleanup.',
  ] };
let browser; let context; let page; let tracing = false; let step = 'identity and readiness';
let routeFailure;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (routeFailure) throw routeFailure; const value = await read(); if (predicate(value)) return value; await pause(200); }
  throw new Error('Golden Journey condition timed out');
}
let mode = 'normal'; let intercepted = false; let blockReceipts = false;
let capturedCommit; const requests = []; const receiptRequests = [];
try {
  const health = await fetch(CMS + '/api/release', { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).revision, report.cmsRevision, 'The tunnel must serve the exact manifest CMS revision');
  const { chromium } = await import('/home/ubuntu/.local/share/agent-web-tools/node_modules/playwright/index.mjs');
  browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  context = await browser.newContext({ locale: 'en-US', viewport: { width: 1360, height: 980 } });
  // Preserve the browser's actual multipart request without reconstructing its
  // body through route.fetch. Reject only after its real successful response,
  // before the admin client can read the acknowledgment.
  await context.addInitScript(({ origin }) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (options?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const hide = window.__gthfLoseNextUpload && url.origin === origin
        && method === 'POST' && /^\/upload(?:\/files)?$/.test(url.pathname);
      if (hide) window.__gthfLoseNextUpload = false;
      const response = await nativeFetch(input, options);
      if (hide) {
        window.__gthfHiddenUpload = { status: response.status, body: await response.clone().json() };
        if (response.ok) throw new TypeError('Synthetic response loss after successful media commit');
      }
      return response;
    };
  }, { origin: CMS });
  const handleRoute = async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === 'http://minio:9000' && url.pathname.startsWith('/' + manifest.bucket + '/')) {
      return route.continue({ url: MEDIA + url.pathname + url.search });
    }
    if (url.origin !== CMS) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/upload/recovery/operations/')) {
      receiptRequests.push(url.pathname.split('/').at(-1));
      if (blockReceipts) return route.abort('connectionreset');
    }
    if (request.method() === 'POST' && /^\/upload(?:\/files)?$/.test(url.pathname)) {
      const key = request.headers()['idempotency-key'];
      assert.match(key || '', UUID, 'A real admin mutation must carry its saved identity');
      requests.push({ key, mode });
      if (!intercepted && mode === 'before-send') { intercepted = true; return route.abort('connectionreset'); }

    }
    return route.continue();
  };
  await context.route('**/*', async (route) => {
    try { await handleRoute(route); }
    catch (error) {
      routeFailure = error;
      await route.abort('failed').catch(() => {});
    }
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  step = 'synthetic admin login';
  await page.goto(CMS + '/admin/auth/login');
  await page.getByLabel(/email/i).fill('recovery@gthf.invalid');
  await page.getByLabel(/password/i).fill(credentials.RECOVERY_ADMIN_PASSWORD);
  await page.getByRole('button', { name: /log\s*in|se connecter/i }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/admin') && !url.pathname.includes('/auth/'));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false }); tracing = true;
  const filename = 'recovery-browser-' + randomUUID() + '.png';
  const fixture = path.join(directory, filename);
  // Every intentional selection below uses identical generated bytes and name.
  const sharp = (await import('sharp')).default;
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#4263eb' } }).png().toBuffer();
  await fs.writeFile(fixture, bytes, { mode: 0o600 });
  const intents = () => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('gthf-media-intents-v1:'))
    .flatMap((key) => JSON.parse(sessionStorage.getItem(key))).map(({ key, status, files }) => ({ key, status, files })));
  const selectNew = async () => {
    await page.goto(CMS + '/admin/plugins/upload');
    await page.evaluate((hide) => { window.__gthfLoseNextUpload = hide; }, mode === 'after-commit');
    await page.getByRole('button', { name: /add new assets|ajouter.*médias/i }).first().click();
    await page.locator('input[type=file]').first().setInputFiles(fixture);
    await page.getByRole('button', { name: /upload.*library|téléverser.*médiathèque/i }).click();
  };
  const committed = (key) => until(intents, (rows) => rows.some((row) => row.key === key && row.status === 'committed'));
  const nextKey = async (offset) => (await until(() => requests, (rows) => rows.length > offset))[offset].key;

  step = 'Golden Journey new selection creates a fresh identity';
  await selectNew(); const first = await nextKey(0); await committed(first);
  const secondStart = requests.length;
  await selectNew(); const second = await nextKey(secondStart); await committed(second);
  assert.notEqual(first, second);
  report.scenarios.push({ name: step, status: 'passed', operationKeys: [first, second], identicalSelectedFile: true });

  step = 'Golden Journey interrupted transport retries the same identity';
  mode = 'before-send'; intercepted = false;
  const retryStart = requests.length;
  await selectNew(); const retryKey = await nextKey(retryStart); await committed(retryKey);
  const retries = requests.slice(retryStart);
  assert.ok(retries.length >= 2); assert.deepEqual([...new Set(retries.map((row) => row.key))], [retryKey]);
  report.scenarios.push({ name: step, status: 'passed', operationKey: retryKey, attempts: retries.length, simulation: 'first browser request aborted before sending' });

  step = 'Golden Journey lost acknowledgment survives reload and reads the durable receipt';
  mode = 'after-commit'; intercepted = false; capturedCommit = undefined; blockReceipts = true;
  const lostStart = requests.length;
  await selectNew(); const lostKey = await nextKey(lostStart);
  const hidden = await until(() => page.evaluate(() => window.__gthfHiddenUpload), Boolean);
  assert.ok(hidden.status >= 200 && hidden.status < 300, 'Hidden browser upload HTTP ' + hidden.status);
  capturedCommit = hidden.body;
  const persisted = await intents(); assert.ok(persisted.some((row) => row.key === lostKey));
  // Reload discards in-memory transport state while preserving the actual sessionStorage intent.
  blockReceipts = false;
  await page.goto(CMS + '/admin/plugins/gthf-media-recovery');
  await page.getByRole('heading', { name: 'Reprise des médias' }).waitFor();
  await committed(lostKey);
  assert.equal(requests.slice(lostStart).length, 1, 'A committed media must not be posted again');
  assert.ok(receiptRequests.includes(lostKey));
  await page.getByText('Terminé', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(directory, 'receipts.png'), fullPage: true });
  const ids = (Array.isArray(capturedCommit) ? capturedCommit : [capturedCommit]).map((file) => file.id);
  assert.ok(ids.every(Number.isInteger));
  report.scenarios.push({ name: step, status: 'passed', operationKey: lostKey, mediaIds: ids, postCount: 1, simulation: 'real successful browser multipart response discarded by injected fetch before the admin receives it' });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failedStep = step; report.errorType = error.name;
  // Credentials and HTTP headers may occur in browser errors: keep diagnostics private and redacted.
  let detail = String(error.stack || error.name).slice(0, 8000);
  for (const value of Object.values(credentials)) if (typeof value === 'string' && value.length >= 8) detail = detail.split(value).join('[redacted]');
  detail = detail.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
  await fs.writeFile(path.join(directory, 'failure.txt'), detail + '\n', { mode: 0o600 });
  if (page) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (tracing) await context.tracing.stop({ path: path.join(directory, 'trace.zip') }).catch(() => {});
  if (browser) await browser.close();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await fs.writeFile(path.join(directory, 'REPORT.md'), `# Golden Journeys admin médias\n\n## Summary\n\nRésultat : ${report.status}. Révision CMS : ${report.cmsRevision}. Script : ${sourceRevision}. Le test utilise uniquement la campagne synthétique ${report.campaignId}.\n\n## Synthèse\n\n${report.scenarios.map((item) => '- ' + item.name + ' : ' + item.status).join('\n')}\n\n${report.failedStep ? 'Étape en échec : ' + report.failedStep + '. Aucune acceptation annoncée.\n\n' : ''}${report.limits.join(' ')}\n\n## Annexes\n\nDétails expurgés : report.json. Trace et capture privées dans ce répertoire, à ne pas publier.\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: report.status, campaignId: report.campaignId, scenarios: report.scenarios.length, report: path.join(directory, 'report.json') }) + '\n');
}
