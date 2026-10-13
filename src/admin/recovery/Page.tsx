import React, { useEffect, useState } from 'react';
import { useAuth } from '@strapi/admin/strapi-admin';
import { fetchReceipt, readIntents, resumeIntent, saveIntent } from './client';
import type { MediaIntent } from './client-core';

const labels = { pending: 'Résultat en cours de vérification', interrupted: 'Transfert interrompu, reprise possible', committed: 'Terminé', failed: 'Non terminé' };
export default function RecoveryPage() {
  const user = useAuth('GthfMediaRecovery', (state) => state.user);
  const owner = user?.id ? `admin:${user.id}` : null;
  const [items, setItems] = useState<MediaIntent[]>([]);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!owner) return;
    let stopped = false;
    let active = false;
    const refresh = async () => {
      if (active) return;
      active = true;
      try {
        const rows = readIntents(owner);
        for (const item of rows.filter((row) => row.status === 'pending' || row.status === 'interrupted')) {
          const receipt = await fetchReceipt(item.key);
          saveIntent({ ...item, status: receipt?.status || 'interrupted', message: receipt?.error });
        }
        if (!stopped) { setItems(readIntents(owner)); setUnavailable(false); }
      } catch { if (!stopped) setUnavailable(true); }
      finally { active = false; }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [owner]);
  const resume = async (item: MediaIntent, files: File[]) => {
    setBusy(item.key); setError('');
    try { await resumeIntent(item, files); setItems(readIntents(owner!)); }
    catch (failure: any) { setError(failure.message); }
    finally { setBusy(null); }
  };
  return <main style={{ padding: '2rem', maxWidth: 900 }}>
    <h1>Reprise des médias</h1>
    <p>Retrouvez ici le résultat des envois de cet onglet après une interruption. Un envoi terminé ne doit pas être recommencé. Une nouvelle sélection dans la médiathèque crée un nouvel envoi.</p>
    {error && <p role="alert">{error}</p>}
    {unavailable && <p role="status">Le CMS est temporairement indisponible. Les envois restent conservés dans cet onglet.</p>}
    {!items.length && <p>Aucun envoi à vérifier dans cet onglet.</p>}
    <ul>{items.map((item) => <li key={item.key} style={{ margin: '1.5rem 0' }}>
      <strong>{item.files.map((file) => file.name).join(', ') || 'Suppression de média'}</strong>
      <p role="status">{labels[item.status]}</p>
      {item.status === 'interrupted' && (item.method === 'DELETE'
        ? <button disabled={busy !== null} onClick={() => void resume(item, [])}>Reprendre la suppression</button>
        : <label>Sélectionner les mêmes fichiers pour reprendre <input aria-label="Fichiers de la reprise" type="file" multiple={item.files.length > 1} disabled={busy !== null}
          onChange={(event) => { if (event.target.files?.length) void resume(item, Array.from(event.target.files)); }} /></label>)}
      {busy === item.key && <p>Reprise en cours…</p>}
    </li>)}</ul>
    <a href="/admin/plugins/upload">Retour à la médiathèque</a>
  </main>;
}
