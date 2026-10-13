export type MediaIntent = {
  key: string; owner: string; path: string; method: 'POST' | 'DELETE'; shape: 'array' | 'single';
  files: { name: string; size: number; type: string }[]; fields: [string, string][];
  status: 'pending' | 'committed' | 'interrupted' | 'failed'; createdAt: string; message?: string;
};
export type MediaReceipt = { key: string; status: MediaIntent['status']; result?: any; error?: string };
export class PendingMediaError extends Error {
  constructor(public key: string) { super('Le résultat de cet envoi reste à vérifier dans « Reprise des médias ».'); }
}
export function safeMediaPath(url: string, base: string) {
  const target = new URL(url, base);
  if (target.origin !== new URL(base).origin || !/^\/upload(?:\/files(?:\/\d+(?:\/replace)?)?)?$/.test(target.pathname)
    || (target.search && !/^\?id=\d+$/.test(target.search))) throw new Error('Invalid media operation endpoint');
  return target.pathname + target.search;
}
export function intentFromForm(options: { key: string; owner: string; path: string; method?: 'POST' | 'DELETE'; shape: 'array' | 'single'; formData?: FormData }): MediaIntent {
  const files = []; const fields: [string, string][] = [];
  for (const [name, value] of options.formData?.entries() || []) {
    if (typeof value === 'string') fields.push([name, value]);
    else if (name === 'files') files.push({ name: value.name, size: value.size, type: value.type });
  }
  return { key: options.key, owner: options.owner, path: options.path, method: options.method || 'POST', shape: options.shape, files, fields, status: 'pending', createdAt: new Date().toISOString() };
}
export async function executeIntent(intent: MediaIntent, dependencies: {
  transport: (key: string) => Promise<any>; receipt: (key: string) => Promise<MediaReceipt | null>;
  save: (intent: MediaIntent) => void; signal?: AbortSignal; now?: () => number;
  sleep?: () => Promise<void>; maxMs?: number;
}) {
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || (() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
  const started = now();
  let maySend = true;
  let attempted = false;
  let rejection: any;
  dependencies.save(intent); // A storage failure prevents the first write; never send without its identity.
  const done = (result: any) => {
    intent.status = 'committed'; dependencies.save(intent);
    return intent.shape === 'single' && Array.isArray(result) ? result[0] : result;
  };
  while (now() - started <= (dependencies.maxMs ?? 300_000)) {
    if (dependencies.signal?.aborted) {
      if (!attempted) { intent.status = 'interrupted'; dependencies.save(intent); }
      throw new PendingMediaError(intent.key);
    }
    if (maySend) {
      attempted = true;
      try { return done(await dependencies.transport(intent.key)); }
      catch (error: any) {
        const status = error.status || error.response?.status;
        const code = error.response?.data?.error?.name || (typeof error.code === 'string' ? error.code : undefined);
        if (status === 409 && code && code !== 'OPERATION_PENDING' && code !== 'OPERATION_LEASE_LOST') {
          // This payload cannot use the key. Never reconcile it against a receipt
          // belonging to a different payload when the recovery page is reloaded.
          intent.status = 'failed'; intent.message = code; dependencies.save(intent);
          throw error;
        }
        if (status === 401 || status === 403) {
          // Permission loss does not change the outcome of an earlier request.
          // Keep its identity for later authorised consultation.
          throw error;
        }
        rejection = [400, 413, 415].includes(status) ? error : undefined;
        maySend = false;
      }
    }
    try {
      const receipt = await dependencies.receipt(intent.key);
      if (receipt?.status === 'committed') return done(receipt.result);
      if (receipt?.status === 'failed') {
        intent.status = 'failed'; intent.message = receipt.error; dependencies.save(intent);
        throw Object.assign(new Error('Cet envoi ne peut pas être terminé. Consultez son résultat avant une nouvelle tentative.'), { terminal: true });
      }
      if (!receipt && rejection) {
        intent.status = 'failed'; dependencies.save(intent);
        throw Object.assign(rejection, { terminal: true });
      }
      maySend = !receipt || receipt.status === 'interrupted';
      intent.status = receipt?.status || 'pending'; dependencies.save(intent);
    } catch (error: any) {
      if (error.terminal || [401, 403].includes(error.status || error.response?.status)) throw error;
      // Unavailable receipt service means unknown, never permission to create a new intent.
    }
    await sleep();
  }
  throw new PendingMediaError(intent.key);
}
