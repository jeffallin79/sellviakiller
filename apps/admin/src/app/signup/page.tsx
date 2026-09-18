'use client';

import { useState } from 'react';
import { api, API_URL } from '@/lib/api';

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
      await api('/auth/bootstrap', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, accountName }),
      });
      const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        // Account created but auto sign-in failed — send to login with email prefilled
        setMsg('Account created — redirecting to sign in…');
        window.location.href = `/login?email=${encodeURIComponent(email)}`;
        return;
      }
      setMsg('Account created — redirecting…');
      window.location.href = '/dashboard/billing';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    }
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h1>Create merchant account</h1>
      <form onSubmit={onSubmit}>
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
        <label>Account name</label>
        <input value={accountName} onChange={(e) => setAccountName(e.target.value)} required />
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required autoComplete="email" />
        <label>Password</label>
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          minLength={8}
          required
          autoComplete="new-password"
        />
        {error && <p className="error">{error}</p>}
        {msg && <p className="ok">{msg}</p>}
        <button className="btn" type="submit">Sign up</button>
      </form>
      <p className="muted" style={{ marginTop: 12 }}>
        Already have an account? <a href={`/login${email ? `?email=${encodeURIComponent(email)}` : ''}`}>Sign in</a>
      </p>
    </div>
  );
}
