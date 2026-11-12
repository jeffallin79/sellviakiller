'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Bars, Callout, Money, money } from '@storeforge/ui/components';

/**
 * Managed Boost (slice 4): StoreForge runs the ads in its own Meta / Google / TikTok accounts.
 * Fuel pays the spend plus the managed fee (ADS_FEE_PCT, 15%).
 */
type Ch = 'META' | 'GOOGLE' | 'TIKTOK';
type ChannelRow = { channel: Ch; label: string; mode: 'stub' | 'live'; minDailyCents: number; account: null | { id: string; status: string; externalId: string | null; lastError: string | null; capMinor: number | null; lifetimeSpendCents: number | null; feedStatus: any } };
type Overview = { feePct: number; fuel: { availableCents: number; shortfallCents: number }; channels: ChannelRow[]; groups: Group[] };
type Group = any;
const SHORT: Record<Ch, string> = { META: 'Meta', GOOGLE: 'Google', TIKTOK: 'TikTok' };
const rid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
const toCents = (s: string) => Math.round(Number(s.replace(/[$,\s]/g, '')) * 100);
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const STAGE: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand' }> = {
  DRAFT: { label: 'Setting up', tone: 'neutral' }, REVIEW: { label: 'In review', tone: 'info' }, WARMING: { label: 'Warming up', tone: 'brand' },
  STEADY: { label: 'Steady', tone: 'ok' }, PAUSED: { label: 'Paused', tone: 'warn' }, REJECTED: { label: 'Rejected', tone: 'bad' },
};
const GROUP: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' }, LAUNCHING: { label: 'Launching', tone: 'info' }, LIVE: { label: 'Live', tone: 'ok' }, PAUSED: { label: 'Paused', tone: 'warn' }, FAILED: { label: 'Didn’t launch', tone: 'bad' },
};
const PLACE: Record<string, string> = { '1:1': 'Feeds, Shopping', '4:5': 'Instagram & Facebook feed', '9:16': 'Reels, Stories, TikTok', '1.91:1': 'Google Display, links' };
const PAUSED_WHY: Record<string, string> = { merchant: 'by you', low_fuel: 'out of fuel', rejected: 'ad rejected', error: 'error' };
const ACCT: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' }> = {
  ready: { label: 'Ready', tone: 'ok' }, provisioning: { label: 'Setting up', tone: 'info' }, pending_review: { label: 'Waiting on platform', tone: 'warn' }, failed: { label: 'Needs attention', tone: 'bad' },
};
// Same 40/40/20 split as the API (packages: apps/api/src/ads/managed/config.ts); preview only, the API decides.
const MIN: Record<Ch, number> = { META: 100, GOOGLE: 100, TIKTOK: 2000 };
const W: Record<Ch, number> = { META: 0.4, GOOGLE: 0.4, TIKTOK: 0.2 };
function split(total: number, chs: Ch[]) {
  const out: Partial<Record<Ch, number>> = {};
  if (!chs.length) return out;
  let rest = total;
  const floor = chs.filter((c) => total * (W[c] / chs.reduce((n, x) => n + W[x], 0)) < MIN[c]);
  for (const c of floor) { out[c] = MIN[c]; rest -= MIN[c]; }
  const free = chs.filter((c) => !floor.includes(c));
  const wsum = free.reduce((n, c) => n + W[c], 0);
  let given = 0;
  free.forEach((c, i) => { const v = i === free.length - 1 ? rest - given : Math.floor((rest * W[c]) / wsum); out[c] = v; given += v; });
  return out;
}

function Channels({ o, storeId, onDone, onError }: { o: Overview; storeId: string; onDone: (m: string) => void; onError: (m: string) => void }) {
  const off = o.channels.filter((c) => !c.account);
  const [pick, setPick] = useState<Ch[]>(off.map((c) => c.channel));
  const [busy, setBusy] = useState(false);
  async function enable() {
    setBusy(true);
    try { await api('/boost/managed/enable', { method: 'POST', body: JSON.stringify({ storeId, channels: pick }) }); onDone('Ad accounts are set up. Pick a product to boost.'); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not set up'); } finally { setBusy(false); }
  }
  return (
    <section className="sf-card">
      <div className="sf-spread"><h3 style={{ margin: 0 }}>Channels</h3><span className="sf-hint">StoreForge&apos;s ad accounts, one per store</span></div>
      <ul className="mboost-ch">
        {o.channels.map((c) => {
          const a = c.account;
          const st = a ? ACCT[a.status] ?? { label: a.status, tone: 'neutral' as const } : null;
          return (
            <li key={c.channel}>
              {!a ? <input type="checkbox" className="sf-check" aria-label={`Use ${c.label}`} checked={pick.includes(c.channel)} onChange={(e) => setPick((p) => (e.target.checked ? [...p, c.channel] : p.filter((x) => x !== c.channel)))} /> : <Icon name={a.status === 'ready' ? 'done' : 'todo'} size={20} />}
              <div>
                <strong>{c.label}</strong>
                <div className="sf-hint">
                  {a?.externalId ? <span className="sf-mono">{a.externalId}</span> : `From ${money(c.minDailyCents)}/day`}
                  {a && a.capMinor != null && <> · ceiling <span className="sf-num">{money(a.capMinor)}</span></>}
                  {c.mode === 'stub' && <> · simulated</>}
                </div>
                {a?.lastError && a.status !== 'ready' && <div className="sf-hint mboost-err">{a.lastError}</div>}
              </div>
              {st && <Badge tone={st.tone}>{st.label}</Badge>}
            </li>
          );
        })}
      </ul>
      {off.length > 0 && <button type="button" className="sf-btn sf-btn--brand sf-btn--sm" disabled={busy || !pick.length} onClick={enable}><Icon name="add" size={16} />{busy ? 'Setting up accounts…' : `Turn on ${pick.map((c) => SHORT[c]).join(' + ') || 'channels'}`}</button>}
    </section>
  );
}

function Draft({ g, o, onChange, onError }: { g: Group; o: Overview; onChange: (g?: Group) => void; onError: (m: string) => void }) {
  const ready = o.channels.filter((c) => c.account?.status === 'ready').map((c) => c.channel);
  const [budget, setBudget] = useState(String(g.dailyBudgetCents / 100));
  const [edit, setEdit] = useState<{ headline: string; body: string } | null>(null);
  const [busy, setBusy] = useState('');
  const v = g.variants[g.variantIndex];
  const cents = toCents(budget);
  const chs: Ch[] = g.channels;
  const preview = split(cents, chs);
  const fee = Math.round((cents * g.feePct) / 100);
  const need = Math.ceil(cents * (1 + g.feePct / 100));
  const short = o.fuel.availableCents < need;
  async function patch(body: object, k = 'patch') {
    setBusy(k);
    try { onChange(await api<Group>(`/boost/managed/groups/${g.id}`, { method: 'POST', body: JSON.stringify(body) })); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(''); }
  }
  async function launch() {
    setBusy('launch');
    try {
      if (cents !== g.dailyBudgetCents) await api(`/boost/managed/groups/${g.id}`, { method: 'POST', body: JSON.stringify({ dailyBudgetCents: cents }) });
      onChange(await api<Group>(`/boost/managed/groups/${g.id}/launch`, { method: 'POST', body: '{}' }));
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not launch'); onChange(); } finally { setBusy(''); }
  }
  // the same claim can appear in several fields (headline + its short form): show it once
  const uniq = (l: string) => v.policy.findings.filter((f: any, i: number, all: any[]) => f.level === l && all.findIndex((x) => x.rule === f.rule && (x.match ?? '').toLowerCase() === (f.match ?? '').toLowerCase()) === i);
  const blocks = uniq('block');
  const warns = uniq('warn');
  return (
    <section className="sf-card sf-card--ticket mboost-draft">
      <div className="sf-spread">
        <div><p className="sf-eyebrow" style={{ margin: 0 }}><Icon name="spark" size={16} />New Boost</p><h2 style={{ margin: '4px 0 0' }}>{g.product?.title}</h2></div>
        <span className="sf-hint">Picked {new Date(g.pickedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
      </div>
      {g.status === 'FAILED' && g.lastError && <Callout tone="bad" title="It didn’t launch">{g.lastError}</Callout>}

      <div>
        <h3 className="mboost-h">1 · Pick the words</h3>
        <div className="mboost-variants" role="radiogroup" aria-label="Ad copy">
          {g.variants.map((x: any, i: number) => (
            <button key={i} type="button" role="radio" aria-checked={i === g.variantIndex} className={`mboost-variant${i === g.variantIndex ? ' is-on' : ''}`} disabled={!!busy} onClick={() => patch({ variantIndex: i }, `v${i}`)}>
              <span className="mboost-variant__angle">{x.angle}</span>
              <strong>{x.headline}</strong>
              <span>{x.body}</span>
              <Badge tone={x.policy.result === 'block' ? 'bad' : x.policy.result === 'warn' ? 'warn' : 'ok'}>{x.policy.result === 'block' ? 'Blocked' : x.policy.result === 'warn' ? `${x.policy.findings.length} note${x.policy.findings.length === 1 ? '' : 's'}` : 'Policy OK'}</Badge>
            </button>
          ))}
        </div>
        {edit ? (
          <div className="fuel-two" style={{ marginTop: 12 }}>
            <div className="sf-field"><label className="sf-label" htmlFor="mh">Headline</label><input id="mh" className="sf-input" maxLength={40} value={edit.headline} onChange={(e) => setEdit({ ...edit, headline: e.target.value })} /></div>
            <div className="sf-field"><label className="sf-label" htmlFor="mb">Text</label><input id="mb" className="sf-input" maxLength={125} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></div>
            <div className="sf-row" style={{ gap: 8 }}>
              <button type="button" className="sf-btn sf-btn--sm sf-btn--alt" disabled={busy === 'patch'} onClick={async () => { await patch({ headline: edit.headline, body: edit.body }); setEdit(null); }}>Check &amp; save</button>
              <button type="button" className="sf-btn sf-btn--sm sf-btn--quiet" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        ) : <button type="button" className="sf-btn sf-btn--sm sf-btn--quiet" style={{ marginTop: 8 }} onClick={() => setEdit({ headline: v.headline, body: v.body })}>Edit the words</button>}
        {blocks.length > 0 && <Callout tone="bad" title="Fix this before launching">{blocks.map((f: any) => <div key={f.rule + f.field}>{f.message}{f.match ? <> (“{f.match}”)</> : null}</div>)}</Callout>}
        {warns.length > 0 && <Callout tone="warn" title="Worth a look">{warns.map((f: any) => <div key={f.rule + f.field}>{f.message}</div>)}</Callout>}
      </div>

      <div>
        <h3 className="mboost-h">2 · Images, cropped for each placement</h3>
        <div className="mboost-crops">
          {g.assets.map((a: any) => (
            <figure key={a.ratio}>
              <div className="mboost-crop" style={{ aspectRatio: a.ratio.replace(':', ' / ') }}>
                <img src={a.url} alt={`${g.product?.title} ${a.ratio}`} loading="lazy" />
              </div>
              <figcaption className="sf-hint">{a.ratio} · {PLACE[a.ratio] ?? ''}</figcaption>
            </figure>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mboost-h">3 · Where and how much</h3>
        <div className="sf-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {(['META', 'GOOGLE', 'TIKTOK'] as Ch[]).filter((c) => o.channels.some((x) => x.channel === c)).map((c) => {
            const on = chs.includes(c);
            const ok = ready.includes(c);
            return <button key={c} type="button" className={`sf-toggle mboost-chip${on ? ' is-on' : ''}`} aria-pressed={on} disabled={!ok || !!busy} onClick={() => patch({ channels: on ? chs.filter((x) => x !== c) : [...chs, c] }, `c${c}`)}>{on ? <Icon name="done" size={14} /> : <Icon name="add" size={14} />}{SHORT[c]}{!ok ? ' (not set up)' : ''}</button>;
          })}
        </div>
        <div className="fuel-two" style={{ marginTop: 12 }}>
          <div className="sf-field">
            <label className="sf-label" htmlFor="mbud">Daily budget (all channels)</label>
            <input id="mbud" className="sf-input sf-num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <span className="sf-hint">From {money(g.minDailyCents)}/day for {chs.map((c) => SHORT[c]).join(' + ') || 'these channels'}.</span>
          </div>
          <div className="mboost-split" aria-label="Budget split">
            {chs.map((c) => <div key={c}><span className="sf-kpi__label">{SHORT[c]}</span><strong className="sf-num">{money(preview[c] ?? 0)}</strong></div>)}
          </div>
        </div>
        {(() => { const up = g.ladder.filter((l: any) => l.dailyCents > cents); return (
          <p className="sf-hint" style={{ margin: '4px 0 0' }}><Icon name="spark" size={14} /> {up.length
            ? <>Auto step-up is on: the budget rises as the ad proves itself ({up.map((l: any) => `${money(l.dailyCents)}/day after ${money(l.atSpendCents)} spent`).join(' → ')}). Lowering it yourself turns this off.</>
            : <>This budget is already above the automatic step-ups.</>}</p>); })()}
      </div>

      <div className="mboost-cost">
        <div><span className="sf-kpi__label">Ad spend</span><strong className="sf-num">{money(cents)}/day</strong></div>
        <div><span className="sf-kpi__label">StoreForge fee ({g.feePct}%)</span><strong className="sf-num">{money(fee)}/day</strong></div>
        <div><span className="sf-kpi__label">From Ad Fuel</span><strong className="sf-num">{money(cents + fee)}/day</strong></div>
      </div>
      {short && <Callout tone="warn" action={<Link href="/fuel" className="sf-btn sf-btn--sm sf-btn--money"><Icon name="fuel" size={16} />Add fuel</Link>}>Launching needs one day of budget + fee in fuel ({money(need)}). You have {money(o.fuel.availableCents)}.</Callout>}
      <button type="button" className="sf-btn sf-btn--brand" disabled={!!busy || short || blocks.length > 0 || !chs.length || !(cents >= g.minDailyCents)} onClick={launch}>
        <Icon name="boost" size={18} />{busy === 'launch' ? 'Launching…' : `Launch on ${chs.map((c) => SHORT[c]).join(', ')}`}
      </button>
    </section>
  );
}

function LaunchTimer({ g }: { g: Group }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (g.status !== 'LAUNCHING') return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [g.status]);
  const ms = g.launchMs ?? now - new Date(g.pickedAt).getTime();
  const pct = Math.min(100, (ms / g.launchTargetMs) * 100);
  return (
    <div className="mboost-timer" aria-label="Pick to launch time">
      <span className="sf-kpi__label"><Icon name="eta" size={14} />Pick → live</span>
      <strong className="sf-num">{mmss(ms)}</strong>
      <div className="mboost-timer__bar"><span style={{ width: `${pct}%` }} className={ms > g.launchTargetMs ? 'is-late' : ''} /></div>
      <span className="sf-hint">target under {mmss(g.launchTargetMs)}{g.launchSystemMs != null ? ` · launch click → live ${(g.launchSystemMs / 1000).toFixed(1)} s` : ''}</span>
    </div>
  );
}

function GroupCard({ g, onChange, onError }: { g: Group; onChange: (g?: Group) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState('');
  const [budget, setBudget] = useState(String(g.dailyBudgetCents / 100));
  const s = GROUP[g.status] ?? { label: g.status, tone: 'neutral' as const };
  const t = g.totals;
  const days = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of g.campaigns) for (const d of c.days) m.set(d.date, (m.get(d.date) ?? 0) + d.spendCents);
    return [...m.entries()].sort().slice(-14);
  }, [g]);
  const recon = g.campaigns.flatMap((c: any) => c.reconcile.map((r: any) => ({ ...r, channel: c.channel }))).filter((r: any) => r.status !== 'ok').slice(0, 5);
  const lowFuel = g.campaigns.some((c: any) => c.pausedReason === 'low_fuel');
  async function act(path: string, body: object = {}, k = path) {
    setBusy(k);
    try { onChange(await api<Group>(`/boost/managed/groups/${g.id}/${path}`, { method: 'POST', body: JSON.stringify(body) })); }
    catch (e) { onError(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(''); }
  }
  return (
    <article className="sf-card boost-campaign">
      <div className="sf-spread">
        <div>
          <h3 style={{ margin: 0 }}>{g.product?.title ?? 'Product'}</h3>
          <span className="sf-hint"><span className="sf-num">{money(g.dailyBudgetCents)}</span>/day · {g.channels.map((c: Ch) => SHORT[c]).join(' + ')} · {g.feePct}% fee</span>
        </div>
        <Badge tone={s.tone}>{s.label}</Badge>
      </div>
      {(g.status === 'LAUNCHING' || g.launchMs != null) && <LaunchTimer g={g} />}
      {lowFuel && <Callout tone="warn" action={<Link href="/fuel" className="sf-btn sf-btn--sm sf-btn--money"><Icon name="fuel" size={16} />Add fuel</Link>}>Out of Ad Fuel: every channel is paused. Ads restart by themselves once you top up.</Callout>}
      <div className="sf-table-wrap">
        <table className="sf-table mboost-table">
          <thead><tr><th>Channel</th><th>Status</th><th className="sf-num">Budget</th><th className="sf-num">Spend</th><th className="sf-num">Fee</th><th className="sf-num">Buys</th><th className="sf-num">ROAS</th><th className="sf-num">CPA</th></tr></thead>
          <tbody>
            {g.campaigns.map((c: any) => {
              const st = STAGE[c.stage] ?? { label: c.stage, tone: 'neutral' as const };
              return (
                <tr key={c.id}>
                  <td><strong>{SHORT[c.channel as Ch]}</strong>{c.externalId && <div className="sf-hint sf-mono">{c.externalId}</div>}</td>
                  <td><Badge tone={st.tone}>{st.label}{c.stage === 'PAUSED' && c.pausedReason ? ` · ${PAUSED_WHY[c.pausedReason] ?? c.pausedReason}` : ''}</Badge>{c.lastError && (c.stage === 'REJECTED' || c.stage === 'DRAFT') && <div className="sf-hint mboost-err">{c.lastError}</div>}</td>
                  <td className="sf-num">{money(c.dailyBudgetCents)}</td>
                  <td className="sf-num"><Money cents={c.totals.spendCents} /></td>
                  <td className="sf-num"><Money cents={c.totals.feeCents} /></td>
                  <td className="sf-num">{c.totals.purchases}</td>
                  <td className="sf-num">{c.totals.roas == null ? '—' : `${c.totals.roas}×`}</td>
                  <td className="sf-num">{c.totals.cpaCents == null ? '—' : money(c.totals.cpaCents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="boost-stats">
        <div><span className="sf-kpi__label">Ad spend</span><strong className="sf-num"><Money cents={t.spendCents} /></strong></div>
        <div><span className="sf-kpi__label">Fee ({g.feePct}%)</span><strong className="sf-num"><Money cents={t.feeCents} /></strong></div>
        <div><span className="sf-kpi__label">Sales</span><strong className="sf-num"><Money cents={t.revenueCents} /></strong></div>
        <div><span className="sf-kpi__label">ROAS</span><strong className="sf-num">{t.roas == null ? '—' : `${t.roas}×`}</strong></div>
        <div><span className="sf-kpi__label">Cost per sale</span><strong className="sf-num">{t.cpaCents == null ? '—' : money(t.cpaCents)}</strong></div>
        <div className="mboost-profit"><span className="sf-kpi__label">True profit</span><strong className={`sf-num${t.trueProfitCents < 0 ? ' is-neg' : ''}`}><Money cents={t.trueProfitCents} /></strong></div>
      </div>
      {t.purchases > 0 && <p className="sf-hint" style={{ margin: 0 }}>True profit = sales {money(t.revenueCents)} − product cost {money(t.cogsCents)} − shipping {money(t.shippingCents)} − ad spend {money(t.spendCents)} − fee {money(t.feeCents)}.</p>}
      {days.length > 1 && <Bars values={days.map(([, v]) => v)} labels={days.map(([d]) => d.slice(5))} hotIndex={days.length - 1} />}
      {recon.length > 0 && (
        <details className="mboost-recon">
          <summary>Spend corrections ({recon.length})</summary>
          <ul>{recon.map((r: any) => <li key={r.channel + r.date} className="sf-hint">{SHORT[r.channel as Ch]} {r.date}: platform {money(r.platformSpendCents)}, we had {money(r.chargedSpendCents)} ({(r.driftBps / 100).toFixed(1)}%). Fuel adjusted to match.</li>)}</ul>
        </details>
      )}
      {(g.status === 'LIVE' || g.status === 'PAUSED') && (
        <div className="sf-row mboost-actions">
          <div className="sf-row" style={{ gap: 6 }}>
            <label className="sf-sr-only" htmlFor={`b${g.id}`}>Daily budget</label>
            <input id={`b${g.id}`} className="sf-input sf-num mboost-bud" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <button type="button" className="sf-btn sf-btn--sm sf-btn--alt" disabled={!!busy || toCents(budget) === g.dailyBudgetCents} onClick={() => act('budget', { dailyBudgetCents: toCents(budget) }, 'budget')}>Set budget</button>
          </div>
          <label className="sf-row" style={{ gap: 6 }}>
            <input type="checkbox" className="sf-check" checked={g.autoLadder} disabled={!!busy} onChange={(e) => act('budget', { dailyBudgetCents: g.dailyBudgetCents, autoLadder: e.target.checked }, 'ladder')} />
            <span className="sf-hint">Auto step-up{g.ladderStep > 0 ? ` (step ${g.ladderStep})` : ''}</span>
          </label>
          {g.status === 'LIVE' && <button type="button" className="sf-btn sf-btn--sm sf-btn--alt" disabled={!!busy} onClick={() => act('pause')}>Pause all</button>}
          {g.status === 'PAUSED' && <button type="button" className="sf-btn sf-btn--sm sf-btn--brand" disabled={!!busy} onClick={() => act('resume')}>Resume</button>}
        </div>
      )}
    </article>
  );
}

function Events({ storeId, tick }: { storeId: string; tick: number }) {
  const [d, setD] = useState<any[] | null>(null);
  useEffect(() => { api<any[]>(`/boost/managed/events?storeId=${storeId}`).then(setD).catch(() => setD(null)); }, [storeId, tick]);
  const rows = (d ?? []).flatMap((c) => c.events.map((e: any) => ({ ...e, channel: c.channel }))).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 12);
  if (!d || !d.length) return null;
  return (
    <section className="sf-card sf-card--flush">
      <div style={{ padding: '16px 18px 0' }}><h2 style={{ margin: 0 }}>Purchase tracking</h2>
        <p className="sf-hint">Every sale goes to each channel twice, from the shopper&apos;s browser and from our server, with the same ID, so each platform counts it once. Google gets a hashed email only.</p></div>
      {rows.length === 0 ? <p className="sf-muted" style={{ padding: '0 18px 18px', margin: 0 }}>No purchases yet.</p> : (
        <div className="sf-table-wrap">
          <table className="sf-table mboost-events">
            <thead><tr><th>Received</th><th>Channel</th><th>Event</th><th>From</th><th>Order</th><th>Counted</th></tr></thead>
            <tbody>{rows.map((e: any, i: number) => (
              <tr key={i}><td className="sf-mono sf-muted">{new Date(e.receivedAt).toLocaleTimeString('en-US')}</td><td>{SHORT[e.channel as Ch]}</td><td>{e.eventName}</td><td>{e.source === 'server' ? 'Server' : 'Browser'}</td><td className="sf-mono" title={String(e.eventId)}>{String(e.eventId).replace(/^order_/, '').slice(-10)}</td><td>{e.deduplicated ? <Badge tone="info">Deduplicated</Badge> : <Badge tone="ok">Counted</Badge>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ManagedBoost({ storeId, products }: { storeId: string; products: any[] }) {
  const [o, setO] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<Group | null>(null);
  const [sp, setSp] = useState('');
  const [requestId, setRequestId] = useState(rid);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => {
    api<Overview>(`/boost/managed?storeId=${storeId}`).then((r) => {
      setO(r);
      setDraft((d: Group | null) => (d ? r.groups.find((x) => x.id === d.id) ?? d : r.groups.find((x) => x.status === 'DRAFT' || x.status === 'FAILED') ?? null));
    }).catch((e) => setError(e.message));
    setTick((t) => t + 1);
  }, [storeId]);
  useEffect(() => { setO(null); setDraft(null); refresh(); }, [refresh]);
  useEffect(() => { if (!sp && products[0]) setSp(products[0].id); }, [products, sp]);
  const launching = o?.groups.some((g) => g.status === 'LAUNCHING');
  useEffect(() => { if (!launching) return; const t = setInterval(refresh, 1500); return () => clearInterval(t); }, [launching, refresh]);
  const onError = useCallback((m: string) => { setFlash(''); setError(m); }, []);
  async function start() {
    setBusy('draft'); setError('');
    try { setDraft(await api<Group>('/boost/managed/drafts', { method: 'POST', body: JSON.stringify({ storeId, storeProductId: sp, requestId }) })); setRequestId(rid()); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not start'); } finally { setBusy(''); }
  }
  async function sync() {
    setBusy('sync');
    try { const r = await api<any>('/boost/managed/sync', { method: 'POST', body: JSON.stringify({ storeId }) }); setO(r.overview); setTick((t) => t + 1); setFlash(`Pulled the latest results for ${r.synced} ad${r.synced === 1 ? '' : 's'}.`); }
    catch (e) { onError(e instanceof Error ? e.message : 'Refresh failed'); } finally { setBusy(''); }
  }
  if (!o) return <p className="sf-muted">Loading…</p>;
  const anyReady = o.channels.some((c) => c.account?.status === 'ready');
  const stub = o.channels.some((c) => c.mode === 'stub');
  const groups = o.groups.filter((g) => g.status !== 'DRAFT' && !(g.status === 'FAILED' && draft?.id === g.id));
  return (
    <>
      {stub && <Callout tone="info" title="Dev mode">Meta, Google and TikTok are simulated: no real ads run and no card is charged. Spend still comes out of your test Ad Fuel so you can see the 15% fee work.</Callout>}
      {flash && <Callout tone="ok">{flash}</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}
      <div className="grid-2 boost-grid">
        <div className="sf-stack">
          {draft ? (
            <Draft key={draft.id} g={draft} o={o} onError={onError} onChange={(g) => { setError(''); if (g && g.status !== 'DRAFT' && g.status !== 'FAILED') { setDraft(null); setFlash('Launching on every channel. This usually takes under a minute.'); } else if (g) setDraft(g); refresh(); }} />
          ) : (
            <section className="sf-card sf-card--ticket">
              <h2 style={{ marginTop: 0 }}>Boost a product</h2>
              <p className="sf-muted" style={{ marginTop: 0 }}>Pick a product. We write the ads, crop the images for every placement, check them against ad policies and launch on the channels you choose.</p>
              <div className="sf-field">
                <label className="sf-label" htmlFor="msp">Product</label>
                <select id="msp" className="sf-select" value={sp} onChange={(e) => setSp(e.target.value)}>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.title ?? p.product.title} · {money(p.priceCents)}</option>)}
                </select>
              </div>
              <button type="button" className="sf-btn sf-btn--brand" disabled={!!busy || !sp || !anyReady} onClick={start}><Icon name="spark" size={18} />{busy === 'draft' ? 'Writing ads…' : 'Make the ads'}</button>
              {!anyReady && <p className="sf-hint">Turn on at least one channel first.</p>}
            </section>
          )}
          {groups.map((g) => <GroupCard key={g.id} g={g} onError={onError} onChange={() => refresh()} />)}
          <Events storeId={storeId} tick={tick} />
        </div>
        <div className="sf-stack">
          <Channels key={o.channels.map((c) => c.account?.status ?? '-').join()} o={o} storeId={storeId} onError={onError} onDone={(m) => { setError(''); setFlash(m); refresh(); }} />
          <section className="sf-card">
            <h3 style={{ marginTop: 0 }}>What it costs</h3>
            <p style={{ margin: '0 0 8px' }}>Ad spend: paid by StoreForge to Meta, Google and TikTok, then taken from your <strong>Ad Fuel</strong> as it happens (hourly).</p>
            <p style={{ margin: 0 }}>Managed Boost fee: <strong className="sf-num">{o.feePct}%</strong> of spend, also from Ad Fuel.</p>
            <p className="sf-hint">Each platform has a spending ceiling set from your fuel, so ads stop before your fuel runs out. Out of fuel pauses every channel; topping up restarts them.</p>
            <hr className="sf-divider" />
            <div className="sf-spread">
              <div><span className="sf-kpi__label">Ad Fuel available</span><strong className="sf-num" style={{ fontSize: '1.3rem' }}><Money cents={o.fuel.availableCents} /></strong></div>
              <Link href="/fuel" className="sf-btn sf-btn--sm sf-btn--money"><Icon name="fuel" size={16} />Add fuel</Link>
            </div>
            {groups.some((g) => g.campaigns.some((c: any) => c.externalId)) && <button type="button" className="sf-btn sf-btn--sm sf-btn--quiet" style={{ marginTop: 12 }} disabled={busy === 'sync'} onClick={sync}><Icon name="sync" size={16} />{busy === 'sync' ? 'Refreshing…' : 'Refresh results'}</button>}
          </section>
        </div>
      </div>
    </>
  );
}
