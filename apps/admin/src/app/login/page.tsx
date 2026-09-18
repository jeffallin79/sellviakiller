'use client';

import { useState } from 'react';
import { API_URL } from '@/lib/api';

export default function LoginPage() {
  const [email, setEmail] = useState('merchant@storeforge.local');
  const [password, setPassword] = useState('password123');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(await res.text());
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h1>Sign in</h1>
      <p className="muted">Better Auth email/password</p>
      <form onSubmit={onSubmit}>
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        <label>Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={loading} type="submit">
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted">
        No account? <a href="/signup">Sign up</a>
      </p>
    </div>
  );
}
