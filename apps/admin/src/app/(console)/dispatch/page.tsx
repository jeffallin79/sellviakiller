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
      setMsg(`Order #${orderId.slice(-6).toUpperCase()} sent to the supplier.`);
      refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not send to supplier'); }
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
            <div key={o.id}><span className="sf-mono">#{o.id.slice(-6).toUpperCase()}</span> · {FLAG[o.flag] ?? o.flag}{o.flagDetail ? <span className="sf-muted"> — {o.flagDetail}</span> : null}</div>
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
                    <td className="sf-mono">#{o.id.slice(-6).toUpperCase()}</td>
                    <td className="sf-mono sf-muted">{new Date(o.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                    <td>{o.store?.name ?? o.store?.slug}</td>
                    <td>{o.customerName}<br /><span className="sf-muted" style={{ fontSize: '0.8rem' }}>{o.customerEmail}</span></td>
                    <td className="sf-num"><Money cents={o.totalCents} /></td>
                    <td><StatusBadge status={o.status} />{o.flag && <><br /><Badge tone="bad">{FLAG[o.flag] ?? o.flag}</Badge></>}</td>
                    <td className="sf-mono" style={{ fontSize: '0.82rem' }}>
                      {o.fulfillment?.trackingNumber ? <>{o.fulfillment.carrier}<br />{o.fulfillment.trackingNumber}</> : <span className="sf-muted">—</span>}
                    </td>
                    <td>
                      {o.status === 'AWAITING_MERCHANT_APPROVAL' && (
                        <button className="sf-btn sf-btn--sm sf-btn--brand" onClick={() => approve(o.id)}><Icon name="dispatch" size={16} />Send to supplier</button>
                      )}
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
