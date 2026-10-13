import { getFetchClient } from '@strapi/admin/strapi-admin';
import { executeIntent, intentFromForm, MediaIntent, MediaReceipt, safeMediaPath } from './client-core';

const prefix = 'gthf-media-intents-v1:';
const backend = () => new URL((window as any).strapi.backendURL || '/', window.location.origin).href;
export function readIntents(owner: string): MediaIntent[] {
  const value = sessionStorage.getItem(prefix + owner);
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Invalid media intent store');
  return parsed.filter((entry) => entry.owner === owner);
}
export function saveIntent(intent: MediaIntent) {
  const rows = readIntents(intent.owner).filter((row) => row.key !== intent.key);
  rows.push(intent);
  // Completed history is bounded; unresolved operations are never silently discarded.
  const unresolved = rows.filter((row) => row.status !== 'committed' && row.status !== 'failed');
  const completed = rows.filter((row) => row.status === 'committed' || row.status === 'failed').slice(-30);
  sessionStorage.setItem(prefix + intent.owner, JSON.stringify([...unresolved, ...completed]));
  window.dispatchEvent(new Event('gthf-media-intents'));
}
export async function fetchReceipt(key: string) {
  try {
    const { data } = await getFetchClient().get<MediaReceipt>(`/upload/recovery/operations/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(5000) });
    return data;
  } catch (error: any) { if ((error.status ?? error.response?.status) === 404) return null; throw error; }
}
async function currentOwner() {
  const { data } = await getFetchClient().get<{ data?: { id?: number }; id?: number }>('/admin/users/me', { signal: AbortSignal.timeout(5000) });
  const id = data?.data?.id ?? data?.id;
  if (!id) throw new Error('La session administrateur doit être reconnectée.');
  return `admin:${id}`;
}
export async function runMediaIntent(options: { url: string; formData?: FormData; signal?: AbortSignal; shape: 'array' | 'single'; key?: string; method?: 'POST' | 'DELETE' }, transport: (key: string) => Promise<any>) {
  const key = options.key || crypto.randomUUID();
  const owner = await currentOwner();
  const path = safeMediaPath(options.url, backend());
  const existing = readIntents(owner).find((entry) => entry.key === key);
  const intent = existing || intentFromForm({ ...options, key, owner, path });
  return executeIntent(intent, { transport, receipt: fetchReceipt, save: saveIntent, signal: options.signal });
}
export async function resumeIntent(intent: MediaIntent, selected: File[] = []) {
  safeMediaPath(intent.path, backend());
  if (intent.owner !== await currentOwner()) throw new Error('Cet envoi appartient à une autre session.');
  if (intent.files.length !== selected.length || intent.files.some((file, index) => file.name !== selected[index].name || file.size !== selected[index].size)) {
    throw new Error('Sélectionnez les mêmes fichiers, dans le même ordre.');
  }
  const formData = new FormData();
  for (const [name, value] of intent.fields) formData.append(name, value);
  for (const file of selected) formData.append('files', file);
  return executeIntent(intent, { receipt: fetchReceipt, save: saveIntent, transport: async (key) => {
    const client = getFetchClient();
    const options = { headers: { 'Idempotency-Key': key }, signal: AbortSignal.timeout(30_000) };
    const response = intent.method === 'DELETE' ? await client.del(intent.path, options) : await client.post(intent.path, formData, options);
    return response.data;
  } });
}
