'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Badge, Callout, Money } from '@storeforge/ui/components';

const KIND: Record<string, string> = { TOPUP: 'Top-up', SPEND: 'Ad spend', FEE: 'Boost fee', REFUND: 'Refund to card', BONUS: 'Bonus fuel', ADJUST: 'Adjustment' };

export default function FuelPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/fuel').then(setData).catch((e) => setError(e.message)); }, []);
  if (error) return <SignInNeeded error={error} />;
  const w = data?.wallet;

  return (
    <>
      <PageHead eyebrow="Ad Fuel · wallet" icon="fuel" title="Ad Fuel" lede="Prepaid credit for Boost ads. Unused fuel can go back to your card for 90 days; bonus fuel can't." />
      <Callout tone="warn" title="View only for now">
        Top-ups and refunds work through the API only (<span className="sf-mono">POST /api/fuel/topups</span>, <span className="sf-mono">POST /api/fuel/refunds</span>). Buttons for them arrive with Boost in a later release.
      </Callout>
      <div className="sf-kpis" style={{ marginBottom: 18 }}>
        <div className="sf-kpi"><div className="sf-kpi__label">Fuel balance</div><div className="sf-kpi__value"><Money cents={w?.balanceCents ?? 0} /></div></div>
        <div className="sf-kpi"><div className="sf-kpi__label">Bonus fuel</div><div className="sf-kpi__value"><Money cents={w?.bonusCents ?? 0} /></div></div>
        <div className="sf-kpi"><div className="sf-kpi__label">Top-ups</div><div className="sf-kpi__value" style={{ fontSize: '1.1rem' }}>Open with Boost</div><Badge tone="warn">Coming soon</Badge></div>
      </div>
      <div className="sf-card sf-card--flush">
        {!data ? <p className="sf-muted" style={{ padding: 20, margin: 0 }}>Loading…</p> : data.txns.length === 0 ? (
          <p className="sf-muted" style={{ padding: 20, margin: 0 }}>No fuel activity yet.</p>
        ) : (
          <div className="sf-table-wrap">
            <table className="sf-table">
              <thead><tr><th>Date</th><th>What</th><th>Status</th><th className="sf-num">Amount</th></tr></thead>
              <tbody>
                {data.txns.map((t: any) => (
                  <tr key={t.id}>
                    <td className="sf-mono sf-muted">{new Date(t.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                    <td>{KIND[t.kind] ?? t.kind}</td>
                    <td><Badge tone={t.status === 'failed' ? 'bad' : t.status === 'pending' || t.status === 'unknown' ? 'warn' : 'ok'}>{t.status === 'unknown' ? 'checking with Stripe' : t.status}</Badge></td>
                    <td className="sf-num"><Money cents={t.amountCents} /></td>
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
