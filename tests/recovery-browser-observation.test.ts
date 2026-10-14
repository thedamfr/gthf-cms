import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import * as qs from 'qs';
import { matchesNavigationResponse, observedJson } from '../scripts/recovery/browser-observation.mjs';

const current = 'https://cms.invalid/admin/plugins/upload?assetId=42&gthfRecoveryVisit=new-document';
const previous = current.replace('new-document', 'old-document');
const fakeResponse = (referer: string, body: () => Promise<unknown>, method = 'GET', url = 'https://cms.invalid/upload/files/42') => ({
  url: () => url,
  request: () => ({ method: () => method, headers: () => ({ referer }) }),
  json: body,
});

test('an old-document RTK refetch cannot be selected even when it has the same asset and arrives first', async () => {
  let oldBodyReads = 0;
  const old = fakeResponse(previous, () => { oldBodyReads++; return new Promise(() => {}); });
  const fresh = fakeResponse(current, async () => ({ id: 42, width: 32, height: 24 }));
  const selected = [old, fresh].find((response) => matchesNavigationResponse(response, current, '/upload/files/42'));
  assert.equal(selected, fresh);
  assert.deepEqual(await observedJson(selected, 'Qualified file response', 100), { id: 42, width: 32, height: 24 });
  assert.equal(oldBodyReads, 0, 'The abandoned document body must never be awaited');
});

test('navigation matching still rejects another origin, target, method or missing browser Referer', () => {
  for (const response of [fakeResponse('', async () => ({})), fakeResponse(current, async () => ({}), 'POST'),
    fakeResponse(current, async () => ({}), 'GET', 'https://other.invalid/upload/files/42'),
    fakeResponse(current, async () => ({}), 'GET', 'https://cms.invalid/upload/files/43')]) {
    assert.equal(matchesNavigationResponse(response, current, '/upload/files/42'), false);
  }
});

test('a response whose body never finishes becomes an explicit bounded failure', async () => {
  const started = Date.now();
  await assert.rejects(observedJson(fakeResponse(current, () => new Promise(() => {})), 'Qualified file response', 20),
    { name: 'BrowserObservationTimeout', message: 'Qualified file response exceeded 20ms' });
  assert.ok(Date.now() - started < 2000, 'The harness must not wait for the global runner deadline');
});

test('body parsing preserves actual failures and successful response data', async () => {
  const failure = new SyntaxError('invalid JSON');
  await assert.rejects(observedJson(fakeResponse(current, async () => { throw failure; }), 'JSON', 100), (error) => error === failure);
  assert.deepEqual(await observedJson(fakeResponse(current, async () => ({ id: 42 })), 'JSON', 100), { id: 42 });
});

test('the installed Strapi query hook retains the qualification nonce during parsing and folder navigation', async () => {
  const root = path.dirname(require.resolve('@strapi/admin/package.json'));
  const source = fs.readFileSync(path.join(root, 'dist/admin/admin/src/hooks/useQueryParams.mjs'), 'utf8');
  const compiled = await transform(source, { loader: 'js', format: 'cjs' });
  const module = { exports: {} as any };
  let navigated: any;
  runInNewContext(compiled.code, { module, exports: module.exports,
    require: (name: string) => name === 'qs' ? qs : name === 'react'
      ? { useMemo: (fn: Function) => fn(), useCallback: (fn: Function) => fn }
      : { useLocation: () => ({ search: new URL(current).search }), useNavigate: () => (value: any) => { navigated = value; } },
  });
  const [{ query }, setQuery] = module.exports.useQueryParams();
  assert.equal(query.assetId, '42'); assert.equal(query.gthfRecoveryVisit, 'new-document');
  setQuery({ folder: 3 });
  const next = qs.parse(navigated.search);
  assert.equal(next.gthfRecoveryVisit, 'new-document'); assert.equal(next.assetId, '42'); assert.equal(next.folder, '3');
});

async function reportDirectory(run: (directory: string) => Promise<void>) {
  const directory = await fs.promises.mkdtemp('/tmp/gthf-report-publication-');
  try { await run(directory); }
  finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

test('report files are privately written and the acceptance JSON is atomically published last', async () => {
  const { publishObservationReports } = await import('../scripts/recovery/browser-observation.mjs');
  await reportDirectory(async (directory) => {
    const renames: string[] = [];
    await publishObservationReports(directory, { status: 'passed' }, '# Qualified\n', {
      ...fs.promises, open: async (name: string, flags: string) => {
        const handle = await fs.promises.open(name, flags);
        return {
          sync: async () => { renames.push('sync-directory'); await handle.sync(); },
          close: () => handle.close(),
        };
      }, rename: async (from: string, to: string) => {
        renames.push(path.basename(to)); return fs.promises.rename(from, to);
      },
    });
    assert.deepEqual(renames, ['REPORT.md', 'sync-directory', 'report.json', 'sync-directory']);
    assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(directory, 'report.json'), 'utf8')), { status: 'passed' });
    for (const name of ['report.json', 'REPORT.md']) assert.equal((await fs.promises.stat(path.join(directory, name))).mode & 0o077, 0);
    assert.deepEqual((await fs.promises.readdir(directory)).sort(), ['REPORT.md', 'report.json']);
  });
});

test('a real partial temporary write cannot truncate or replace the previous conservative report', async () => {
  const { publishObservationReports } = await import('../scripts/recovery/browser-observation.mjs');
  await reportDirectory(async (directory) => {
    await publishObservationReports(directory, { status: 'finalizing' }, '# Still finalizing\n');
    await assert.rejects(publishObservationReports(directory, { status: 'passed' }, '# Qualified\n', {
      ...fs.promises, writeFile: async (filename: string, content: string, options: any) => {
        if (path.basename(filename).startsWith('report.json.')) {
          await fs.promises.writeFile(filename, '{"status":', options);
          throw Object.assign(new Error('simulated disk full after partial write'), { code: 'ENOSPC' });
        }
        return fs.promises.writeFile(filename, content, options);
      },
    }), { code: 'ENOSPC' });
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(directory, 'report.json'), 'utf8')).status, 'finalizing');
    assert.equal(await fs.promises.readFile(path.join(directory, 'REPORT.md'), 'utf8'), '# Still finalizing\n');
    assert.deepEqual((await fs.promises.readdir(directory)).sort(), ['REPORT.md', 'report.json']);
  });
});

test('a failed final JSON rename leaves acceptance finalizing even after the Markdown was written', async () => {
  const { publishObservationReports } = await import('../scripts/recovery/browser-observation.mjs');
  await reportDirectory(async (directory) => {
    await publishObservationReports(directory, { status: 'finalizing' }, '# Still finalizing\n');
    await assert.rejects(publishObservationReports(directory, { status: 'passed' }, '# Qualified\n', {
      ...fs.promises, rename: async (from: string, to: string) => {
        if (path.basename(to) === 'report.json') throw Object.assign(new Error('simulated rename denial'), { code: 'EACCES' });
        return fs.promises.rename(from, to);
      },
    }), { code: 'EACCES' });
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(directory, 'report.json'), 'utf8')).status, 'finalizing');
    assert.equal(await fs.promises.readFile(path.join(directory, 'REPORT.md'), 'utf8'), '# Qualified\n');
    assert.deepEqual((await fs.promises.readdir(directory)).sort(), ['REPORT.md', 'report.json']);
  });
});

for (const code of ['ENOSPC', 'EIO']) test(`the real finalization closes trace and browser after ${code} while preserving failure`, async () => {
  const { publishObservationReports, boundedObservation } = await import('../scripts/recovery/browser-observation.mjs');
  // Execute the script's actual finally block; do not reproduce its control flow.
  const source = await fs.promises.readFile(path.resolve('scripts/recovery/media-admin.mjs'), 'utf8');
  const start = source.indexOf('} finally {\n  let outcome = report.status;');
  assert.ok(start >= 0);
  const end = source.indexOf('\n}\n\nasync function writeReport()', start);
  assert.ok(end > start);
  const body = source.slice(start + '} finally {'.length, end);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const finalize = new AsyncFunction('report', 'writeReport', 'tracing', 'context', 'browser', 'boundedObservation', 'path', 'directory', 'process', body);
  await reportDirectory(async (directory) => {
    const events: string[] = [];
    const report: any = { status: 'passed', scenarios: Array(11).fill({ status: 'passed' }) };
    const processState = { exitCode: undefined as number | undefined, stdout: { write: () => events.push('stdout') } };
    let publications = 0;
    const writeReport = async () => {
      events.push('publish'); publications++;
      await publishObservationReports(directory, report, '# Qualification\n', publications === 1 ? {
        ...fs.promises, writeFile: async (filename: string, content: string, options: any) => {
          await fs.promises.writeFile(filename, content.slice(0, 8), options);
          throw Object.assign(new Error('injected publication error'), { code });
        },
      } : fs.promises);
    };
    await finalize(report, writeReport, true, { tracing: { stop: async () => { events.push('trace'); } } },
      { close: async () => { events.push('browser'); } }, boundedObservation, path, directory, processState);
    assert.deepEqual(events, ['publish', 'trace', 'browser', 'publish', 'stdout']);
    assert.equal(processState.exitCode, 1);
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.cleanup, { trace: 'saved', browser: 'closed' });
    assert.deepEqual(report.publicationError, { phase: 'before-cleanup', name: 'Error', code });
    assert.equal(JSON.parse(await fs.promises.readFile(path.join(directory, 'report.json'), 'utf8')).status, 'failed');
  });
});
