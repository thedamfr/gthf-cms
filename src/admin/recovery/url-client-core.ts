import { MediaIntent, PendingMediaError } from './client-core';

export function canonicalUrlSelection(urls: string[], folderId?: number | null) {
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 20) throw new Error('Sélectionnez entre une et vingt adresses.');
  const folder = folderId ?? null;
  if (folder !== null && (!Number.isSafeInteger(folder) || folder <= 0)) throw new Error('Invalid upload folder');
  const sources = urls.map((value) => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid upload URL');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid upload URL');
    return url.href;
  });
  return { urls: sources, folderId: folder };
}

export function urlIntent(options: { key: string; owner: string; url: string; folderId?: number | null }): MediaIntent {
  const selection = canonicalUrlSelection([options.url], options.folderId);
  return { key: options.key, owner: options.owner, path: '/upload/actions/upload-from-urls', method: 'POST', shape: 'single',
    kind: 'url-upload', sourceUrl: selection.urls[0], folderId: selection.folderId,
    files: [], fields: [], status: 'pending', createdAt: new Date().toISOString() };
}

/** Events may confirm a result, but a broken stream never authorises a new key. */
export function applyUrlUploadEvent(intents: MediaIntent[], event: string, value: any) {
  if (!['file:complete', 'file:error'].includes(event)) return undefined;
  if (!Number.isSafeInteger(value?.index) || value.index < 0 || value.index >= intents.length) throw new Error('Unexpected URL upload index');
  const intent = intents[value.index];
  if (intent.kind !== 'url-upload' || value.operationKey !== intent.key) throw new Error('Unexpected URL upload identity');
  if (event === 'file:complete') {
    if (!Number.isSafeInteger(value.file?.id) || value.file.id <= 0) throw new Error('Invalid URL upload result');
    intent.status = 'committed'; intent.message = undefined;
  } else {
    // Rights may return later; never discard an outcome merely because its
    // current owner cannot consult it. Other terminal results require an
    // explicit server assertion; transport errors remain recoverable.
    intent.status = ['OPERATION_PENDING', 'OPERATION_LEASE_LOST'].includes(value.code) ? 'pending'
      : value.retryable === false && !['AUTHORIZATION_REVOKED', 'FORBIDDEN'].includes(value.code) ? 'failed' : 'interrupted';
    intent.message = typeof value.code === 'string' ? value.code : undefined;
  }
  return intent;
}

export function urlUploadResult(text: string, intent: MediaIntent) {
  let result: any; let failure: any; let completed = false;
  for (const block of text.split('\n\n').filter(Boolean)) {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    if (!event || !data) throw new PendingMediaError(intent.key);
    const value = JSON.parse(data);
    if (event === 'file:complete' || event === 'file:error') {
      applyUrlUploadEvent([intent], event, value);
      if (event === 'file:complete') result = value.file;
      else failure = Object.assign(new Error(value.message || 'Import temporairement interrompu.'),
        { status: ['OPERATION_PENDING', 'OPERATION_LEASE_LOST'].includes(value.code) ? 409
          : ['AUTHORIZATION_REVOKED', 'FORBIDDEN'].includes(value.code) ? 403 : value.retryable === false ? 400 : 503, code: value.code });
    } else if (event === 'stream:complete') completed = true;
  }
  if (!completed) throw new PendingMediaError(intent.key);
  if (failure) throw failure;
  if (!result) throw new PendingMediaError(intent.key);
  return result;
}
