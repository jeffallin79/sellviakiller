'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Callout, Collage, StatusBadge } from '@storeforge/ui/components';

const ROOT = process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local';
const SHOP = process.env.NEXT_PUBLIC_STOREFRONT_URL ?? 'http://localhost:3000';

export default function StoresPage() {
  const [stores, setStores] = useState<any[] | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');

  const refresh = () => api<any[]>('/stores').then(setStores).catch((e) => setAuthError(e.message));
  useEffect(() => { refresh(); }, []);

  async function createStore(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setMsg('');
    try {
      const res = await api<any>('/stores', { method: 'POST', body: JSON.stringify({ name, slug }) });
      setMsg(`Your store is open at ${res.url}`);
      setName(''); setSlug('');
      refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not open store'); }
  }

  async function archive(id: string, storeName: string) {
    if (!window.confirm(`Archive ${storeName}? It goes offline, but its data stays and you can export it.`)) return;
    await api(`/stores/${id}`, { method: 'DELETE' });
    refresh();
  }

  if (authError) return <SignInNeeded error={authError} />;

  return (
    <>
      <PageHead eyebrow="Stores" icon="stores" title="Stores" lede="Each store gets its own web address. Archiving takes a store offline but never deletes its orders or products." />
      <div className="grid-2">
        <form className="sf-card sf-card--ticket" onSubmit={createStore}>
          <h2>Open a store</h2>
          <div className="sf-field">
            <label className="sf-label" htmlFor="name">Store name</label>
            <input id="name" className="sf-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Juniper Goods" required />
          </div>
          <div className="sf-field">
            <label className="sf-label" htmlFor="slug">Web address</label>
            <input id="slug" className="sf-input sf-mono" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="juniper" required pattern="[a-z0-9-]{2,}" />
            <span className="sf-hint">Your store will live at <span className="sf-mono">{slug || 'name'}.{ROOT}</span>. Custom domains arrive in the next update.</span>
          </div>
          <button className="sf-btn sf-btn--brand" type="submit"><Icon name="stores" size={18} />Open store</button>
          {msg && <Callout tone="ok">{msg}</Callout>}
          {error && <Callout tone="bad">{error}</Callout>}
        </form>
        <div className="sf-stack">
          {stores === null && <p className="sf-muted">Loading…</p>}
          {stores?.length === 0 && (
            <div className="sf-card empty">
              <Collage />
              <div><h3>No stores yet</h3><p className="sf-muted">Open one on the left. It takes about a minute.</p></div>
            </div>
          )}
          {stores?.map((s) => (
            <article key={s.id} className="sf-card store">
              <div className="sf-spread"><h3 style={{ margin: 0 }}>{s.name}</h3><StatusBadge status={s.status} /></div>
              <a className="store__url" href={`${SHOP}/s/${s.slug}`} target="_blank" rel="noreferrer">{s.slug}.{ROOT}</a>
              <div className="sf-row">
                <a className="sf-btn sf-btn--sm" href={`${SHOP}/s/${s.slug}`} target="_blank" rel="noreferrer"><Icon name="next" size={16} />Visit store</a>
                <button className="sf-btn sf-btn--sm sf-btn--quiet" onClick={() => archive(s.id, s.name)}><Icon name="trash" size={16} />Archive</button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </>
  );
}
