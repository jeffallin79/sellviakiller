'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Callout, StatusBadge } from '@storeforge/ui/components';

const MODE: Record<string, string> = { stub: 'Demo mode — no card is charged', test: 'Stripe test mode', live: 'Stripe' };

export default function BillingPage() {
  const [plans, setPlans] = useState<any>(null);
  const [sub, setSub] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    api('/billing/plans').then(setPlans).catch((e) => setError(e.message));
    api('/billing/subscription').then(setSub).catch((e) => setAuthError(e.message));
    const q = new URLSearchParams(window.location.search).get('checkout');
    if (q === 'success') setMsg('Payment received. Your plan turns on as soon as Stripe confirms it (usually a few seconds).');
    if (q === 'cancelled') setMsg('Checkout cancelled — nothing was charged.');
  }, []);

  async function subscribe(planId: string) {
    setMsg(''); setError('');
    try {
      const res = await api<any>('/billing/subscribe', { method: 'POST', body: JSON.stringify({ planId }) });
      if (res.checkoutUrl && res.mode !== 'stub') { window.location.href = res.checkoutUrl; return; }
      setSub(res.subscription);
      setMsg(res.message ?? 'Plan updated.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change plan'); }
  }

  async function portal() {
    setError('');
    try { const res = await api<any>('/billing/portal', { method: 'POST' }); window.location.href = res.url; }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open billing'); }
  }

  if (authError) return <SignInNeeded error={authError} />;
  // From PLATFORM_FEE_BPS via GET /billing/plans — never hard-coded.
  const feeBps: number = plans?.platformFeeBps ?? 0;
  const feePct = (feeBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

  return (
    <>
      <PageHead
        eyebrow="Billing"
        icon="billing"
        title="Your plan"
        lede={`One monthly price. No weekly tiers${feeBps ? `, plus a ${feePct}% StoreForge fee on each order` : ', no commission on your orders'}. Cancel any time from the billing portal.`}
        actions={<>
          {plans && <Badge tone={plans.mode === 'live' ? 'ok' : 'warn'}>{MODE[plans.mode] ?? plans.mode}</Badge>}
          <button className="sf-btn sf-btn--quiet" onClick={portal}><Icon name="billing" size={18} />Manage billing</button>
        </>}
      />
      {sub && <p>Current plan: <strong>{sub.plan?.name}</strong> <StatusBadge status={sub.status} />{sub.currentPeriodEnd && <span className="sf-muted"> · renews <span className="sf-num">{new Date(sub.currentPeriodEnd).toLocaleDateString()}</span></span>}</p>}
      {msg && <Callout tone="ok">{msg}</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}
      <div className="grid-3">
        {(plans?.plans ?? []).map((p: any) => {
          const current = sub?.planId === p.id && sub?.status === 'ACTIVE';
          return (
            <article key={p.id} className={`sf-card plan ${current ? 'plan--current sf-card--ticket' : ''}`}>
              <div className="sf-spread"><h2 style={{ margin: 0 }}>{p.name}</h2>{current && <Badge tone="brand">Your plan</Badge>}</div>
              <div className="plan__price">${p.priceUsd}<small> / month</small></div>
              <ul>
                <li><Icon name="done" size={18} />{p.maxStores} store{p.maxStores === 1 ? '' : 's'}</li>
                <li><Icon name="done" size={18} />Up to <span className="sf-num">{p.maxOrdersPerMonth.toLocaleString()}</span> orders a month</li>
                <li><Icon name={feeBps ? 'info' : 'done'} size={18} />{feeBps ? <><span className="sf-num">{feePct}%</span>&nbsp;StoreForge fee on each order</> : 'No StoreForge fee on orders'}</li>
                <li><Icon name="info" size={18} />Stripe card fees apply to each sale</li>
              </ul>
              <button className={`sf-btn ${current ? 'sf-btn--quiet' : 'sf-btn--brand'}`} onClick={() => subscribe(p.id)} disabled={current}>
                {current ? 'Current plan' : `Choose ${p.name}`}
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
