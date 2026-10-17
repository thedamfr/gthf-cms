import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Qualification-only helpers: these do not change application requests or responses.
export async function boundedObservation(action, label, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} exceeded ${timeoutMs}ms`);
          error.name = 'BrowserObservationTimeout';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function matchesNavigationResponse(response, navigationUrl, apiPath) {
  const request = response.request();
  const target = new URL(navigationUrl);
  const actual = new URL(response.url());
  // An invalidated RTK query from the old document may arrive during page.goto.
  // The browser's immutable Referer distinguishes it from the new navigation.
  return request.method() === 'GET' && actual.origin === target.origin
    && actual.pathname === apiPath && request.headers().referer === target.href;
}

export function observedJson(response, label = 'Browser response JSON', timeoutMs = 10_000) {
  // Playwright's page default timeout does not bound Response.body/json.
  return boundedObservation(() => response.json(), label, timeoutMs);
}

export async function publishObservationReports(directory, report, markdown, io = fs) {
  const nonce = randomUUID();
  const documentTemp = path.join(directory, `REPORT.md.${nonce}.tmp`);
  const reportTemp = path.join(directory, `report.json.${nonce}.tmp`);
  const directoryHandle = await io.open(directory, 'r');
  try {
    // Finish and flush both private files before replacing either visible artifact.
    await io.writeFile(documentTemp, markdown, { mode: 0o600, flag: 'wx', flush: true });
    await io.writeFile(reportTemp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    await io.rename(documentTemp, path.join(directory, 'REPORT.md'));
    await directoryHandle.sync();
    // Machine acceptance is published last. Any earlier failure retains the
    // previous conservative JSON; readers never observe an in-place truncation.
    await io.rename(reportTemp, path.join(directory, 'report.json'));
    await directoryHandle.sync();
  } finally {
    // These names belong to this invocation only. Cleanup must not mask I/O errors.
    await io.rm(documentTemp, { force: true }).catch(() => {});
    await io.rm(reportTemp, { force: true }).catch(() => {});
    await directoryHandle.close();
  }
}
