'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { API_URL } from '@/lib/api';
import { Callout } from '@storeforge/ui/components';

function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error('That email and password don’t match.');
      window.location.href = '/launchpad';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally { setLoading(false); }
  }

  return (
    <form className="sf-card sf-card--ticket" onSubmit={onSubmit}>
      <h2>Welcome back</h2>
      <p className="sf-muted">Sign in to your Launchpad.</p>
      <div className="sf-field"><label className="sf-label" htmlFor="email">Email</label><input id="email" className="sf-input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoComplete="email" /></div>
      <div className="sf-field"><label className="sf-label" htmlFor="password">Password</label><input id="password" className="sf-input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" required autoComplete="current-password" /></div>
      {error && <Callout tone="bad">{error}</Callout>}
      <button className="sf-btn sf-btn--brand sf-btn--block" disabled={loading} type="submit">{loading ? 'Signing in…' : 'Sign in'}</button>
      <p className="sf-muted" style={{ marginTop: 14, marginBottom: 0 }}>New here? <a href="/signup">Create an account</a></p>
    </form>
  );
}

export default function LoginPage() {
  return <Suspense fallback={<div className="sf-card"><h2>Welcome back</h2></div>}><LoginForm /></Suspense>;
}
