'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Callout, Money, money } from '@storeforge/ui/components';

const KIND: Record<string, string> = { TOPUP: 'Top-up', SPEND: 'Ad spend', FEE: 'Boost fee', REFUND: 'Refund to card', BONUS: 'Bonus fuel', ADJUST: 'Adjustment' };
const PRESETS = [2500, 5000, 10000, 25000];
const rid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const dollars = (cents: number) => String(Math.round(cents) / 100);
const toCents = (s: string) => Math.round(Number(s.replace(/[$,\s]/g, '')) * 100);

type Overview = {
  wallet: {
    balanceCents: number; bonusCents: number; availableCents: number; currency: string;
    autoReloadEnabled: boolean; thresholdCents: number; autoReloadCents: number;
    card: { label: string } | null;
    reload: { inFlight: boolean; startedAt: string | null; failures: number; lastError: string | null; maxPerDay: number };
    lowFuelAt: string | null;
  };
  shortfallCents: number; todayCents: number;
  topups: { id: string; amountCents: number; createdAt: string; source: string | null; refundedCents: number; refundableCents: number; refundDeadline: string }[];
  ledger: any[];
  limits: { minTopupCents: number; maxTopupCents: number; reloadMinCents: number; reloadMaxCents: number; refundWindowDays: number };
};

function TopUp({ o, onDone }: { o: Overview; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState(5000);
  const [custom, setCustom] = useState('');
  const [requestId, setRequestId] = useState(rid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cents = custom ? toCents(custom) : amount;
  const valid = Number.isInteger(cents) && cents >= o.limits.minTopupCents && cents <= o.limits.maxTopupCents;

  async function go() {
    setBusy(true); setError('');
    try {
      // Same requestId until it succeeds: a double click or a retry can't charge twice.
      const r = await api<any>('/fuel/checkout', { method: 'POST', body: JSON.stringify({ amountCents: cents, requestId }) });
      if (r.url) { window.location.href = r.url; return; }
      setRequestId(rid()); setCustom('');
      onDone(`Added ${money(cents)} of fuel.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Top-up failed'); } finally { setBusy(false); }
  }

  return (
    <section className="sf-card">
      <h2 style={{ marginTop: 0 }}>Add fuel</h2>
      <div className="fuel-presets" role="group" aria-label="Amount">
        {PRESETS.map((p) => (
          <button key={p} type="button" className={`sf-btn sf-btn--sm ${!custom && amount === p ? 'sf-btn--brand' : 'sf-btn--alt'}`} aria-pressed={!custom && amount === p} onClick={() => { setAmount(p); setCustom(''); }}>
            <span className="sf-num">{money(p)}</span>
          </button>
        ))}
      </div>
      <div className="sf-field">
        <label className="sf-label" htmlFor="custom">Or another amount</label>
        <input id="custom" className="sf-input sf-num" inputMode="decimal" placeholder={`$${dollars(o.limits.minTopupCents)} – $${dollars(o.limits.maxTopupCents)}`} value={custom} onChange={(e) => setCustom(e.target.value)} />
        {custom && !valid && <span className="sf-hint" style={{ color: 'rgb(var(--sf-bad))' }}>Between {money(o.limits.minTopupCents)} and {money(o.limits.maxTopupCents)}.</span>}
      </div>
      {error && <Callout tone="bad">{error}</Callout>}
      <button type="button" className="sf-btn sf-btn--money sf-btn--block" disabled={!valid || busy} onClick={go}>
        <Icon name="fuel" size={18} />{busy ? 'Opening checkout…' : `Add ${valid ? money(cents) : 'fuel'}`}
      </button>
      <p className="sf-hint" style={{ marginBottom: 0 }}>
        Paid by card through Stripe. We save the card so auto-reload can use it. Unused fuel can go back to that card for {o.limits.refundWindowDays} days.
      </p>
    </section>
  );
}

function AutoReload({ o, onSaved }: { o: Overview; onSaved: (next: Overview, msg: string) => void }) {
  const w = o.wallet;
  const [enabled, setEnabled] = useState(w.autoReloadEnabled);
  const [threshold, setThreshold] = useState(dollars(w.thresholdCents || 2000));
  const [reload, setReload] = useState(dollars(w.autoReloadCents || 5000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setEnabled(w.autoReloadEnabled); }, [w.autoReloadEnabled]);

  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const next = await api<Overview>('/fuel/settings', { method: 'POST', body: JSON.stringify({ autoReloadEnabled: enabled, thresholdCents: toCents(threshold) || 0, autoReloadCents: toCents(reload) || 0 }) });
      onSaved(next, enabled ? 'Auto-reload is on.' : 'Auto-reload is off.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save'); } finally { setBusy(false); }
  }

  return (
    <form className="sf-card" onSubmit={save}>
      <div className="sf-spread">
        <h2 style={{ margin: 0 }}>Auto-reload</h2>
        <Badge tone={w.autoReloadEnabled ? 'ok' : 'neutral'}>{w.autoReloadEnabled ? 'On' : 'Off'}</Badge>
      </div>
      <p className="sf-muted">Keeps ads running: when fuel drops below the line, we charge your saved card once.</p>
      {w.reload.inFlight && <Callout tone="info" title="Reload in progress">We&apos;re charging your card now. This usually takes a few seconds.</Callout>}
      {!w.autoReloadEnabled && w.reload.lastError && <Callout tone="warn" title="Auto-reload was switched off">{w.reload.lastError}</Callout>}
      {w.autoReloadEnabled && w.reload.failures > 0 && w.reload.lastError && <Callout tone="warn" title={`Last reload failed (${w.reload.failures} of 3)`}>{w.reload.lastError}</Callout>}
      <label className="sf-row" style={{ gap: 10, margin: '6px 0 14px' }}>
        <input type="checkbox" className="sf-check" checked={enabled} disabled={!w.card} onChange={(e) => setEnabled(e.target.checked)} />
        <span>Reload automatically</span>
      </label>
      <div className="fuel-two">
        <div className="sf-field">
          <label className="sf-label" htmlFor="th">When fuel drops below</label>
          <input id="th" className="sf-input sf-num" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} disabled={!enabled} />
        </div>
        <div className="sf-field">
          <label className="sf-label" htmlFor="amt">Add</label>
          <input id="amt" className="sf-input sf-num" inputMode="decimal" value={reload} onChange={(e) => setReload(e.target.value)} disabled={!enabled} />
          <span className="sf-hint">{money(o.limits.reloadMinCents)} – {money(o.limits.reloadMaxCents)}</span>
        </div>
      </div>
      <p className="sf-hint">
        <Icon name="secure" size={14} /> {w.card ? <>Charges <strong>{w.card.label}</strong>.</> : <>Top up once with a card first; auto-reload uses that card.</>} At most {w.reload.maxPerDay} reloads a day. Three declines in a row switch it off and we email you.
      </p>
      {error && <Callout tone="bad">{error}</Callout>}
      <button type="submit" className="sf-btn sf-btn--alt" disabled={busy || !w.card}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}

function RefundButton({ t, onDone }: { t: Overview['topups'][number]; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (t.refundableCents <= 0) return <span className="sf-hint">{t.refundedCents ? `Refunded ${money(t.refundedCents)}` : new Date(t.refundDeadline) < new Date() ? 'Refund window closed' : '—'}</span>;
  async function go() {
    if (!window.confirm(`Refund ${money(t.refundableCents)} to your card? That fuel leaves your balance now; your bank shows it in 5–10 days.`)) return;
    setBusy(true); setError('');
    try {
      const r = await api<any>('/fuel/refunds', { method: 'POST', body: JSON.stringify({ topupTxnId: t.id, amountCents: t.refundableCents }) });
      onDone(r?.status === 'pending' || r?.status === 'unknown' ? 'Refund sent to Stripe; we’ll confirm it shortly.' : `Refunded ${money(t.refundableCents)} to your card.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Refund failed'); } finally { setBusy(false); }
  }
  return (
    <span className="sf-row" style={{ gap: 8, justifyContent: 'flex-end' }}>
      {error && <span className="sf-hint" style={{ color: 'rgb(var(--sf-bad))' }}>{error}</span>}
      <button type="button" className="sf-btn sf-btn--sm sf-btn--quiet" disabled={busy} onClick={go}><Icon name="refund" size={16} />{busy ? 'Refunding…' : `Refund ${money(t.refundableCents)}`}</button>
    </span>
  );
}

function FuelInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [o, setO] = useState<Overview | null>(null);
  const [authError, setAuthError] = useState('');
  const [flash, setFlash] = useState('');
  const refresh = useCallback(() => api<Overview>('/fuel/wallet').then(setO).catch((e) => setAuthError(e.message)), []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const t = params.get('topup');
    if (!t) return;
    setFlash(t === 'success' ? 'Payment received. Your fuel appears as soon as Stripe confirms it (usually a few seconds).' : 'Top-up cancelled. Nothing was charged.');
    router.replace('/fuel');
    const i = setTimeout(refresh, 3000);
    return () => clearTimeout(i);
  }, [params, router, refresh]);
  useEffect(() => {
    if (!o?.wallet.reload.inFlight) return;
    const i = setInterval(refresh, 4000);
    return () => clearInterval(i);
  }, [o?.wallet.reload.inFlight, refresh]);

  if (authError) return <SignInNeeded error={authError} />;
  const done = (msg: string) => { setFlash(msg); refresh(); };
  const w = o?.wallet;

  return (
    <>
      <PageHead eyebrow="Ad Fuel · wallet" icon="fuel" title="Ad Fuel" lede="Prepaid credit for Boost ads. Every charge shows here, with your balance after it." />
      {flash && <Callout tone="ok">{flash}</Callout>}
      {o && o.shortfallCents > 0 && (
        <Callout tone="bad" title="Out of fuel: ads are paused">
          Your ads ran {money(o.shortfallCents)} past your balance before they paused. Add fuel to settle it and they restart on their own.
        </Callout>
      )}
      {o && o.shortfallCents === 0 && w?.lowFuelAt && <Callout tone="warn" title="Running low">Add fuel or turn on auto-reload so your ads don&apos;t pause.</Callout>}

      <div className="sf-kpis" style={{ marginBottom: 18 }}>
        <div className="sf-kpi"><div className="sf-kpi__label">Fuel available</div><div className="sf-kpi__value"><Money cents={w?.availableCents ?? 0} /></div></div>
        <div className="sf-kpi"><div className="sf-kpi__label">Refundable fuel</div><div className="sf-kpi__value"><Money cents={w?.balanceCents ?? 0} /></div></div>
        <div className="sf-kpi"><div className="sf-kpi__label">Bonus fuel</div><div className="sf-kpi__value"><Money cents={w?.bonusCents ?? 0} /></div><span className="sf-hint">Spent first. Not refundable.</span></div>
        <div className="sf-kpi"><div className="sf-kpi__label">Charged today</div><div className="sf-kpi__value"><Money cents={o?.todayCents ?? 0} /></div></div>
      </div>

      {!o ? <p className="sf-muted">Loading…</p> : (
        <div className="grid-2 fuel-grid">
          <div className="sf-stack">
            <section className="sf-card sf-card--flush">
              <div className="sf-spread" style={{ padding: '16px 18px 0' }}><h2 style={{ margin: 0 }}>Ledger</h2><span className="sf-hint">Newest first</span></div>
              {o.ledger.length === 0 ? <p className="sf-muted" style={{ padding: 18, margin: 0 }}>No fuel activity yet. Add fuel to get started.</p> : (
                <div className="sf-table-wrap">
                  <table className="sf-table fuel-ledger">
                    <thead><tr><th>Date</th><th>What</th><th>Status</th><th className="sf-num">Amount</th><th className="sf-num">Balance</th></tr></thead>
                    <tbody>
                      {o.ledger.map((t) => (
                        <tr key={t.id}>
                          <td className="sf-mono sf-muted" data-label="Date">{day(t.createdAt)}</td>
                          <td data-label="What">
                            {KIND[t.kind] ?? t.kind}{t.source === 'auto' ? ' · auto-reload' : ''}
                            {t.campaignName && <div className="sf-hint">{t.campaignName}{t.day ? ` · ${day(t.day)}` : ''}</div>}
                            {t.bonusCents < 0 && <div className="sf-hint">{money(-t.bonusCents)} from bonus fuel</div>}
                            {t.note && <div className="sf-hint">{t.note}</div>}
                          </td>
                          <td data-label="Status"><Badge tone={t.status === 'failed' ? 'bad' : t.status === 'pending' || t.status === 'unknown' ? 'warn' : 'ok'}>{t.status === 'unknown' ? 'checking with Stripe' : t.status}</Badge></td>
                          <td className="sf-num" data-label="Amount" style={{ color: t.amountCents < 0 ? undefined : 'rgb(var(--sf-money))' }}>{t.amountCents > 0 ? '+' : ''}<Money cents={t.amountCents} /></td>
                          <td className="sf-num sf-muted" data-label="Balance">{t.balanceAfterCents == null ? '—' : <Money cents={t.balanceAfterCents + (t.bonusAfterCents ?? 0)} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {o.topups.length > 0 && (
              <section className="sf-card sf-card--flush">
                <div className="sf-spread" style={{ padding: '16px 18px 0' }}><h2 style={{ margin: 0 }}>Top-ups</h2><span className="sf-hint">Refund unused fuel within {o.limits.refundWindowDays} days</span></div>
                <div className="sf-table-wrap">
                  <table className="sf-table">
                    <thead><tr><th>Date</th><th className="sf-num">Paid</th><th>Refund by</th><th className="sf-num"></th></tr></thead>
                    <tbody>
                      {o.topups.map((t) => (
                        <tr key={t.id}>
                          <td className="sf-mono sf-muted">{day(t.createdAt)}{t.source === 'auto' ? <span className="sf-hint"> · auto</span> : null}</td>
                          <td className="sf-num"><Money cents={t.amountCents} /></td>
                          <td className="sf-mono sf-muted">{day(t.refundDeadline)}</td>
                          <td className="sf-num"><RefundButton t={t} onDone={done} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
          <div className="sf-stack">
            <TopUp o={o} onDone={done} />
            <AutoReload o={o} onSaved={(next, msg) => { setO(next); setFlash(msg); }} />
          </div>
        </div>
      )}
    </>
  );
}

export default function FuelPage() {
  return <Suspense fallback={null}><FuelInner /></Suspense>;
}
