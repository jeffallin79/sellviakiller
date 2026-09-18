'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function CatalogPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api<any>('/catalog/products?take=50').then((r) => {
      setProducts(r.items);
      setTotal(r.total);
    }).catch((e) => setError(e.message));
    api<any[]>('/stores').then((s) => {
      setStores(s);
      if (s[0]) setStoreId(s[0].id);
    });
  }, []);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function importSelected() {
    if (!storeId || selected.size === 0) return;
    try {
      const res = await api<any>(`/stores/${storeId}/import`, {
        method: 'POST',
        body: JSON.stringify({
          productIds: Array.from(selected),
          markupPercent: 50,
        }),
      });
      setMsg(`Imported ${res.imported} products`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    }
  }

  async function syncCj() {
    const res = await api<any>('/catalog/sync', { method: 'POST' });
    setMsg(res.note ?? `Upserted ${res.upserted}`);
  }

  return (
    <div>
      <h1>Platform catalog</h1>
      <p className="muted">{total} SKUs · fixtures if CJ keys missing</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.slug})</option>
          ))}
        </select>
        <button className="btn" onClick={importSelected}>1-click import selected</button>
        <button className="btn secondary" onClick={syncCj}>Sync CJ</button>
        <a className="btn secondary" href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/export/products.csv`}>
          Export CSV
        </a>
      </div>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th></th><th>Title</th><th>SKU</th><th>Cost</th><th>ETA</th><th>Sourcing</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                    style={{ width: 'auto' }}
                  />
                </td>
                <td>{p.title}</td>
                <td>{p.sku}</td>
                <td>${(p.costCents / 100).toFixed(2)}</td>
                <td>{p.etaDaysMin}–{p.etaDaysMax}d</td>
                <td className="muted">{p.sourcingLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
