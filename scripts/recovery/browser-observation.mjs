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
