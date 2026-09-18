'use client';

import { useEffect, useState } from 'react';
import { api, API_URL } from '@/lib/api';

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  function refresh() {
    api<any[]>('/orders').then(setOrders).catch((e) => setError(e.message));
  }

  useEffect(() => { refresh(); }, []);

  async function approve(orderId: string) {
    try {
      await api(`/fulfillment/orders/${orderId}/approve`, { method: 'POST' });
      setMsg(`Approved ${orderId}`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <div>
      <h1>Orders</h1>
      <p className="muted">
        <a href={`${API_URL}/api/export/orders.csv`}>Export orders CSV</a>
      </p>
      {msg && <p className="ok">{msg}</p>}
      {error && <p className="error">{error}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Store</th><th>Customer</th><th>Total</th>
              <th>Status</th><th>Tracking</th><th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>{o.id.slice(-8)}</td>
                <td>{o.store?.slug}</td>
                <td>{o.customerEmail}</td>
                <td>${(o.totalCents / 100).toFixed(2)}</td>
                <td><span className="badge">{o.status}</span></td>
                <td className="muted">
                  {o.fulfillment?.trackingNumber
                    ? `${o.fulfillment.carrier} ${o.fulfillment.trackingNumber}`
                    : '—'}
                </td>
                <td>
                  {o.status === 'AWAITING_MERCHANT_APPROVAL' && (
                    <button className="btn" onClick={() => approve(o.id)}>Approve</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {orders.length === 0 && <p className="muted">No orders yet — checkout on the storefront.</p>}
      </div>
    </div>
  );
}
