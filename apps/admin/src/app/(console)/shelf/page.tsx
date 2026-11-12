'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, API_URL } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Callout, Money } from '@storeforge/ui/components';
import { ProductImage } from '@storeforge/ui/product-image';

const MARKUP = 50;

export default function ShelfPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<any>('/catalog/products?take=50')
      .then((r) => { setProducts(r.items); setTotal(r.total); })
      .catch((e) => setAuthError(e.message));
    api<any[]>('/stores').then((s) => { setStores(s); if (s[0]) setStoreId(s[0].id); }).catch(() => null);
  }, []);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function importSelected() {
    if (!storeId || selected.size === 0) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const res = await api<any>(`/stores/${storeId}/import`, { method: 'POST', body: JSON.stringify({ productIds: Array.from(selected), markupPercent: MARKUP }) });
      setMsg(`Added ${res.imported} product${res.imported === 1 ? '' : 's'} to your store.`);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add products');
    } finally { setBusy(false); }
  }

  async function syncCj() {
    setError(''); setMsg('');
    try {
      const res = await api<any>('/catalog/sync', { method: 'POST' });
      setMsg(res.note ?? `Updated ${res.upserted} products from CJ.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Sync failed'); }
  }

  if (authError) return <SignInNeeded error={authError} />;

  return (
    <>
      <PageHead
        eyebrow="Shelf · supplier catalog"
        icon="shelf"
        title="Shelf"
        lede={<>Pick what to sell. You see the supplier cost, your price at +{MARKUP}%, and the real shipping time before you add anything. <span className="sf-num">{total}</span> products available.</>}
        actions={<a className="sf-btn sf-btn--quiet" href={`${API_URL}/api/export/products.csv`}><Icon name="export" size={18} />Export CSV</a>}
      />

      <div className="toolbar">
        <div className="sf-field">
          <label className="sf-label" htmlFor="store">Add to store</label>
          <select id="store" className="sf-select" value={storeId} onChange={(e) => setStoreId(e.target.value)} disabled={stores.length === 0}>
            {stores.length === 0 && <option>No store yet</option>}
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>)}
          </select>
        </div>
        <div className="toolbar__push">
          <button className="sf-btn sf-btn--quiet" onClick={syncCj}><Icon name="sync" size={18} />Refresh from CJ</button>
          <button className="sf-btn sf-btn--brand" onClick={importSelected} disabled={busy || selected.size === 0 || !storeId}>
            <Icon name="add" size={18} />Add {selected.size || ''} to store
          </button>
        </div>
      </div>
      {stores.length === 0 && <Callout tone="info">Open a store first, then add products to it. <Link href="/stores">Open a store</Link></Callout>}
      {msg && <Callout tone="ok">{msg}</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}

      <div className="sf-card sf-card--flush">
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead>
              <tr>
                <th><span className="sf-sr-only">Select</span></th>
                <th>Product</th>
                <th className="sf-num">Cost</th>
                <th className="sf-num">You sell at</th>
                <th className="sf-num">You keep</th>
                <th>Ships in</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const sell = Math.round(p.costCents * (1 + MARKUP / 100));
                return (
                  <tr key={p.id}>
                    <td><input className="sf-check" type="checkbox" aria-label={`Select ${p.title}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
                    <td>
                      <div className="prodcell">
                        <span className="thumb"><ProductImage src={p.imageUrl} alt={p.title} /></span>
                        <div><strong>{p.title}</strong><span className="sf-mono sf-muted" style={{ fontSize: '0.78rem' }}>{p.sku}</span></div>
                      </div>
                    </td>
                    <td className="sf-num"><Money cents={p.costCents} /></td>
                    <td className="sf-num"><Money cents={sell} /></td>
                    <td className="sf-num"><Money cents={sell - p.costCents} /></td>
                    <td><Badge><Icon name="eta" size={14} />{p.etaDaysMin}–{p.etaDaysMax} days</Badge></td>
                    <td className="sf-muted">{p.sourcingLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="sf-muted" style={{ marginTop: 12, fontSize: '0.85rem' }}>“You keep” is before payment processing fees and ad spend. No StoreForge commission on orders.</p>
    </>
  );
}
