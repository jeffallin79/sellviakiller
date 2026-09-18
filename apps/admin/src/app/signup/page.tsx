'use client';

import { useState } from 'react';
import { api, API_URL } from '@/lib/api';

export default function SignupPage() {
  const [name, setName] = useState('Demo Merchant');
  const [email, setEmail] = useState('merchant@storeforge.local');
  const [password, setPassword] = useState('password123');
  const [accountName, setAccountName] = useState('Demo Account');
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
      if (!res.ok) throw new Error(await res.text());
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
        <input value={name} onChange={(e) => setName(e.target.value)} required />
        <label>Account name</label>
        <input value={accountName} onChange={(e) => setAccountName(e.target.value)} required />
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        <label>Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" minLength={8} required />
        {error && <p className="error">{error}</p>}
        {msg && <p className="ok">{msg}</p>}
        <button className="btn" type="submit">Sign up</button>
      </form>
    </div>
  );
}
