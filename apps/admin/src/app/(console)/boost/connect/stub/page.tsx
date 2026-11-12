'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Callout } from '@storeforge/ui/components';

/** Dev only: the stand-in for Facebook's "Continue as …" permission screen (stub Meta mode). */
const LABEL: Record<string, string> = {
  ads_management: 'Manage your ads', ads_read: 'Read ad results', business_management: 'Manage your business assets',
  pages_show_list: 'Show a list of your Pages', pages_read_engagement: 'Read content on your Pages',
};

function StubConsent() {
  const p = useSearchParams();
  const [busy, setBusy] = useState(false);
  const redirect = p.get('redirect_uri') ?? '';
  const state = p.get('state') ?? '';
  const scopes = (p.get('scope') ?? '').split(',').filter(Boolean);
  const ok = /^https?:\/\//.test(redirect) && state;
  const go = (allow: boolean) => {
    setBusy(true);
    const q = new URLSearchParams(allow ? { code: `stub_code_${Math.random().toString(36).slice(2, 12)}`, state } : { error: 'access_denied', state });
    window.location.href = `${redirect}?${q}`;
  };
  return (
    <div className="boost-stub">
      <section className="sf-card">
        <p className="sf-eyebrow">Simulated Facebook · dev mode</p>
        <h1 style={{ marginTop: 4 }}>StoreForge would like to</h1>
        {!ok ? <Callout tone="bad">This link is incomplete.</Callout> : (
          <>
            <ul className="boost-stub__list">{scopes.map((s) => <li key={s}><strong>{LABEL[s] ?? s}</strong> <span className="sf-mono sf-hint">{s}</span></li>)}</ul>
            <p className="sf-hint">Signed in as <strong>Test Merchant</strong>. Real Facebook shows this screen in production.</p>
            <div className="sf-row" style={{ gap: 10 }}>
              <button type="button" className="sf-btn sf-btn--brand" disabled={busy} onClick={() => go(true)}>Continue as Test Merchant</button>
              <button type="button" className="sf-btn sf-btn--quiet" disabled={busy} onClick={() => go(false)}>Cancel</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={null}><StubConsent /></Suspense>;
}
