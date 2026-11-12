'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Callout, Money } from '@storeforge/ui/components';

type Mail = { id: string; kind: string; status: string; sentAt: string | null; lastError: string | null };
type Cart = { id: string; email: string | null; status: string; consent: boolean; itemCount: number; subtotalCents: number; lastActivityAt: string; reminder1At: string | null; reminder2At: string | null; recoveredAt: string | null; convertedAt: string | null; recoveredCents: number | null; emails: Mail[] };
type Overview = {
  settings: { enabled: boolean; mailingAddress: string | null; ready: boolean };
  timing: { reminder1Minutes: number; reminder2Hours: number; expireDays: number };
  consentText: string;
  stats: { windowDays: number; captured: number; remindersSent: number; recoveredOrders: number; recoveredCents: number; unsubscribed: number };
  carts: Cart[];
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–');
const STATUS: Record<string, { t: string; tone: 'ok' | 'info' | 'neutral' | 'warn' | 'money' }> = {
  OPEN: { t: 'Waiting', tone: 'info' }, CONVERTED: { t: 'Bought', tone: 'ok' }, OPTED_OUT: { t: 'Unsubscribed', tone: 'neutral' }, EXPIRED: { t: 'Expired', tone: 'neutral' },
};

function Step({ c, n }: { c: Cart; n: 1 | 2 }) {
  const m = c.emails.find((e) => e.kind === `CART_REMINDER_${n}`);
  const at = n === 1 ? c.reminder1At : c.reminder2At;
  if (m) {
    if (m.status === 'SENT') return <span className="sf-muted"><Badge tone="ok">Sent</Badge> {when(m.sentAt)}</span>;
    if (m.status === 'CANCELLED') return <span title={m.lastError ?? ''}><Badge>Not sent</Badge> <span className="sf-muted">{(m.lastError ?? '').replace('not sent: ', '').replace(/_/g, ' ')}</span></span>;
    return <Badge tone={m.status === 'FAILED' ? 'warn' : 'info'}>{m.status === 'FAILED' ? 'Failed' : 'Queued'}</Badge>;
  }
  if (at) return <span className="sf-muted" title="This address already got reminders this week">Skipped (weekly limit)</span>;
  if (c.status !== 'OPEN' || !c.consent || (n === 2 && !c.reminder1At)) return <span className="sf-muted">–</span>;
  return <span className="sf-muted">Scheduled</span>;
}

export default function RecoveryPage() {
  const [stores, setStores] = useState<any[]>([]);
  const [storeId, setStoreId] = useState('');
  const [o, setO] = useState<Overview | null>(null);
  const [addr, setAddr] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<any[]>('/stores').then((s) => {
      setStores(s);
      const want = new URLSearchParams(window.location.search).get('store');
      setStoreId((s.find((x) => x.slug === want || x.id === want) ?? s[0])?.id ?? '');
    }).catch((e) => setAuthError(e.message));
  }, []);
  const load = useCallback(() => {
    if (!storeId) return;
    api<Overview>(`/stores/${storeId}/cart-recovery`).then((d) => { setO(d); setAddr(d.settings.mailingAddress ?? ''); }).catch((e) => setError(e.message));
  }, [storeId]);
  useEffect(() => { load(); }, [load]);

  async function save(body: { enabled?: boolean; mailingAddress?: string | null }) {
    setBusy(true); setError(''); setMsg('');
    try {
      const d = await api<Overview>(`/stores/${storeId}/cart-recovery`, { method: 'PATCH', body: JSON.stringify(body) });
      setO(d); setAddr(d.settings.mailingAddress ?? '');
      setMsg(d.settings.ready ? 'Saved. Reminders are on.' : d.settings.enabled ? 'Saved. Add a mailing address to start sending.' : 'Saved. Reminders are off.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); }
  }

  if (authError) return <SignInNeeded error={authError} />;
  const st = o?.stats;
  return (
    <>
      <PageHead
        eyebrow="Dispatch · abandoned bags"
        icon="recover"
        title="Recovery"
        lede={<>When a shopper leaves with items in their bag, we can send them a reminder, but only if they ticked the box asking for one. At most two emails, then we stop.</>}
        actions={stores.length > 1 ? <select aria-label="Store" className="sf-select" value={storeId} onChange={(e) => setStoreId(e.target.value)}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select> : undefined}
      />
      {stores.length === 0 && <Callout tone="info">Open a store first. <Link href="/stores">Open a store</Link></Callout>}
      {o && !o.settings.ready && (
        <Callout tone="warn" title={o.settings.enabled ? 'Reminders are waiting on your mailing address' : 'Reminders are off'}>
          {o.settings.enabled ? 'Marketing emails must include a postal address for your business (CAN-SPAM in the US, CASL in Canada). Add one below and reminders start.' : 'Shoppers can still tick the box, but nothing is sent until you turn reminders on.'}
        </Callout>
      )}
      {msg && <Callout tone="ok">{msg}</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}
      {o && st && (
        <>
          <div className="sf-kpis" style={{ marginBottom: 18 }}>
            <div className="sf-kpi"><span className="sf-kpi__label"><Icon name="bag" size={16} />Bags saved ({st.windowDays} d)</span><div className="sf-kpi__value">{st.captured}</div></div>
            <div className="sf-kpi"><span className="sf-kpi__label"><Icon name="email" size={16} />Reminders sent</span><div className="sf-kpi__value">{st.remindersSent}</div></div>
            <div className="sf-kpi"><span className="sf-kpi__label"><Icon name="done" size={16} />Bought after a reminder</span><div className="sf-kpi__value">{st.recoveredOrders}</div></div>
            <div className="sf-kpi"><span className="sf-kpi__label"><Icon name="money" size={16} />Recovered sales</span><div className="sf-kpi__value"><Money cents={st.recoveredCents} /></div></div>
            <div className="sf-kpi"><span className="sf-kpi__label"><Icon name="close" size={16} />Unsubscribed</span><div className="sf-kpi__value">{st.unsubscribed}</div></div>
          </div>
          <div className="recovery-grid">
            <div className="sf-card">
              <h3 className="mboost-h"><Icon name="seal" size={20} />Settings</h3>
              <label className="sf-row" style={{ gap: 10, alignItems: 'center', margin: '4px 0 14px' }}>
                <input type="checkbox" className="sf-check" checked={o.settings.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked, ...(e.target.checked && addr.trim() ? { mailingAddress: addr } : {}) })} />
                <span><strong>Send bag reminders</strong> to shoppers who ask for them</span>
              </label>
              <div className="sf-field">
                <label className="sf-label" htmlFor="addr">Business mailing address (printed in every reminder)</label>
                <input id="addr" className="sf-input" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Street, city, region, postal code, country" maxLength={300} />
                <span className="sf-hint">A PO box is fine. Required by CAN-SPAM and CASL for marketing email.</span>
              </div>
              <button className="sf-btn sf-btn--brand" disabled={busy || addr.trim() === (o.settings.mailingAddress ?? '')} onClick={() => save({ mailingAddress: addr.trim() || null, ...(addr.trim() ? {} : { enabled: false }) })}>Save address</button>
            </div>
            <div className="sf-card">
              <h3 className="mboost-h"><Icon name="info" size={20} />What shoppers see</h3>
              <div className="optin-preview"><input type="checkbox" className="sf-check" disabled aria-label="Example opt-in box (unticked by default)" /><span>{o.consentText}</span></div>
              <ul className="timeline">
                <li><strong>+{o.timing.reminder1Minutes} min</strong><span>“Your bag is still here.” Their items and a link back.</span></li>
                <li><strong>+{o.timing.reminder2Hours} h</strong><span>“No rush. Here is your bag one more time.” The last one.</span></li>
                <li><strong>Always</strong><span>One-click unsubscribe, your address, no discounts or countdowns. Nothing goes out once they buy or unsubscribe.</span></li>
              </ul>
              <p className="sf-hint" style={{ marginBottom: 0 }}>The box is unticked by default. Without it we keep nothing about the bag. Preview sent reminders in <Link href="/emails">Emails</Link>.</p>
            </div>
          </div>
          <h2 className="section-title"><Icon name="bag" size={22} />Saved bags</h2>
          <div className="sf-card sf-card--flush">
            <div className="sf-table-wrap">
              <table className="sf-table">
                <thead><tr><th>Shopper</th><th className="sf-num">Bag</th><th>Status</th><th>Last activity</th><th>Reminder 1</th><th>Reminder 2</th><th className="sf-num">Recovered</th></tr></thead>
                <tbody>
                  {o.carts.length === 0 && <tr><td colSpan={7} className="sf-muted">No saved bags yet. They show up here when a shopper ticks “email me a reminder” at checkout.</td></tr>}
                  {o.carts.map((c) => {
                    const s = STATUS[c.status] ?? { t: c.status, tone: 'neutral' as const };
                    return (
                      <tr key={c.id}>
                        <td className="sf-mono">{c.email ?? <span className="sf-muted">(removed)</span>}</td>
                        <td className="sf-num"><Money cents={c.subtotalCents} /><span className="sf-muted" style={{ display: 'block', fontSize: '0.78rem' }}>{c.itemCount} item{c.itemCount === 1 ? '' : 's'}</span></td>
                        <td><Badge tone={s.tone}>{s.t}</Badge>{c.recoveredAt && c.status === 'OPEN' && <span className="sf-muted" style={{ display: 'block', fontSize: '0.78rem' }}>opened the link</span>}</td>
                        <td className="sf-muted">{when(c.lastActivityAt)}</td>
                        <td><Step c={c} n={1} /></td>
                        <td><Step c={c} n={2} /></td>
                        <td className="sf-num">{c.recoveredCents != null ? <Money cents={c.recoveredCents} /> : <span className="sf-muted">–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <p className="sf-hint" style={{ marginTop: 10 }}>Addresses are partly hidden here and deleted once a bag is bought, expires ({o.timing.expireDays} days) or the shopper unsubscribes.</p>
        </>
      )}
    </>
  );
}
