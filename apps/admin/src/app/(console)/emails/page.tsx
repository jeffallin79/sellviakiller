'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Callout, StatusBadge } from '@storeforge/ui/components';

type Mail = { id: string; kind: string; to: string; from: string; subject: string; status: string; transport: string | null; attempts: number; lastError: string | null; sentAt: string | null; createdAt: string; orderId: string | null };
const KIND: Record<string, string> = { ORDER_CONFIRMED: 'Confirmation', ORDER_SHIPPED: 'Shipped', ORDER_DELIVERED: 'Delivered', ORDER_REFUNDED: 'Refund', CART_REMINDER_1: 'Bag reminder 1', CART_REMINDER_2: 'Bag reminder 2' };
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function EmailsInner() {
  const params = useSearchParams();
  const orderId = params.get('orderId') ?? '';
  const [data, setData] = useState<{ transport: string; fromAddress: string; items: Mail[] } | null>(null);
  const [sel, setSel] = useState<string>('');
  const [html, setHtml] = useState<string>('');
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');

  const refresh = useCallback(() => api<any>(`/emails${orderId ? `?orderId=${encodeURIComponent(orderId)}` : ''}`).then((d) => {
    setData(d);
    setSel((cur) => cur || params.get('id') || d.items[0]?.id || '');
  }).catch((e) => setAuthError(e.message)), [orderId, params]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!sel) { setHtml(''); return; }
    api<string>(`/emails/${sel}/html`).then(setHtml).catch((e) => setError(e.message));
  }, [sel]);

  async function retry(id: string) {
    setError('');
    try { await api(`/emails/${id}/retry`, { method: 'POST' }); refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not send'); }
  }

  if (authError) return <SignInNeeded error={authError} />;
  const items = data?.items ?? [];
  const m = items.find((x) => x.id === sel);

  return (
    <>
      <PageHead eyebrow="Dispatch · customer emails" icon="email" title="Emails" lede="Every receipt, shipping update and bag reminder we sent your customers, exactly as they saw it." />
      {data?.transport === 'outbox' && (
        <Callout tone="info" title="Dev outbox">Emails are saved, not sent: you can read them here and in the API&apos;s <span className="sf-mono">.outbox</span> folder. Add a Resend API key to deliver them for real.</Callout>
      )}
      {orderId && <Callout tone="info" action={<a className="sf-btn sf-btn--sm sf-btn--quiet" href="/emails">Show all</a>}>Showing emails for order <span className="sf-mono">#{orderId.slice(-8).toUpperCase()}</span>.</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}
      <div className="mail">
        <div className="sf-card sf-card--flush mail__list" role="list" aria-label="Sent emails">
          {data === null ? <p className="sf-muted" style={{ padding: 20, margin: 0 }}>Loading…</p> : items.length === 0 ? (
            <p className="sf-muted" style={{ padding: 20, margin: 0 }}>No emails yet. A confirmation goes out the moment an order is paid.</p>
          ) : items.map((x) => (
            <div role="listitem" key={x.id}>
              <button type="button" aria-pressed={x.id === sel} onClick={() => setSel(x.id)}>
                <span className="mail__meta"><Badge tone={x.kind === 'ORDER_REFUNDED' ? 'neutral' : x.kind === 'ORDER_CONFIRMED' ? 'money' : 'brand'}>{KIND[x.kind] ?? x.kind}</Badge><StatusBadge status={x.status} /><span className="sf-mono">{when(x.createdAt)}</span></span>
                <span className="mail__subj">{x.subject}</span>
                <span className="mail__meta">{x.to}</span>
              </button>
            </div>
          ))}
        </div>
        <div className="sf-card">
          {m ? (
            <>
              <div className="mail__head">
                <div className="sf-spread"><strong>{m.subject}</strong>{m.status !== 'SENT' && m.status !== 'CANCELLED' && <button className="sf-btn sf-btn--sm sf-btn--brand" onClick={() => retry(m.id)}><Icon name="sync" size={16} />Send again</button>}</div>
                <span className="sf-muted">From <span className="sf-mono">{m.from}</span></span>
                <span className="sf-muted">To <span className="sf-mono">{m.to}</span> · {m.status === 'SENT' ? `${m.transport === 'outbox' ? 'saved to outbox' : 'sent'} ${when(m.sentAt ?? m.createdAt)}` : `${m.attempts} attempt${m.attempts === 1 ? '' : 's'}`}</span>
                {m.lastError && m.status !== 'SENT' && <Callout tone="bad">{m.lastError}</Callout>}
              </div>
              {/* sandbox="" : no scripts, no same-origin, no navigation — the email is untrusted content */}
              <iframe className="mail__frame" title={`Preview: ${m.subject}`} sandbox="" srcDoc={html} />
            </>
          ) : <p className="sf-muted" style={{ margin: 0 }}>Pick an email to preview it.</p>}
        </div>
      </div>
    </>
  );
}

export default function EmailsPage() {
  return <Suspense fallback={<p className="sf-muted">Loading…</p>}><EmailsInner /></Suspense>;
}
