'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function DashboardPage() {
  const [me, setMe] = useState<any>(null);
  const [error, setError] = useState('');
  const [payouts, setPayouts] = useState<any>(null);

  useEffect(() => {
    api('/me')
      .then(setMe)
      .catch((e) => setError(e.message));
    api('/payouts/status').then(setPayouts).catch(() => setPayouts(null));
  }, []);

  async function onboard() {
    const res = await api<any>('/payouts/onboard', { method: 'POST' });
    window.location.href = res.url;
  }

  if (error) {
    return (
      <div className="card">
        <h1>Dashboard</h1>
        <p className="error">{error}</p>
        <a className="btn" href="/login">Sign in</a>
      </div>
    );
  }

  if (!me) return <p className="muted">Loading…</p>;

  const account = me.memberships?.[0]?.account;

  return (
    <div>
      <h1>Welcome, {me.name ?? me.email}</h1>
      <div className="card">
        <h2>Account</h2>
        <p>{account?.name}</p>
        <p className="muted">
          Plan:{' '}
          <span className="badge">
            {account?.subscription?.plan?.name ?? 'None'} —{' '}
            {account?.subscription?.status ?? 'unsubscribed'}
          </span>
        </p>
        <p className="muted">Stores: {account?.stores?.length ?? 0}</p>
      </div>
      <div className="card">
        <h2>Get paid</h2>
        {payouts?.ready ? (
          <p className="ok">Payouts connected ({payouts.provider}). Charges {payouts.chargesEnabled ? 'on' : 'off'} · payouts {payouts.payoutsEnabled ? 'on' : 'pending'}</p>
        ) : (
          <>
            <p className="muted">Connect a Stripe payout account so your store can take orders.</p>
            <button className="btn" onClick={onboard}>Set up payouts</button>
          </>
        )}
      </div>
      <div className="grid">
        <a className="card" href="/dashboard/billing"><h3>1. Subscribe</h3><p className="muted">Starter $29/mo</p></a>
        <a className="card" href="/dashboard/stores"><h3>2. Provision store</h3><p className="muted">slug.storeforge.local</p></a>
        <a className="card" href="/dashboard/catalog"><h3>3. Import catalog</h3><p className="muted">1-click import</p></a>
        <a className="card" href="/dashboard/orders"><h3>4. Orders</h3><p className="muted">Approve fulfillment</p></a>
      </div>
    </div>
  );
}
