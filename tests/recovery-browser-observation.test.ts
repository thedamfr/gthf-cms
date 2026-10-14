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
