'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function StoresPage() {
  const [stores, setStores] = useState<any[]>([]);
  const [name, setName] = useState('Demo Store');
  const [slug, setSlug] = useState('demo');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  function refresh() {
    api<any[]>('/stores').then(setStores).catch((e) => setError(e.message));
  }

  useEffect(() => { refresh(); }, []);

  async function createStore(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await api<any>('/stores', {
        method: 'POST',
        body: JSON.stringify({ name, slug }),
      });
      setMsg(`Provisioned ${res.url}`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    }
  }

  async function softDelete(id: string) {
    await api(`/stores/${id}`, { method: 'DELETE' });
    refresh();
  }

  return (
    <div>
      <h1>Stores</h1>
      <div className="card">
        <h3>Provision store</h3>
        <form onSubmit={createStore}>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>Slug (subdomain)</label>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} />
          <p className="muted">Will be {slug || '…'}.storeforge.local — add to /etc/hosts</p>
          <button className="btn" type="submit">Create store</button>
        </form>
        {msg && <p className="ok">{msg}</p>}
        {error && <p className="error">{error}</p>}
      </div>
      <div className="card">
        <table>
          <thead>
            <tr><th>Name</th><th>Slug</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.slug}</td>
                <td><span className="badge">{s.status}</span></td>
                <td>
                  <button className="btn secondary" onClick={() => softDelete(s.id)}>
                    Soft-delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
