'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export default function DashboardPage() {
  const [me, setMe] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/me')
      .then(setMe)
      .catch((e) => setError(e.message));
  }, []);

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
      <div className="grid">
        <a className="card" href="/dashboard/billing"><h3>1. Subscribe</h3><p className="muted">Square Starter $29</p></a>
        <a className="card" href="/dashboard/stores"><h3>2. Provision store</h3><p className="muted">slug.storeforge.local</p></a>
        <a className="card" href="/dashboard/catalog"><h3>3. Import catalog</h3><p className="muted">1-click import</p></a>
        <a className="card" href="/dashboard/orders"><h3>4. Orders</h3><p className="muted">Approve fulfillment</p></a>
      </div>
    </div>
  );
}
