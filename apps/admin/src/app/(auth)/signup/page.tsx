'use client';

import { useState } from 'react';
import { api, API_URL } from '@/lib/api';
import { Callout } from '@storeforge/ui/components';

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountName, setAccountName] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/bootstrap', { method: 'POST', body: JSON.stringify({ name, email, password, accountName }) });
      const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
      });
      if (!res.ok) { setMsg('Account created — taking you to sign in…'); window.location.href = `/login?email=${encodeURIComponent(email)}`; return; }
      setMsg('Account created — opening your Launchpad…');
      window.location.href = '/launchpad';
    } catch (err) { setError(err instanceof Error ? err.message : 'Sign up failed'); }
  }

  return (
    <form className="sf-card sf-card--ticket" onSubmit={onSubmit}>
      <h2>Start your store</h2>
      <p className="sf-muted">Free to set up. You pick a plan before your store goes live.</p>
      <div className="sf-field"><label className="sf-label" htmlFor="name">Your name</label><input id="name" className="sf-input" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" /></div>
      <div className="sf-field"><label className="sf-label" htmlFor="biz">Business name</label><input id="biz" className="sf-input" value={accountName} onChange={(e) => setAccountName(e.target.value)} required autoComplete="organization" /></div>
      <div className="sf-field"><label className="sf-label" htmlFor="email">Email</label><input id="email" className="sf-input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoComplete="email" /></div>
      <div className="sf-field"><label className="sf-label" htmlFor="pw">Password</label><input id="pw" className="sf-input" value={password} onChange={(e) => setPassword(e.target.value)} type="password" minLength={8} required autoComplete="new-password" /><span className="sf-hint">At least 8 characters.</span></div>
      {error && <Callout tone="bad">{error}</Callout>}
      {msg && <Callout tone="ok">{msg}</Callout>}
      <button className="sf-btn sf-btn--brand sf-btn--block" type="submit">Create account</button>
      <p className="sf-muted" style={{ marginTop: 14, marginBottom: 0 }}>Already have one? <a href={`/login${email ? `?email=${encodeURIComponent(email)}` : ''}`}>Sign in</a></p>
    </form>
  );
}
