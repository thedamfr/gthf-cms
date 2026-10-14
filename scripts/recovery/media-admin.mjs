import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { boundedObservation, matchesNavigationResponse, observedJson, publishObservationReports } from './browser-observation.mjs';

const CMS = 'http://127.0.0.1:33137';
const MEDIA = 'http://127.0.0.1:33190';
const ROOT = '/home/ubuntu/.local/state/infra-sincere/qualification-vm';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const { values } = parseArgs({ options: { manifest: { type: 'string' }, campaign: { type: 'string' }, 'url-fixture': { type: 'string' } } });
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
const urlFixture = values['url-fixture'] ? privateFile(values['url-fixture']) : null;
if (urlFixture) {
  assert.equal(path.dirname(values['url-fixture']), campaignRoot);
  assert.equal(urlFixture.campaignId, values.campaign);
  const url = new URL(urlFixture.url);
  assert.equal(url.origin, 'http://203.0.113.42:9000');
  assert.ok(url.pathname.startsWith('/' + manifest.bucket + '/'));
  assert.equal(url.search, ''); assert.equal(url.hash, '');
}
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
let capturedCommit; let capturedBulkCommit; let bulkAllowed; let replacementAllowed;
const requests = []; const bulkRequests = []; const urlRequests = []; const replacementRequests = []; const receiptRequests = [];
try {
  const health = await fetch(CMS + '/api/release', { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal((await observedJson(health, 'Release response JSON')).revision, report.cmsRevision, 'The tunnel must serve the exact manifest CMS revision');
  const { chromium } = await import('/home/ubuntu/.local/share/agent-web-tools/node_modules/playwright/index.mjs');
  browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true });
  context = await browser.newContext({ locale: 'en-US', viewport: { width: 1360, height: 980 } });
  // Preserve the browser's actual multipart request without reconstructing its
  // body through route.fetch. Reject only after its real successful response,
  // before the admin client can read the acknowledgment.
  await context.addInitScript(({ origin }) => {
    const NativeXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class extends NativeXHR {
      constructor() {
        super();
        this.addEventListener('load', (event) => {
          if (!this.__gthfHideAcknowledgment) return;
          window.__gthfHiddenUpload = { status: this.status, body: JSON.parse(this.responseText) };
          if (this.status >= 200 && this.status < 300) {
            event.stopImmediatePropagation();
            this.dispatchEvent(new ProgressEvent('error'));
          }
        }, true);
      }
      open(method, address, ...options) {
        const url = new URL(String(address), location.href);
        this.__gthfUpload = url.origin === origin && method.toUpperCase() === 'POST'
          && /^\/upload(?:\/files)?$/.test(url.pathname);
        return super.open(method, address, ...options);
      }
      send(body) {
        this.__gthfHideAcknowledgment = this.__gthfUpload && window.__gthfLoseNextUpload;
        if (this.__gthfHideAcknowledgment) window.__gthfLoseNextUpload = false;
        return super.send(body);
      }
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const address = args[0] instanceof Request ? args[0].url : String(args[0]);
      const url = new URL(address, location.href);
      const method = args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET');
      if (window.__gthfLoseNextReplacement && method.toUpperCase() === 'POST'
        && url.origin === origin && /^\/upload\/files\/\d+\/replace$/.test(url.pathname)) {
        window.__gthfLoseNextReplacement = false;
        const response = await nativeFetch(...args);
        window.__gthfHiddenReplacement = { status: response.status, body: await response.clone().json() };
        if (response.ok) throw new TypeError('Simulated lost replacement acknowledgment after the real commit');
        return response;
      }
      return nativeFetch(...args);
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
    if (request.method() === 'POST' && /^\/upload\/files\/\d+\/replace$/.test(url.pathname)) {
      assert.equal(Number(url.pathname.split('/')[3]), replacementAllowed,
        'Replacement is restricted to the media created by this browser invocation');
      const key = request.headers()['idempotency-key']; assert.match(key || '', UUID);
      const saved = await page.evaluate((key) => Object.keys(sessionStorage).filter((name) => name.startsWith('gthf-media-intents-v1:'))
        .flatMap((name) => JSON.parse(sessionStorage.getItem(name))).find((item) => item.key === key), key);
      assert.equal(saved?.path, url.pathname); assert.equal(saved?.files.length, 1);
      replacementRequests.push({ key, mediaId: replacementAllowed, mode });
      if (!intercepted && mode === 'replace-before-send') { intercepted = true; return route.abort('connectionreset'); }
    }
    if (request.method() === 'POST' && url.pathname === '/upload/actions/upload-from-urls') {
      assert.ok(urlFixture, 'URL imports need an explicitly verified isolated source');
      const payload = request.postDataJSON();
      assert.ok(payload.urls.length > 0 && payload.urls.length <= 2);
      assert.ok(payload.urls.every((value) => value === urlFixture.url));
      assert.equal(payload.operationKeys.length, payload.urls.length);
      assert.equal(new Set(payload.operationKeys).size, payload.urls.length);
      for (const key of payload.operationKeys) assert.match(key, UUID);
      const saved = await page.evaluate(() => Object.keys(sessionStorage).filter((name) => name.startsWith('gthf-media-intents-v1:'))
        .flatMap((name) => JSON.parse(sessionStorage.getItem(name))));
      for (const key of payload.operationKeys) {
        const intent = saved.find((item) => item.key === key);
        assert.equal(intent?.kind, 'url-upload'); assert.equal(intent?.sourceUrl, urlFixture.url);
        assert.equal(intent?.folderId, payload.folderId ?? null);
      }
      urlRequests.push({ payload, mode });
      if (!intercepted && mode === 'url-before-send') { intercepted = true; return route.abort('connectionreset'); }
    }
    if (request.method() === 'POST' && url.pathname === '/upload/actions/bulk-delete') {
      const key = request.headers()['idempotency-key']; assert.match(key || '', UUID);
      const payload = request.postDataJSON();
      assert.deepEqual(payload, bulkAllowed, 'Bulk deletion is restricted to the synthetic media/folder created by this browser scenario');
      const saved = await page.evaluate((key) => Object.keys(sessionStorage).filter((name) => name.startsWith('gthf-media-intents-v1:'))
        .flatMap((name) => JSON.parse(sessionStorage.getItem(name))).find((item) => item.key === key), key);
      assert.equal(saved?.kind, 'bulk-delete'); assert.deepEqual(saved?.payload, payload, 'The exact parent selection must be saved before the POST');
      bulkRequests.push({ key, payload, mode });
      if (!intercepted && mode === 'bulk-before-send') { intercepted = true; return route.abort('connectionreset'); }
      if (!intercepted && mode === 'bulk-after-commit') {
        intercepted = true;
        const response = await route.fetch();
        assert.equal(response.status(), 200, 'This scenario hides only a real complete bulk commit');
        capturedBulkCommit = await observedJson(response); blockReceipts = true;
        return route.abort('connectionreset');
      }
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
    .flatMap((key) => JSON.parse(sessionStorage.getItem(key))).map(({ key, status, files, kind, payload, progress }) => ({ key, status, files, kind, payload, progress })));
  const selectNew = async (selectedFixture = fixture) => {
    await page.goto(CMS + '/admin/plugins/upload');
    await page.evaluate((hide) => { window.__gthfLoseNextUpload = hide; }, mode === 'after-commit');
    await page.getByRole('button', { name: /add new assets|ajouter.*médias/i }).first().click();
    await page.locator('input[type=file]').first().setInputFiles(selectedFixture);
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
  report.scenarios.push({ name: step, status: 'passed', operationKey: lostKey, mediaIds: ids, postCount: 1, simulation: 'real successful browser multipart response discarded by an injected XHR load listener before the admin receives it' });
  // Both bulk scenarios use fresh, uniquely named synthetic files plus one
  // freshly created empty folder. The route guard checks their exact IDs before
  // allowing any destructive request; unrelated campaign media stay untouched.
  const makeBulkSelection = async () => {
    mode = 'normal';
    const files = [];
    for (let index = 0; index < 2; index++) {
      const name = 'recovery-browser-bulk-' + randomUUID() + '.png';
      const filePath = path.join(directory, name); await fs.writeFile(filePath, bytes, { mode: 0o600 });
      const acknowledged = page.waitForResponse((response) => response.request().method() === 'POST' && /^\/upload(?:\/files)?$/.test(new URL(response.url()).pathname));
      const offset = requests.length; await selectNew(filePath); const uploadKey = await nextKey(offset);
      const response = await acknowledged; assert.ok(response.ok());
      const body = await observedJson(response); const file = (Array.isArray(body) ? body : [body])[0];
      assert.ok(Number.isSafeInteger(file.id) && file.id > 0); assert.equal(file.name, name);
      await committed(uploadKey); files.push(file);
    }
    await page.goto(CMS + '/admin/plugins/upload');
    await page.getByRole('button', { name: /add new folder/i }).click();
    const folderName = 'recovery-browser-folder-' + randomUUID();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(folderName);
    const created = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.replace(/\/$/, '') === '/upload/folders');
    await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
    const folderResponse = await created; assert.ok(folderResponse.ok()); const folderBody = await observedJson(folderResponse, 'Folder creation response JSON');
    const folder = folderBody.data; assert.ok(Number.isSafeInteger(folder.id) && folder.id > 0); assert.equal(folder.name, folderName);
    await page.goto(CMS + '/admin/plugins/upload');
    for (const file of files) {
      await page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name: file.name, exact: true }) }).getByRole('checkbox').check();
    }
    await page.getByRole('checkbox', { name: new RegExp(folderName) }).check();
    bulkAllowed = { fileIds: files.map((file) => file.id).sort((a, b) => a - b), folderIds: [folder.id] };
    return { files, folder };
  };
  const confirmBulk = async () => {
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  };
  const assertSelectionGone = async ({ files, folder }) => {
    const listing = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/upload/files');
    const folders = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname.replace(/\/$/, '') === '/upload/folders');
    await page.goto(CMS + '/admin/plugins/upload');
    for (const [pending, deleted] of [[listing, files.map((file) => file.id)], [folders, [folder.id]]]) {
      const response = await pending; assert.ok(response.ok());
      const body = await observedJson(response); const rows = body.results || body.data || body;
      assert.ok(Array.isArray(rows), 'The actual admin listing must have loaded successfully');
      assert.ok(rows.every((row) => !deleted.includes(row.id)));
    }
    await page.getByRole('button', { name: /add new assets/i }).waitFor();
    for (const file of files) assert.equal(await page.getByRole('heading', { name: file.name, exact: true }).count(), 0);
    assert.equal(await page.getByRole('checkbox', { name: new RegExp(folder.name) }).count(), 0);
  };
  step = 'Golden Journey mixed bulk deletion retries one saved parent after transport loss';
  const selectedRetry = await makeBulkSelection();
  mode = 'bulk-before-send'; intercepted = false;
  const bulkStart = bulkRequests.length; await confirmBulk();
  const bulkRetryKey = (await until(() => bulkRequests, (rows) => rows.length > bulkStart))[bulkStart].key;
  await committed(bulkRetryKey);
  const bulkRetries = bulkRequests.slice(bulkStart); assert.ok(bulkRetries.length >= 2);
  assert.deepEqual([...new Set(bulkRetries.map((item) => item.key))], [bulkRetryKey]);
  assert.ok(bulkRetries.every((item) => JSON.stringify(item.payload) === JSON.stringify(bulkAllowed)));
  await assertSelectionGone(selectedRetry);
  report.scenarios.push({ name: step, status: 'passed', operationKey: bulkRetryKey, selected: bulkAllowed, attempts: bulkRetries.length,
    simulation: 'first bulk browser request aborted before sending; real Strapi/SQL deletion on the retry' });

  step = 'Golden Journey mixed bulk committed receipt survives reload without another deletion';
  const selectedLost = await makeBulkSelection();
  mode = 'bulk-after-commit'; intercepted = false; capturedBulkCommit = undefined;
  const bulkLostStart = bulkRequests.length; await confirmBulk();
  const bulkLostKey = (await until(() => bulkRequests, (rows) => rows.length > bulkLostStart))[bulkLostStart].key;
  assert.notEqual(bulkLostKey, bulkRetryKey, 'A new explicit selection requires a new parent identity');
  const hiddenBulk = await until(() => capturedBulkCommit, Boolean);
  assert.deepEqual(hiddenBulk.data.files.map((file) => file.id).sort((a, b) => a - b), bulkAllowed.fileIds);
  assert.deepEqual(hiddenBulk.data.folders.map((folder) => folder.id).sort((a, b) => a - b), bulkAllowed.folderIds);
  assert.ok((await intents()).some((item) => item.key === bulkLostKey && item.kind === 'bulk-delete'));
  blockReceipts = false; mode = 'normal';
  await page.goto(CMS + '/admin/plugins/gthf-media-recovery');
  await page.getByRole('heading', { name: 'Reprise des médias' }).waitFor(); await committed(bulkLostKey);
  assert.equal(bulkRequests.slice(bulkLostStart).length, 1); assert.ok(receiptRequests.includes(bulkLostKey));
  const savedBulk = (await intents()).find((item) => item.key === bulkLostKey);
  assert.equal(savedBulk.progress.total, 2); assert.equal(savedBulk.progress.committed, 2); assert.equal(savedBulk.progress.failed, 0);
  assert.ok(savedBulk.progress.children.every((child) => child.status === 'committed'));
  await page.screenshot({ path: path.join(directory, 'bulk-receipt.png'), fullPage: true });
  await assertSelectionGone(selectedLost);
  report.scenarios.push({ name: step, status: 'passed', operationKey: bulkLostKey, selected: bulkAllowed, postCount: 1, childCount: savedBulk.progress.total,
    simulation: 'real successful JSON bulk response discarded with Playwright after server commit, then receipt read after page reload' });
  // Exercise the shipped beta Replace and crop controls, which share the same
  // mutation. The feature is enabled solely inside this isolated test browser.
  await context.addInitScript(() => {
    let strapi;
    Object.defineProperty(window, 'strapi', { configurable: true, get: () => strapi, set(value) {
      strapi = value;
      const original = value.future.isEnabled.bind(value.future);
      value.future.isEnabled = (name) => name === 'betaMediaLibrary' || original(name);
    } });
  });
  replacementAllowed = ids[0];
  assert.ok(Number.isSafeInteger(replacementAllowed) && replacementAllowed > 0);
  const replacementFixture = path.join(directory, 'replacement-' + randomUUID() + '.png');
  await fs.writeFile(replacementFixture,
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#14b8a6' } }).png().toBuffer(), { mode: 0o600 });
  const openReplacementAsset = async () => {
    const navigation = new URL('/admin/plugins/upload', CMS);
    navigation.searchParams.set('assetId', String(replacementAllowed));
    navigation.searchParams.set('gthfRecoveryVisit', randomUUID());
    const navigationUrl = navigation.href;
    const loaded = page.waitForResponse((response) => matchesNavigationResponse(response, navigationUrl, '/upload/files/' + replacementAllowed));
    const [, response] = await Promise.all([page.goto(navigationUrl), loaded]);
    assert.equal(new URL(page.url()).searchParams.get('gthfRecoveryVisit'), navigation.searchParams.get('gthfRecoveryVisit'),
      'The actual Strapi router must retain this navigation identity');
    assert.ok(response.ok());
    const body = await observedJson(response); const asset = body.data || body;
    assert.equal(asset.id, replacementAllowed); assert.equal(typeof asset.hash, 'string');
    await page.getByRole('button', { name: 'Replace this file', exact: true }).waitFor();
    return asset;
  };
  const selectReplacement = async () => {
    await openReplacementAsset();
    await page.evaluate((hide) => { window.__gthfLoseNextReplacement = hide; }, mode === 'replace-after-commit');
    await page.getByRole('button', { name: 'Replace this file', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await (await chooser).setFiles(replacementFixture);
  };
  const nextReplacementKey = async (offset) => (await until(() => replacementRequests, (rows) => rows.length > offset))[offset].key;
  step = 'Golden Journey beta replacement retries the same saved intent after pre-send loss';
  const originalAsset = await openReplacementAsset();
  mode = 'replace-before-send'; intercepted = false; let replacementOffset = replacementRequests.length;
  await selectReplacement(); const replacementRetry = await nextReplacementKey(replacementOffset); await committed(replacementRetry);
  const replacementRetries = replacementRequests.slice(replacementOffset);
  assert.ok(replacementRetries.length >= 2);
  assert.deepEqual([...new Set(replacementRetries.map((item) => item.key))], [replacementRetry]);
  const replacedAsset = await openReplacementAsset(); assert.notEqual(replacedAsset.hash, originalAsset.hash);
  report.scenarios.push({ name: step, status: 'passed', operationKey: replacementRetry, mediaId: replacementAllowed,
    attempts: replacementRetries.length, simulation: 'first real beta replacement multipart aborted before sending' });

  step = 'Golden Journey new beta replacement selection survives lost commit and reload without reposting';
  mode = 'replace-after-commit'; blockReceipts = true; replacementOffset = replacementRequests.length;
  await selectReplacement(); const replacementLost = await nextReplacementKey(replacementOffset);
  assert.notEqual(replacementLost, replacementRetry, 'New explicit identical selection must get a fresh identity');
  const hiddenReplacement = await until(() => page.evaluate(() => window.__gthfHiddenReplacement), Boolean);
  assert.ok(hiddenReplacement.status >= 200 && hiddenReplacement.status < 300);
  const hiddenFile = (Array.isArray(hiddenReplacement.body) ? hiddenReplacement.body : [hiddenReplacement.body])[0];
  assert.equal(hiddenFile.id, replacementAllowed); assert.notEqual(hiddenFile.hash, replacedAsset.hash);
  blockReceipts = false; mode = 'normal';
  await page.goto(CMS + '/admin/plugins/gthf-media-recovery'); await committed(replacementLost);
  assert.equal(replacementRequests.slice(replacementOffset).length, 1); assert.ok(receiptRequests.includes(replacementLost));
  const afterReload = await openReplacementAsset(); assert.equal(afterReload.hash, hiddenFile.hash);
  report.scenarios.push({ name: step, status: 'passed', operationKey: replacementLost, mediaId: replacementAllowed, postCount: 1,
    simulation: 'native fetch multipart completes; its successful response is hidden before Strapi receives it, then the saved receipt is read after reload' });

  step = 'Golden Journey beta crop Apply persists its replacement and keeps anonymous receipts forbidden';
  replacementOffset = replacementRequests.length;
  assert.deepEqual([afterReload.width, afterReload.height], [64, 48]);
  await page.getByRole('button', { name: 'Crop', exact: true }).click();
  const applyCrop = page.getByRole('button', { name: 'Apply', exact: true });
  await until(() => applyCrop.isEnabled(), Boolean); // The real CORS image has loaded into the canvas.
  await page.getByLabel('Width (px)', { exact: true }).fill('32');
  await page.getByLabel('Height (px)', { exact: true }).fill('24');
  await applyCrop.click();
  const cropKey = await nextReplacementKey(replacementOffset); await committed(cropKey);
  assert.notEqual(cropKey, replacementLost); assert.equal(replacementRequests.slice(replacementOffset).length, 1);
  const croppedAsset = await openReplacementAsset(); assert.notEqual(croppedAsset.hash, afterReload.hash);
  assert.deepEqual([croppedAsset.width, croppedAsset.height], [32, 24], 'The actual cropped dimensions must persist in Strapi');
  const anonymous = await fetch(CMS + '/upload/recovery/operations/' + cropKey, { signal: AbortSignal.timeout(5000) });
  assert.ok([401, 403].includes(anonymous.status), 'An anonymous reader must not receive a private replacement receipt');
  await page.screenshot({ path: path.join(directory, 'beta-replacement-crop.png'), fullPage: true });
  report.scenarios.push({ name: step, status: 'passed', operationKey: cropKey, mediaId: replacementAllowed,
    postCount: 1, anonymousReceiptStatus: anonymous.status, cropApplied: true,
    dimensionsBefore: [afterReload.width, afterReload.height], dimensionsAfter: [croppedAsset.width, croppedAsset.height] });
  if (urlFixture) {
    // Enable Strapi's shipped beta library only inside this test browser. The
    // production feature configuration and the server's SSRF rules are unchanged.
    await context.addInitScript(({ origin }) => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const address = args[0] instanceof Request ? args[0].url : String(args[0]);
        const url = new URL(address, location.href);
        const method = args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET');
        if (window.__gthfLoseUrl && method.toUpperCase() === 'POST' && url.origin === origin && url.pathname === '/upload/actions/upload-from-urls') {
          window.__gthfLoseUrl = false;
          const response = await nativeFetch(...args);
          const text = await response.text();
          window.__gthfHiddenUrl = { status: response.status, text };
          throw new TypeError('Simulated lost SSE acknowledgment after the real server response');
        }
        return nativeFetch(...args);
      };
    }, { origin: CMS });
    const selectUrls = async (count = 1) => {
      await page.goto(CMS + '/admin/plugins/upload');
      await page.evaluate((hide) => { window.__gthfLoseUrl = hide; }, mode === 'url-after-commit');
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: /(?:import|upload) from url/i }).click();
      await page.getByRole('dialog').locator('textarea[name=urls]').fill(Array(count).fill(urlFixture.url).join('\n'));
      await page.getByRole('dialog').getByRole('button', { name: 'Upload', exact: true }).click();
    };
    const nextUrlKeys = async (offset) => (await until(() => urlRequests, (rows) => rows.length > offset))[offset].payload.operationKeys;
    step = 'Golden Journey intentional URL selections and duplicates have distinct durable identities';
    mode = 'normal'; let offset = urlRequests.length;
    await selectUrls(2); const pair = await nextUrlKeys(offset);
    for (const key of pair) await committed(key);
    offset = urlRequests.length; await selectUrls(); const [fresh] = await nextUrlKeys(offset); await committed(fresh);
    assert.equal(new Set([...pair, fresh]).size, 3);
    report.scenarios.push({ name: step, status: 'passed', operationKeys: [...pair, fresh], sameSource: true });

    step = 'Golden Journey URL transport loss resumes its saved identity after reload';
    mode = 'url-before-send'; intercepted = false; offset = urlRequests.length;
    await selectUrls(); const [retry] = await nextUrlKeys(offset);
    await page.goto(CMS + '/admin/plugins/gthf-media-recovery');
    await page.getByRole('heading', { name: 'Reprise des médias' }).waitFor();
    await until(intents, (rows) => rows.some((row) => row.key === retry && row.status === 'interrupted'));
    mode = 'normal';
    await page.getByRole('button', { name: 'Reprendre cet import', exact: true }).click();
    await committed(retry);
    assert.equal(urlRequests.slice(offset).length, 2);
    assert.ok(urlRequests.slice(offset).every((row) => row.payload.operationKeys.length === 1 && row.payload.operationKeys[0] === retry));
    report.scenarios.push({ name: step, status: 'passed', operationKey: retry, attempts: 2,
      simulation: 'first URL POST aborted before sending, reload and explicit resume with the same identity' });

    step = 'Golden Journey lost URL stream reads the durable receipt after reload without reposting';
    mode = 'url-after-commit'; blockReceipts = true; offset = urlRequests.length;
    await selectUrls(); const [lost] = await nextUrlKeys(offset);
    const hidden = await until(() => page.evaluate(() => window.__gthfHiddenUrl), Boolean);
    assert.equal(hidden.status, 200); assert.ok(hidden.text.includes('event: stream:complete'));
    const completed = hidden.text.split('\n\n').find((event) => event.startsWith('event: file:complete\n'));
    assert.ok(completed, 'The hidden response must contain a real media commit');
    const file = JSON.parse(completed.split('\ndata: ')[1]); assert.equal(file.operationKey, lost); assert.ok(Number.isSafeInteger(file.file.id));
    blockReceipts = false; mode = 'normal';
    await page.goto(CMS + '/admin/plugins/gthf-media-recovery'); await committed(lost);
    assert.equal(urlRequests.slice(offset).length, 1); assert.ok(receiptRequests.includes(lost));
    await page.screenshot({ path: path.join(directory, 'url-receipts.png'), fullPage: true });
    report.scenarios.push({ name: step, status: 'passed', operationKey: lost, mediaId: file.file.id, postCount: 1,
      simulation: 'real completed SSE response discarded before the admin sees it; receipt consulted after reload' });
  } else report.limits.push('URL import browser scenarios were not selected; they require --url-fixture from the isolated bench.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failedStep = step; report.errorType = error.name;
  // Credentials and HTTP headers may occur in browser errors: keep diagnostics private and redacted.
  let detail = String(error.stack || error.name).slice(0, 8000);
  for (const value of Object.values(credentials)) if (typeof value === 'string' && value.length >= 8) detail = detail.split(value).join('[redacted]');
  detail = detail.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
  await fs.writeFile(path.join(directory, 'failure.txt'), detail + '\n', { mode: 0o600 });
  await writeReport();
  if (page) {
    try { await boundedObservation(() => page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }), 'Failure screenshot', 5000); }
    catch (captureError) { report.failureCaptureError = captureError.name; }
  }
  process.exitCode = 1;
} finally {
  let outcome = report.status;
  report.status = outcome === 'passed' ? 'finalizing' : outcome;
  report.cleanup = { trace: tracing ? 'pending' : 'not-started', browser: browser ? 'pending' : 'not-started' };
  // Keep an interrupted/failed observation durable before closing transports.
  // A report still marked finalizing never constitutes a successful qualification.
  await writeReport();
  if (tracing) {
    try {
      await boundedObservation(() => context.tracing.stop({ path: path.join(directory, 'trace.zip') }), 'Trace finalization', 10_000);
      report.cleanup.trace = 'saved';
    } catch (error) { outcome = 'failed'; report.cleanup.trace = 'failed'; report.traceError = error.name; }
  }
  if (browser) {
    try { await browser.close(); report.cleanup.browser = 'closed'; }
    catch (error) { outcome = 'failed'; report.cleanup.browser = 'unconfirmed'; report.browserCloseError = error.name; }
  }
  report.status = outcome;
  if (outcome !== 'passed') process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
  await writeReport();
  process.stdout.write(JSON.stringify({ status: report.status, campaignId: report.campaignId, scenarios: report.scenarios.length, report: path.join(directory, 'report.json') }) + '\n');
}

async function writeReport() {
  await publishObservationReports(directory, report, `# Golden Journeys admin médias\n\n## Summary\n\nRésultat : ${report.status}. Révision CMS : ${report.cmsRevision}. Script : ${sourceRevision}. Le test utilise uniquement la campagne synthétique ${report.campaignId}.\n\n## Synthèse\n\n${report.scenarios.map((item) => '- ' + item.name + ' : ' + item.status).join('\n')}\n\n${report.failedStep ? 'Étape en échec : ' + report.failedStep + '. Aucune acceptation annoncée.\n\n' : ''}${report.limits.join(' ')}\n\nNettoyage : ${report.cleanup ? JSON.stringify(report.cleanup) : 'pas encore commencé'}. Un état finalizing, un nettoyage pending ou une fermeture unconfirmed ne constitue pas une réussite.\n\n## Annexes\n\nDétails expurgés : report.json. Trace et capture privées dans ce répertoire, à ne pas publier.\n`);
}
