'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function BillingPage() {
  const [plans, setPlans] = useState<any>(null);
  const [sub, setSub] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/billing/plans').then(setPlans).catch((e) => setError(e.message));
    api('/billing/subscription').then(setSub).catch(() => setSub(null));
  }, []);

  async function subscribe(planId: string) {
    setMsg('');
    setError('');
    try {
      const res = await api<any>('/billing/subscribe', {
        method: 'POST',
        body: JSON.stringify({ planId }),
      });
      setSub(res.subscription);
      setMsg(res.square?.message ?? 'Subscribed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <div>
      <h1>Billing (Square only)</h1>
      <p className="muted">No Stripe. Mode: {plans?.mode ?? '…'}</p>
      {sub && (
        <div className="card">
          <strong>Current:</strong> {sub.plan?.name} — {sub.status}
        </div>
      )}
      <div className="grid">
        {(plans?.plans ?? []).map((p: any) => (
          <div className="card" key={p.id}>
            <h3>{p.name}</h3>
            <p>${p.priceUsd}/mo</p>
            <p className="muted">{p.maxStores} store(s) · {p.maxOrdersPerMonth} orders/mo</p>
            <button className="btn" onClick={() => subscribe(p.id)}>
              Subscribe
            </button>
          </div>
        ))}
      </div>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
