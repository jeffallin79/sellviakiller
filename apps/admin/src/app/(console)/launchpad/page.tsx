'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Bars, Badge, Callout, Money, StatusBadge, money } from '@storeforge/ui/components';

const DAY = 86400000;
const PAID = ['PAID', 'AWAITING_MERCHANT_APPROVAL', 'FULFILLMENT_SUBMITTED', 'SHIPPED', 'DELIVERED'];

export default function LaunchpadPage() {
  const [me, setMe] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [payouts, setPayouts] = useState<any>(null);
  const [fuel, setFuel] = useState<any>(null);
  const [shelfCount, setShelfCount] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [alerts, setAlerts] = useState<any[]>([]);

  useEffect(() => {
    api<any>('/me')
      .then((m) => {
        setMe(m);
        const store = m.memberships?.[0]?.account?.stores?.[0];
        if (store) api<any[]>(`/storefront/${store.slug}/products`).then((p) => setShelfCount(p.length)).catch(() => setShelfCount(0));
        else setShelfCount(0);
      })
      .catch((e) => setError(e.message));
    api<any[]>('/orders').then(setOrders).catch(() => setOrders([]));
    api<any>('/payouts/status').then(setPayouts).catch(() => setPayouts(null));
    api<any>('/fuel').then(setFuel).catch(() => setFuel(null));
    api<any[]>('/notifications').then((n) => setAlerts(n.filter((x) => !x.readAt))).catch(() => setAlerts([]));
    const q = new URLSearchParams(window.location.search);
    if (q.get('payouts') === 'return') setNotice('Thanks — Stripe is checking your payout details. This page updates when they confirm.');
  }, []);

  const stats = useMemo(() => {
    const now = Date.now();
    const days = Array.from({ length: 7 }, (_, i) => new Date(now - (6 - i) * DAY));
    const paid = orders.filter((o) => PAID.includes(o.status));
    const perDay = days.map((d) => paid.filter((o) => new Date(o.createdAt).toDateString() === d.toDateString()).reduce((a, o) => a + o.totalCents, 0));
    const week = perDay.reduce((a, b) => a + b, 0);
    const prev = paid.filter((o) => { const t = new Date(o.createdAt).getTime(); return t < now - 7 * DAY && t >= now - 14 * DAY; }).reduce((a, o) => a + o.totalCents, 0);
    return {
      perDay,
      labels: days.map((d) => d.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2)),
      week,
      delta: prev > 0 ? Math.round(((week - prev) / prev) * 1000) / 10 : null,
      orders7: paid.filter((o) => new Date(o.createdAt).getTime() >= now - 7 * DAY).length,
      needsOk: orders.filter((o) => o.status === 'AWAITING_MERCHANT_APPROVAL').length,
      shipped: orders.some((o) => ['SHIPPED', 'DELIVERED'].includes(o.status)),
    };
  }, [orders]);

  if (error) return <SignInNeeded error={error} />;
  if (!me) return <p className="sf-muted">Loading Launchpad…</p>;

  const account = me.memberships?.[0]?.account;
  const sub = account?.subscription;
  const stores = account?.stores ?? [];
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });

  async function onboard() {
    try {
      const res = await api<any>('/payouts/onboard', { method: 'POST' });
      window.location.href = res.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start payouts');
    }
  }

  const tasks = [
    { n: '01', title: 'Pick a plan', body: 'Monthly, cancel any time. No per-week tiers.', done: sub?.status === 'ACTIVE', href: '/billing', cta: 'See plans' },
    { n: '02', title: 'Set up payouts', body: 'Stripe pays your sales straight to your bank.', done: Boolean(payouts?.ready), onClick: onboard, cta: 'Connect Stripe' },
    { n: '03', title: 'Open a store', body: 'Get a web address you can share today.', done: stores.length > 0, href: '/stores', cta: 'Open store' },
    { n: '04', title: 'Stock your Shelf', body: 'Pick products. Costs and shipping times are shown up front.', done: (shelfCount ?? 0) > 0, href: '/shelf', cta: 'Browse Shelf' },
    { n: '05', title: 'Ship a first order', body: 'Approve it in Dispatch and the supplier ships it.', done: stats.shipped, href: '/dispatch', cta: 'Open Dispatch' },
  ];
  const doneCount = tasks.filter((t) => t.done).length;

  return (
    <>
      <PageHead
        eyebrow={`Launchpad · ${today}`}
        icon="launchpad"
        title={<>Today at {account?.name ?? 'your shop'}</>}
        lede={`Hi ${me.name ?? me.email}. Here's what sold this week and what's left to set up.`}
        actions={<Link className="sf-btn sf-btn--brand" href="/shelf"><Icon name="add" size={18} />Add products</Link>}
      />
      {notice && <Callout tone="info">{notice}</Callout>}
      {alerts.map((a) => (
        <Callout
          key={a.id}
          tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info'}
          title={a.title}
          action={<button className="sf-btn sf-btn--sm sf-btn--quiet" onClick={() => { api(`/notifications/${a.id}/read`, { method: 'POST' }).catch(() => null); setAlerts((xs) => xs.filter((x) => x.id !== a.id)); }}>Got it</button>}
        >
          {a.body}{a.orderId ? <> <Link href="/dispatch">Open Dispatch</Link></> : null}
        </Callout>
      ))}

      <div className="grid-2">
        <section className="sf-card sf-card--ticket" aria-labelledby="rev">
          <div className="sf-spread">
            <div className="revenue">
              <span id="rev" className="sf-muted">Revenue, last 7 days</span>
              <span className="revenue__value">{money(stats.week)}</span>
            </div>
            {stats.delta === null ? <Badge>First week</Badge> : <Badge tone={stats.delta >= 0 ? 'money' : 'neutral'}>{stats.delta >= 0 ? '+' : ''}{stats.delta}%</Badge>}
          </div>
          <Bars values={stats.perDay} labels={stats.labels} />
          <hr className="sf-divider" />
          <p className="sf-muted" style={{ margin: 0 }}>
            Ad Fuel: <Money cents={fuel?.wallet?.balanceCents ?? 0} /> · Paid orders this week: <span className="sf-num">{stats.orders7}</span>
          </p>
        </section>
        <section className="minikpis" aria-label="At a glance">
          <div className="sf-kpi"><div className="sf-kpi__label"><Icon name="dispatch" size={16} />Needs your OK</div><div className="sf-kpi__value">{stats.needsOk}</div></div>
          <div className="sf-kpi"><div className="sf-kpi__label"><Icon name="stores" size={16} />Stores open</div><div className="sf-kpi__value">{stores.length}</div></div>
          <div className="sf-kpi"><div className="sf-kpi__label"><Icon name="shelf" size={16} />On your Shelf</div><div className="sf-kpi__value">{shelfCount ?? '–'}</div></div>
          <div className="sf-kpi">
            <div className="sf-kpi__label"><Icon name="billing" size={16} />Plan</div>
            <div className="sf-kpi__value" style={{ fontSize: '1.25rem' }}>{sub?.plan?.name ?? 'None yet'}</div>
            {sub && <StatusBadge status={sub.status} />}
          </div>
        </section>
      </div>

      <div className="section-title">
        <Icon name="tasks" size={22} className="sf-icon--brand" />
        <h2>Launch list</h2>
        <Badge tone={doneCount === tasks.length ? 'ok' : 'neutral'}>{doneCount} of {tasks.length} done</Badge>
      </div>
      <div className="tasks">
        {tasks.map((t) => (
          <article key={t.n} className={`task ${t.done ? 'task--done' : ''}`}>
            <span className="task__n">{t.n}</span>
            <h3>{t.title}</h3>
            <p>{t.body}</p>
            {t.done ? (
              <span className="task__state"><Icon name="done" size={18} />Done</span>
            ) : t.href ? (
              <Link className="sf-btn sf-btn--sm" href={t.href}>{t.cta}<Icon name="next" size={16} /></Link>
            ) : (
              <button className="sf-btn sf-btn--sm sf-btn--brand" onClick={t.onClick}>{t.cta}<Icon name="next" size={16} /></button>
            )}
          </article>
        ))}
      </div>

      <div className="section-title">
        <Icon name="dispatch" size={22} className="sf-icon--brand" />
        <h2>Latest in Dispatch</h2>
      </div>
      <div className="sf-card sf-card--flush">
        {orders.length === 0 ? (
          <p className="sf-muted" style={{ padding: 20, margin: 0 }}>No orders yet. They show up here the moment a customer pays.</p>
        ) : (
          <div className="sf-table-wrap">
            <table className="sf-table">
              <thead><tr><th>Order</th><th>Store</th><th>Customer</th><th className="sf-num">Total</th><th>Status</th></tr></thead>
              <tbody>
                {orders.slice(0, 5).map((o) => (
                  <tr key={o.id}>
                    <td className="sf-mono">#{o.id.slice(-6).toUpperCase()}</td>
                    <td>{o.store?.name ?? o.store?.slug}</td>
                    <td>{o.customerName}</td>
                    <td className="sf-num"><Money cents={o.totalCents} /></td>
                    <td><StatusBadge status={o.status} /></td>
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
