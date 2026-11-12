'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Callout, Money, money } from '@storeforge/ui/components';
import { ProductImage } from '@storeforge/ui/product-image';
import { marginCalc, SCORE_WEIGHTS } from '@storeforge/shared';

type Score = {
  productId: string; score: number; trendScore: number; marginScore: number; saturationScore: number; etaScore: number; keyword: string;
  orderVelocity: number; searchIndex: number | null; searchChange: number | null; adCount: number | null; profitCents: number; marginPct: number; breakEvenRoas: number | null;
  sources: any; insight: string; angles: { headline: string; primaryText: string; policy: 'pass' | 'warn'; notes: string[] }[] | null; computedAt: string; series: number[];
  product: { id: string; title: string; sku: string; category: string | null; imageUrl: string | null; priceCents: number; costCents: number; etaDaysMin: number; etaDaysMax: number; sourcingLabel: string };
};
type List = { sources: { trends: string; adLibrary: string; adLibraryScope: string; llm: string; llmModel: string }; defaults: { cpaPct: number; supplierShippingCents: number; geo: string }; total: number; unscored: number; categories: string[]; items: Score[] };

const satLabel = (s: number) => (s >= 67 ? { t: 'Crowded', tone: 'bad' as const } : s >= 34 ? { t: 'Busy', tone: 'warn' as const } : { t: 'Quiet', tone: 'ok' as const });

function Spark({ v, label }: { v: number[]; label: string }) {
  if (v.length < 2) return <span className="sf-muted">no data</span>;
  const w = 96, h = 28, max = Math.max(...v, 1);
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - (y / max) * (h - 4)).toFixed(1)}`).join(' ');
  return <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

function Meter({ value, label, invert }: { value: number; label: string; invert?: boolean }) {
  const good = invert ? 100 - value : value;
  return (
    <div className="meter">
      <div className="sf-spread"><span>{label}</span><strong className="sf-num">{value}</strong></div>
      <div className="meter__track" aria-hidden="true"><div className={`meter__fill${good >= 60 ? ' is-good' : good < 34 ? ' is-low' : ''}`} style={{ width: `${Math.max(3, value)}%` }} /></div>
    </div>
  );
}

function Calculator({ s, stores, d }: { s: Score; stores: any[]; d: List['defaults'] }) {
  const p = s.product;
  const [price, setPrice] = useState((p.priceCents / 100).toFixed(2));
  const [cost, setCost] = useState((p.costCents / 100).toFixed(2));
  const [ship, setShip] = useState((d.supplierShippingCents / 100).toFixed(2));
  const [cpa, setCpa] = useState(((p.priceCents * d.cpaPct) / 10_000).toFixed(2));
  const [fee, setFee] = useState('15');
  const [refund, setRefund] = useState('3');
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { setPrice((p.priceCents / 100).toFixed(2)); setCost((p.costCents / 100).toFixed(2)); setCpa(((p.priceCents * d.cpaPct) / 10_000).toFixed(2)); setMsg(''); setErr(''); }, [p.id, p.priceCents, p.costCents, d.cpaPct]);
  const c = (v: string) => Math.max(0, Math.round((Number(v) || 0) * 100));
  const priceC = c(price);
  const r = marginCalc({ priceCents: priceC, costCents: c(cost), supplierShippingCents: c(ship), shippingChargedCents: priceC >= 5000 ? 0 : 499, adCostPerOrderCents: c(cpa), adFeePct: Number(fee), refundRatePct: Math.min(100, Number(refund) || 0) });
  const markup = p.costCents > 0 ? Math.round((priceC / p.costCents - 1) * 100) : 0;
  async function add() {
    setErr(''); setMsg('');
    try {
      const res = await api<any>(`/stores/${storeId}/import`, { method: 'POST', body: JSON.stringify({ productIds: [p.id], markupPercent: Math.max(0, markup) }) });
      setMsg(res.imported ? `Added to your store at about ${money(Math.round(p.costCents * (1 + Math.max(0, markup) / 100)))}.` : 'Already in that store.');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Could not add'); }
  }
  const row = (l: string, v: number, neg = true) => <div className="calc__row"><span>{l}</span><span className="sf-num">{neg && v ? '−' : ''}<Money cents={v} /></span></div>;
  return (
    <div className="sf-card calc">
      <h3 className="mboost-h"><Icon name="calc" size={20} />Margin calculator</h3>
      <p className="sf-hint" style={{ marginTop: 0 }}>Per order, with ads. Change any number; nothing is saved until you add it to a store.</p>
      <div className="calc__in">
        <div className="sf-field"><label className="sf-label" htmlFor="c-price">Your price ($)</label><input id="c-price" className="sf-input sf-num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
        <div className="sf-field"><label className="sf-label" htmlFor="c-cost">Supplier cost ($)</label><input id="c-cost" className="sf-input sf-num" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></div>
        <div className="sf-field"><label className="sf-label" htmlFor="c-ship">Supplier shipping ($)</label><input id="c-ship" className="sf-input sf-num" inputMode="decimal" value={ship} onChange={(e) => setShip(e.target.value)} /></div>
        <div className="sf-field"><label className="sf-label" htmlFor="c-cpa">Ad cost per order ($)</label><input id="c-cpa" className="sf-input sf-num" inputMode="decimal" value={cpa} onChange={(e) => setCpa(e.target.value)} /></div>
        <div className="sf-field"><label className="sf-label" htmlFor="c-fee">Ads run through</label><select id="c-fee" className="sf-select" value={fee} onChange={(e) => setFee(e.target.value)}><option value="15">Boost, managed (15% fee)</option><option value="0">Your own Meta account (0% fee)</option><option value="0.0">No ads</option></select></div>
        <div className="sf-field"><label className="sf-label" htmlFor="c-ref">Refunds set aside (%)</label><input id="c-ref" className="sf-input sf-num" inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value)} /></div>
      </div>
      <div className="calc__out">
        <div className="calc__rows">
          {row('Customer pays (incl. shipping)', r.revenueCents, false)}
          {row('Product + supplier shipping', r.cogsCents)}
          {row('Card fees (2.9% + 30¢)', r.paymentFeesCents)}
          {row('Refund reserve', r.refundReserveCents)}
          {row('Ad spend', fee === '0.0' ? 0 : r.adSpendCents)}
          {row(`Boost fee (${Number(fee)}%)`, fee === '0.0' ? 0 : r.adFeeCents)}
        </div>
        {(() => {
          const shown = fee === '0.0' ? { ...r, profitCents: r.profitBeforeAdsCents, marginPct: r.revenueCents ? Math.round((r.profitBeforeAdsCents / r.revenueCents) * 1000) / 10 : 0 } : r;
          return (
            <div className="calc__result">
              <span className="sf-kpi__label">You keep per order</span>
              <strong className={`sf-num calc__big${shown.profitCents < 0 ? ' is-neg' : ''}`}><Money cents={shown.profitCents} /></strong>
              <span className="sf-muted sf-num">{shown.marginPct}% margin</span>
              <div className="calc__be">
                <span>Break-even ad cost <strong className="sf-num">{r.breakEvenCpaCents > 0 ? money(r.breakEvenCpaCents) : 'n/a'}</strong></span>
                <span>Break-even ROAS <strong className="sf-num">{r.breakEvenRoas != null ? `${r.breakEvenRoas}×` : 'n/a'}</strong></span>
              </div>
            </div>
          );
        })()}
      </div>
      <p className="sf-hint">StoreForge takes no commission on orders. Ad cost per order is a guess until Boost has real numbers for this product: we start at {d.cpaPct}% of the price. Supplier shipping is an estimate until CJ quotes it.</p>
      <div className="sf-row" style={{ marginTop: 6 }}>
        <select aria-label="Store" className="sf-select" value={storeId} onChange={(e) => setStoreId(e.target.value)} disabled={!stores.length} style={{ maxWidth: 220 }}>
          {stores.length === 0 && <option>No store yet</option>}
          {stores.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <button className="sf-btn sf-btn--brand" onClick={add} disabled={!storeId || markup < 0}><Icon name="add" size={18} />Add to store at {money(Math.round(p.costCents * (1 + Math.max(0, markup) / 100)))}</button>
      </div>
      {msg && <Callout tone="ok">{msg}</Callout>}
      {err && <Callout tone="bad">{err}</Callout>}
    </div>
  );
}

export default function ResearchPage() {
  const [data, setData] = useState<List | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState('score');
  const [sel, setSel] = useState<string>('');
  const [stores, setStores] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [authError, setAuthError] = useState('');

  const load = useCallback(() => {
    const p = new URLSearchParams({ sort, take: '25' });
    if (q.trim()) p.set('q', q.trim());
    if (category) p.set('category', category);
    return api<List>(`/research/products?${p}`).then((d) => { setData(d); setSel((cur) => (d.items.some((i) => i.productId === cur) ? cur : d.items[0]?.productId ?? '')); }).catch((e) => setAuthError(e.message));
  }, [q, category, sort]);
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);
  useEffect(() => { api<any[]>('/stores').then(setStores).catch(() => null); }, []);

  async function scoreMore() {
    setBusy(true); setMsg('');
    try {
      const r = await api<any>('/research/refresh', { method: 'POST', body: JSON.stringify({ limit: 50 }) });
      setMsg(r.throttled ? 'Scoring is already running. Try again in half a minute.' : `Scored ${r.scored} product${r.scored === 1 ? '' : 's'}${r.remaining ? `, ${r.remaining} to go` : ''}.`);
      await load();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not score'); } finally { setBusy(false); }
  }
  async function rescore(id: string) {
    setBusy(true);
    try { await api(`/research/products/${id}/refresh`, { method: 'POST' }); await load(); } finally { setBusy(false); }
  }

  const s = useMemo(() => data?.items.find((i) => i.productId === sel) ?? null, [data, sel]);
  if (authError) return <SignInNeeded error={authError} />;
  const src = data?.sources;
  const sample = src && (src.trends === 'stub' || src.adLibrary === 'stub');

  return (
    <>
      <PageHead
        eyebrow="Research · what to sell next"
        icon="research"
        title="Research"
        lede={<>Every product gets a score out of 100: is demand growing, what you keep after ads, how many shops already advertise it, and how fast it arrives. Pick a product to see the numbers behind it.</>}
        actions={<button className="sf-btn sf-btn--brand" onClick={scoreMore} disabled={busy}><Icon name="sync" size={18} />{busy ? 'Scoring…' : data?.unscored ? `Score ${Math.min(50, data.unscored)} more` : 'Refresh scores'}</button>}
      />
      {sample && (
        <Callout tone="info" title="Sample data">
          Search trends and ad counts are sample numbers until a Google Trends source (SerpApi) and the Meta Ad Library are connected. Prices, costs, margins, shipping times and StoreForge order counts are real.
        </Callout>
      )}
      {msg && <Callout tone="ok">{msg}</Callout>}
      <div className="toolbar">
        <div className="sf-field"><label className="sf-label" htmlFor="r-q">Search</label><input id="r-q" className="sf-input" placeholder="lamp, bottle, charger…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="sf-field"><label className="sf-label" htmlFor="r-cat">Category</label><select id="r-cat" className="sf-select" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{data?.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
        <div className="sf-field"><label className="sf-label" htmlFor="r-sort">Sort by</label><select id="r-sort" className="sf-select" value={sort} onChange={(e) => setSort(e.target.value)}><option value="score">Best overall</option><option value="trend">Rising demand</option><option value="margin">Best margin</option><option value="room">Least competition</option><option value="eta">Fastest shipping</option></select></div>
        <div className="toolbar__push sf-muted" style={{ alignSelf: 'center', fontSize: '0.85rem' }}>{data ? <><span className="sf-num">{data.total}</span> scored{data.unscored ? <> · <span className="sf-num">{data.unscored}</span> not yet</> : null}</> : 'Loading…'}</div>
      </div>

      <div className="research">
        <div className="sf-card sf-card--flush">
          <div className="sf-table-wrap">
            <table className="sf-table research__table">
              <thead><tr><th>Product</th><th className="sf-num">Score</th><th>Demand (12 mo)</th><th className="sf-num">You keep</th><th>Competition</th><th>Ships in</th></tr></thead>
              <tbody>
                {data && data.items.length === 0 && <tr><td colSpan={6} className="sf-muted">No scored products yet. Press “Score {Math.min(50, data.unscored)} more”.</td></tr>}
                {data?.items.map((x) => {
                  const sat = satLabel(x.saturationScore);
                  return (
                    <tr key={x.productId} aria-selected={x.productId === sel} className={x.productId === sel ? 'is-sel' : undefined} onClick={() => setSel(x.productId)}>
                      <td>
                        <button type="button" className="prodcell research__pick" onClick={() => setSel(x.productId)} aria-pressed={x.productId === sel}>
                          <span className="thumb"><ProductImage src={x.product.imageUrl} alt="" /></span>
                          <span><strong>{x.product.title}</strong><span className="sf-muted" style={{ fontSize: '0.78rem', display: 'block' }}>{x.product.category ?? 'Uncategorised'}</span></span>
                        </button>
                      </td>
                      <td className="sf-num"><span className={`scorepill${x.score >= 65 ? ' is-good' : x.score < 40 ? ' is-low' : ''}`}>{x.score}</span></td>
                      <td><span className="trendcell"><Spark v={x.series} label={`Search interest for ${x.keyword}`} />{x.searchChange != null && <span className={`sf-num ${x.searchChange > 0 ? 'is-up' : x.searchChange < 0 ? 'is-down' : ''}`}><Icon name={x.searchChange >= 0 ? 'up' : 'down'} size={14} />{x.searchChange > 0 ? '+' : ''}{Math.round(x.searchChange)}</span>}</span></td>
                      <td className="sf-num"><span className={x.profitCents < 0 ? 'is-neg' : ''}><Money cents={x.profitCents} /></span><span className="sf-muted" style={{ display: 'block', fontSize: '0.78rem' }}>{x.marginPct}%</span></td>
                      <td><Badge tone={sat.tone}>{sat.t}</Badge>{x.adCount != null && <span className="sf-muted sf-num" style={{ fontSize: '0.78rem', display: 'block' }}>{x.adCount} ads</span>}</td>
                      <td><Badge><Icon name="eta" size={14} />{x.product.etaDaysMin}–{x.product.etaDaysMax} d</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {s && (
          <div className="research__side">
            <div className="sf-card">
              <div className="sf-spread" style={{ alignItems: 'flex-start' }}>
                <div>
                  <p className="sf-eyebrow" style={{ margin: 0 }}>Score</p>
                  <h2 style={{ margin: '4px 0 0' }}>{s.product.title}</h2>
                  <span className="sf-muted" style={{ fontSize: '0.85rem' }}>Researched as “{s.keyword}” · {new Date(s.computedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </div>
                <span className={`scorebig${s.score >= 65 ? ' is-good' : s.score < 40 ? ' is-low' : ''}`} aria-label={`Score ${s.score} out of 100`}>{s.score}</span>
              </div>
              <div className="meters">
                <Meter label={`Demand · ${Math.round(SCORE_WEIGHTS.trend * 100)}%`} value={s.trendScore} />
                <Meter label={`Margin after ads · ${Math.round(SCORE_WEIGHTS.margin * 100)}%`} value={s.marginScore} />
                <Meter label={`Competition · ${Math.round(SCORE_WEIGHTS.room * 100)}% (lower is better)`} value={s.saturationScore} invert />
                <Meter label={`Shipping speed · ${Math.round(SCORE_WEIGHTS.eta * 100)}%`} value={s.etaScore} />
              </div>
              <dl className="boost-dl research__facts">
                <div><dt>Search interest</dt><dd className="sf-num">{s.searchIndex ?? '–'}/100 {s.searchChange != null && <>({s.searchChange > 0 ? '+' : ''}{Math.round(s.searchChange)} in 12 wk)</>}</dd></div>
                <div><dt>Sold on StoreForge</dt><dd className="sf-num">{s.orderVelocity}/day (14 d)</dd></div>
                <div><dt>Active ads</dt><dd className="sf-num">{s.adCount ?? '–'} <span className="sf-muted">({s.sources?.adLibraryScope})</span></dd></div>
                <div><dt>Break-even ROAS</dt><dd className="sf-num">{s.breakEvenRoas != null ? `${s.breakEvenRoas}×` : 'n/a'}</dd></div>
              </dl>
              <p className="research__insight">{s.insight}</p>
              <span className="sf-hint">Sources: trends {s.sources?.trends === 'stub' ? 'sample' : 'Google Trends via SerpApi'} · ads {s.sources?.adLibrary === 'stub' ? 'sample' : 'Meta Ad Library'} · text {s.sources?.llm === 'stub' ? 'template' : s.sources?.llmModel}</span>
              <div className="sf-row" style={{ marginTop: 10 }}>
                <button className="sf-btn sf-btn--sm sf-btn--quiet" onClick={() => rescore(s.productId)} disabled={busy}><Icon name="sync" size={16} />Re-score</button>
                <Link className="sf-btn sf-btn--sm sf-btn--quiet" href="/boost">Boost it after adding<Icon name="next" size={16} /></Link>
              </div>
            </div>
            {s.angles && s.angles.length > 0 && (
              <div className="sf-card">
                <h3 className="mboost-h"><Icon name="spark" size={20} />Ad angle drafts</h3>
                <p className="sf-hint" style={{ marginTop: 0 }}>Starting points, checked against ad policy. Nothing is published from here.</p>
                <div className="angles">
                  {s.angles.map((a, i) => (
                    <div key={i} className="angle">
                      <div className="sf-spread"><strong>{a.headline}</strong>{a.policy === 'warn' ? <Badge tone="warn">Check wording</Badge> : <Badge tone="ok">Policy OK</Badge>}</div>
                      <p>{a.primaryText}</p>
                      {a.notes.length > 0 && <span className="sf-hint">{a.notes.join(' ')}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {data && <Calculator s={s} stores={stores} d={data.defaults} />}
          </div>
        )}
      </div>
    </>
  );
}
