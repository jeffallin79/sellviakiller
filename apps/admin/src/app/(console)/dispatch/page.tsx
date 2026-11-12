'use client';

import { useEffect, useState } from 'react';
import { api, API_URL } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Callout, Money, StatusBadge } from '@storeforge/ui/components';

const FLAG: Record<string, string> = {
  payment_mismatch: 'Payment needs review',
  dispute_open: 'Card dispute open',
  dispute_lost: 'Dispute lost',
  refund_failed: 'Refund failed',
};

export default function DispatchPage() {
  const [orders, setOrders] = useState<any[] | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');

  const refresh = () => api<any[]>('/orders').then(setOrders).catch((e) => setAuthError(e.message));
  useEffect(() => { refresh(); }, []);

  async function approve(orderId: string) {
    setError(''); setMsg('');
    try {
      await api(`/fulfillment/orders/${orderId}/approve`, { method: 'POST' });
      setMsg(`Order #${orderId.slice(-8).toUpperCase()} sent to the supplier.`);
      refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not send to supplier'); }
  }

  async function refund(o: any) {
    const left = o.totalCents - (o.refundedCents ?? 0);
    const input = window.prompt(`Refund how much to ${o.customerName}? Up to $${(left / 100).toFixed(2)}. The customer gets an email when it goes through.`, (left / 100).toFixed(2));
    if (input == null) return;
    const cents = Math.round(Number(input.replace(/[^0-9.]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents <= 0 || cents > left) { setError(`Enter an amount between $0.01 and $${(left / 100).toFixed(2)}.`); return; }
    setError(''); setMsg('');
    try {
      const r = await api<any>(`/orders/${o.id}/refunds`, { method: 'POST', body: JSON.stringify({ amountCents: cents, requestId: crypto.randomUUID() }) });
      setMsg(r.status === 'succeeded' ? `Refunded $${(cents / 100).toFixed(2)} on order #${o.id.slice(-8).toUpperCase()}. The customer has been emailed.` : `Refund of $${(cents / 100).toFixed(2)} sent to Stripe. We'll email the customer when it completes.`);
      refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Refund failed'); }
  }

  if (authError) return <SignInNeeded error={authError} />;
  const list = orders ?? [];
  const count = (s: string[]) => list.filter((o) => s.includes(o.status)).length;
  const flagged = list.filter((o) => o.flag);

  return (
    <>
      <PageHead
        eyebrow="Dispatch · orders"
        icon="dispatch"
        title="Dispatch"
        lede="Every paid order lands here. Approve it and we pass it to the supplier; tracking appears when they ship."
        actions={<a className="sf-btn sf-btn--quiet" href={`${API_URL}/api/export/orders.csv`}><Icon name="export" size={18} />Export CSV</a>}
      />
      <div className="lanes" aria-label="Order counts">
        <div className="lane"><StatusBadge status="AWAITING_MERCHANT_APPROVAL" /><span className="sf-num">{count(['AWAITING_MERCHANT_APPROVAL'])}</span></div>
        <div className="lane"><StatusBadge status="FULFILLMENT_SUBMITTED" /><span className="sf-num">{count(['FULFILLMENT_SUBMITTED', 'PAID'])}</span></div>
        <div className="lane"><StatusBadge status="SHIPPED" /><span className="sf-num">{count(['SHIPPED', 'DELIVERED'])}</span></div>
      </div>
      {flagged.length > 0 && (
        <Callout tone="bad" title={`${flagged.length} order${flagged.length === 1 ? ' needs' : 's need'} attention`}>
          {flagged.map((o) => (
            <div key={o.id}><span className="sf-mono">#{o.id.slice(-8).toUpperCase()}</span> · {FLAG[o.flag] ?? o.flag}{o.flagDetail ? <span className="sf-muted"> — {o.flagDetail}</span> : null}</div>
          ))}
        </Callout>
      )}
      {msg && <Callout tone="ok">{msg}</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}
      <div className="sf-card sf-card--flush">
        {orders === null ? (
          <p className="sf-muted" style={{ padding: 20, margin: 0 }}>Loading…</p>
        ) : list.length === 0 ? (
          <p className="sf-muted" style={{ padding: 20, margin: 0 }}>No orders yet. Share your store link and they&apos;ll show up here.</p>
        ) : (
          <div className="sf-table-wrap">
            <table className="sf-table">
              <thead>
                <tr><th>Order</th><th>Placed</th><th>Store</th><th>Customer</th><th className="sf-num">Total</th><th>Status</th><th>Tracking</th><th><span className="sf-sr-only">Action</span></th></tr>
              </thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.id}>
                    <td className="sf-mono">#{o.id.slice(-8).toUpperCase()}</td>
                    <td className="sf-mono sf-muted">{new Date(o.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                    <td>{o.store?.name ?? o.store?.slug}</td>
                    <td>{o.customerName}<br /><span className="sf-muted" style={{ fontSize: '0.8rem' }}>{o.customerEmail}</span></td>
                    <td className="sf-num"><Money cents={o.totalCents} />{o.refundedCents > 0 && o.status !== 'REFUNDED' && <><br /><span className="sf-muted" style={{ fontSize: '0.8rem' }}>−<Money cents={o.refundedCents} /> refunded</span></>}</td>
                    <td><StatusBadge status={o.status} />{o.flag && <><br /><Badge tone="bad">{FLAG[o.flag] ?? o.flag}</Badge></>}</td>
                    <td className="sf-mono" style={{ fontSize: '0.82rem' }}>
                      {o.fulfillment?.trackingNumber ? <>{o.fulfillment.carrier}<br />{o.fulfillment.trackingNumber}</> : <span className="sf-muted">—</span>}
                    </td>
                    <td>
                      <div className="sf-row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {o.status === 'AWAITING_MERCHANT_APPROVAL' && (
                          <button className="sf-btn sf-btn--sm sf-btn--brand" onClick={() => approve(o.id)}><Icon name="dispatch" size={16} />Send to supplier</button>
                        )}
                        {['PAID', 'AWAITING_MERCHANT_APPROVAL', 'FULFILLMENT_SUBMITTED', 'SHIPPED', 'DELIVERED'].includes(o.status) && o.totalCents > (o.refundedCents ?? 0) && (
                          <button className="sf-btn sf-btn--sm sf-btn--quiet" onClick={() => refund(o)}><Icon name="refund" size={16} />Refund</button>
                        )}
                        {o.status !== 'PENDING_PAYMENT' && <a className="sf-btn sf-btn--sm sf-btn--quiet" href={`/emails?orderId=${o.id}`} aria-label={`Emails for order ${o.id.slice(-8).toUpperCase()}`}><Icon name="email" size={16} />Emails</a>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
