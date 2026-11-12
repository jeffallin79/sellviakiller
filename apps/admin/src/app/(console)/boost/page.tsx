'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Bars, Callout, Collage, Money, money } from '@storeforge/ui/components';

const rid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
const toCents = (s: string) => Math.round(Number(s.replace(/[$,\s]/g, '')) * 100);
const cleanName = (n: string) => n.replace(/\s*\[sf:[^\]]+\]\s*$/, '');
const ERRORS: Record<string, string> = {
  cancelled: 'You cancelled the Facebook connection. Nothing changed.',
  access_denied: 'You cancelled the Facebook connection. Nothing changed.',
  expired_state: 'That connection link expired or was already used. Start again.',
  missing_state: 'That connection link was incomplete. Start again.',
  missing_scopes: 'Facebook didn’t grant every permission Boost needs. Reconnect and leave all of them switched on.',
  exchange_failed: 'Facebook didn’t accept the connection. Try again in a minute.',
};
const STAGE: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand' }> = {
  DRAFT: { label: 'Setting up', tone: 'neutral' }, REVIEW: { label: 'In review at Meta', tone: 'info' }, WARMING: { label: 'Warming up', tone: 'brand' },
  STEADY: { label: 'Steady', tone: 'ok' }, PAUSED: { label: 'Paused', tone: 'warn' }, REJECTED: { label: 'Rejected by Meta', tone: 'bad' },
};
const PAUSED_WHY: Record<string, string> = { merchant: 'by you', low_fuel: 'out of fuel', rejected: 'ad rejected', disconnected: 'Facebook disconnected' };

type Overview = {
  mode: 'stub' | 'live'; feePct: number; managedFeePct: number; minDailyCents: number; usesFuel: boolean; requiredScopes: string[];
  connection: { status: string; name: string | null; scopes: string[]; expiresAt: string | null; lastError: string | null; connectedAt: string } | null;
  account: { id: string; externalId: string; name: string; currency: string; pageName: string | null; pixelId: string | null; pixelName: string | null; testEventCode: string | null } | null;
  campaigns: any[];
};

function Connect({ o, storeId, onError }: { o: Overview; storeId: string; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const c = o.connection;
  const again = c && c.status !== 'active';
  async function go() {
    setBusy(true);
    try { const r = await api<any>('/boost/meta/connect', { method: 'POST', body: JSON.stringify({ storeId }) }); window.location.href = r.url; }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not start'); setBusy(false); }
  }
  return (
    <section className="sf-card empty">
      <Collage />
      <div>
        <h2 style={{ marginTop: 0 }}>{again ? 'Reconnect Facebook' : 'Connect your Facebook ad account'}</h2>
        {again && <Callout tone="warn">{c?.lastError ?? 'Facebook access expired.'} Your campaigns are paused until you reconnect.</Callout>}
        <p className="sf-muted">Ads run in your own Meta ad account and Meta bills you for the spend directly. Boost creates and watches the campaigns for you and sends purchases back to Meta so it can find more buyers.</p>
        <p className="sf-hint">Facebook will ask to let StoreForge: manage your ads, read their results, see your Pages and your business assets. You can remove access any time in Facebook settings.</p>
        <button type="button" className="sf-btn sf-btn--brand" disabled={busy} onClick={go}><Icon name="boost" size={18} />{busy ? 'Opening Facebook…' : again ? 'Reconnect Facebook' : 'Continue with Facebook'}</button>
      </div>
    </section>
  );
}

function PickAccount({ storeId, onSaved, onError }: { storeId: string; onSaved: () => void; onError: (m: string) => void }) {
  const [opts, setOpts] = useState<any>(null);
  const [acct, setAcct] = useState('');
  const [page, setPage] = useState('');
  const [pixel, setPixel] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback((adAccountId?: string) => {
    api<any>(`/boost/meta/options?storeId=${storeId}${adAccountId ? `&adAccountId=${encodeURIComponent(adAccountId)}` : ''}`).then((r) => {
      setOpts(r); setAcct(r.adAccountId ?? ''); setPage((p) => p || r.pages[0]?.id || ''); setPixel(r.pixels[0]?.id ?? '');
    }).catch((e) => onError(e.message));
  }, [storeId, onError]);
  useEffect(() => { load(); }, [load]);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { await api('/boost/meta/account', { method: 'POST', body: JSON.stringify({ storeId, adAccountId: acct, pageId: page, pixelId: pixel, testEventCode: code.trim() || null }) }); onSaved(); }
    catch (err) { onError(err instanceof Error ? err.message : 'Could not save'); } finally { setBusy(false); }
  }
  if (!opts) return <section className="sf-card"><p className="sf-muted" style={{ margin: 0 }}>Loading your Facebook accounts…</p></section>;
  const usable = opts.accounts.filter((a: any) => a.accountStatus === 1);
  return (
    <form className="sf-card" onSubmit={save}>
      <h2 style={{ marginTop: 0 }}>Choose where ads run</h2>
      <div className="fuel-two">
        <div className="sf-field">
          <label className="sf-label" htmlFor="acct">Ad account</label>
          <select id="acct" className="sf-select" value={acct} onChange={(e) => { setAcct(e.target.value); load(e.target.value); }}>
            {opts.accounts.map((a: any) => <option key={a.id} value={a.id} disabled={a.accountStatus !== 1}>{a.name} · {a.currency}{a.accountStatus !== 1 ? ' (disabled)' : ''}</option>)}
          </select>
        </div>
        <div className="sf-field">
          <label className="sf-label" htmlFor="page">Facebook Page (ads show as)</label>
          <select id="page" className="sf-select" value={page} onChange={(e) => setPage(e.target.value)}>
            {opts.pages.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="sf-field">
          <label className="sf-label" htmlFor="pixel">Pixel (tracks sales)</label>
          <select id="pixel" className="sf-select" value={pixel} onChange={(e) => setPixel(e.target.value)}>
            {opts.pixels.map((p: any) => <option key={p.id} value={p.id}>{p.name} · {p.id}</option>)}
          </select>
          {opts.pixels.length === 0 && <span className="sf-hint">This ad account has no Pixel. Create one in Meta Events Manager, then pick it here.</span>}
        </div>
        <div className="sf-field">
          <label className="sf-label" htmlFor="tcode">Test event code (optional)</label>
          <input id="tcode" className="sf-input sf-mono" placeholder="TEST12345" value={code} onChange={(e) => setCode(e.target.value)} />
          <span className="sf-hint">From Events Manager → Test events. Purchases show there while it&apos;s set.</span>
        </div>
      </div>
      {usable.length === 0 && <Callout tone="warn">None of your ad accounts can run ads right now. Check them in Meta Ads Manager.</Callout>}
      <button type="submit" className="sf-btn sf-btn--brand" disabled={busy || !acct || !page || !pixel}>{busy ? 'Saving…' : 'Use these'}</button>
    </form>
  );
}

function AccountCard({ o, storeId, onChange, onError }: { o: Overview; storeId: string; onChange: () => void; onError: (m: string) => void }) {
  const a = o.account!;
  const [code, setCode] = useState(a.testEventCode ?? '');
  const [busy, setBusy] = useState('');
  async function act(k: string, path: string, body: object) {
    setBusy(k);
    try { await api(path, { method: 'POST', body: JSON.stringify({ storeId, ...body }) }); onChange(); }
    catch (e) { onError(e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(''); }
  }
  return (
    <section className="sf-card sf-card--sunken">
      <div className="sf-spread"><h3 style={{ margin: 0 }}>Facebook</h3><Badge tone="ok">Connected</Badge></div>
      <dl className="boost-dl">
        <dt>Signed in as</dt><dd>{o.connection?.name ?? '—'}</dd>
        <dt>Ad account</dt><dd>{a.name} <span className="sf-mono sf-hint">{a.externalId}</span></dd>
        <dt>Page</dt><dd>{a.pageName ?? '—'}</dd>
        <dt>Pixel</dt><dd>{a.pixelName ?? '—'} <span className="sf-mono sf-hint">{a.pixelId}</span></dd>
      </dl>
      <div className="sf-field">
        <label className="sf-label" htmlFor="tc">Test event code</label>
        <div className="sf-row" style={{ gap: 8 }}>
          <input id="tc" className="sf-input sf-mono" value={code} placeholder="none" onChange={(e) => setCode(e.target.value)} />
          <button type="button" className="sf-btn sf-btn--sm sf-btn--alt" disabled={busy === 'code'} onClick={() => act('code', '/boost/meta/test-code', { code: code.trim() || null })}>Save</button>
        </div>
        <span className="sf-hint">Clear it when you&apos;re done testing so purchases count normally.</span>
      </div>
      <button type="button" className="sf-btn sf-btn--sm sf-btn--quiet" disabled={busy === 'dc'}
        onClick={() => { if (window.confirm('Disconnect Facebook? Running Boost campaigns are paused first.')) act('dc', '/boost/meta/disconnect', {}); }}>
        <Icon name="close" size={16} />Disconnect
      </button>
    </section>
  );
}

function NewCampaign({ o, storeId, products, onCreated, onError }: { o: Overview; storeId: string; products: any[]; onCreated: (m: string) => void; onError: (m: string) => void }) {
  const [sp, setSp] = useState(products[0]?.id ?? '');
  const [budget, setBudget] = useState(String(Math.max(o.minDailyCents, 2000) / 100));
  const [headline, setHeadline] = useState('');
  const [requestId, setRequestId] = useState(rid);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!sp && products[0]) setSp(products[0].id); }, [products, sp]);
  const cents = toCents(budget);
  const feeDay = Math.round((cents * o.feePct) / 100);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      // requestId stays until success: double-submits and retries resume the same campaign.
      await api('/boost/campaigns', { method: 'POST', body: JSON.stringify({ storeId, storeProductId: sp, dailyBudgetCents: cents, requestId, headline: headline.trim() || undefined }) });
      setRequestId(rid()); setHeadline('');
      onCreated('Campaign sent to Meta for review. Review usually takes under a day.');
    } catch (err) { onError(err instanceof Error ? err.message : 'Could not create the campaign'); } finally { setBusy(false); }
  }
  return (
    <form className="sf-card sf-card--ticket" onSubmit={go}>
      <h2 style={{ marginTop: 0 }}>Boost a product</h2>
      <div className="sf-field">
        <label className="sf-label" htmlFor="sp">Product</label>
        <select id="sp" className="sf-select" value={sp} onChange={(e) => setSp(e.target.value)}>
          {products.map((p) => <option key={p.id} value={p.id}>{p.title ?? p.product.title} · {money(p.priceCents)}</option>)}
        </select>
      </div>
      <div className="fuel-two">
        <div className="sf-field">
          <label className="sf-label" htmlFor="bud">Daily budget</label>
          <input id="bud" className="sf-input sf-num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          <span className="sf-hint">From {money(o.minDailyCents)}/day. Change it any time.</span>
        </div>
        <div className="sf-field">
          <label className="sf-label" htmlFor="hl">Headline (optional)</label>
          <input id="hl" className="sf-input" maxLength={40} placeholder="Product name" value={headline} onChange={(e) => setHeadline(e.target.value)} />
        </div>
      </div>
      <p className="sf-hint">
        Meta bills your ad account for the spend. {o.feePct > 0
          ? <>Boost&apos;s fee is <strong className="sf-num">{o.feePct}%</strong> of spend (about <span className="sf-num">{money(feeDay)}</span>/day at this budget), paid from Ad Fuel.</>
          : <>Boost&apos;s fee is <strong className="sf-num">0%</strong> on your own ad account, so no Ad Fuel is used.</>}
      </p>
      <button type="submit" className="sf-btn sf-btn--brand" disabled={busy || !sp || !(cents >= o.minDailyCents)}><Icon name="boost" size={18} />{busy ? 'Launching…' : 'Launch on Meta'}</button>
    </form>
  );
}

function Campaign({ c, onAct, busy }: { c: any; onAct: (id: string, a: 'pause' | 'resume') => void; busy: string }) {
  const s = STAGE[c.stage] ?? { label: c.stage, tone: 'neutral' as const };
  const days = [...c.days].reverse().slice(-14);
  const running = c.stage === 'REVIEW' || c.stage === 'WARMING' || c.stage === 'STEADY';
  return (
    <article className="sf-card boost-campaign">
      <div className="sf-spread">
        <div>
          <h3 style={{ margin: 0 }}>{cleanName(c.name)}</h3>
          <span className="sf-hint"><span className="sf-num">{money(c.dailyBudgetCents)}</span>/day · Meta{c.externalId ? <> · <span className="sf-mono">{c.externalId}</span></> : null}</span>
        </div>
        <Badge tone={s.tone}>{s.label}{c.stage === 'PAUSED' && c.pausedReason ? ` · ${PAUSED_WHY[c.pausedReason] ?? c.pausedReason}` : ''}</Badge>
      </div>
      {c.lastError && <Callout tone={c.stage === 'REJECTED' ? 'bad' : 'warn'}>{c.lastError}</Callout>}
      {c.stage === 'WARMING' && <p className="sf-hint" style={{ margin: 0 }}>Meta is learning who buys. Results swing for the first week or about 50 purchases; avoid big changes.</p>}
      <div className="boost-stats">
        <div><span className="sf-kpi__label">Spend</span><strong className="sf-num"><Money cents={c.totals.spendCents} /></strong></div>
        <div><span className="sf-kpi__label">Purchases</span><strong className="sf-num">{c.totals.purchases}</strong></div>
        <div><span className="sf-kpi__label">Sales</span><strong className="sf-num"><Money cents={c.totals.revenueCents} /></strong></div>
        <div><span className="sf-kpi__label">ROAS</span><strong className="sf-num">{c.totals.roas == null ? '—' : `${c.totals.roas}×`}</strong></div>
        <div><span className="sf-kpi__label">Clicks</span><strong className="sf-num">{c.totals.clicks.toLocaleString()}</strong></div>
        <div><span className="sf-kpi__label">Fuel charged</span><strong className="sf-num"><Money cents={c.totals.fuelChargedCents} /></strong></div>
      </div>
      {days.length > 1 && <Bars values={days.map((d: any) => d.spendCents)} labels={days.map((d: any) => d.date.slice(5))} hotIndex={days.length - 1} />}
      <div className="sf-row" style={{ gap: 8 }}>
        {running && <button type="button" className="sf-btn sf-btn--sm sf-btn--alt" disabled={busy === c.id} onClick={() => onAct(c.id, 'pause')}>Pause</button>}
        {c.stage === 'PAUSED' && <button type="button" className="sf-btn sf-btn--sm sf-btn--brand" disabled={busy === c.id || c.pausedReason === 'low_fuel'} onClick={() => onAct(c.id, 'resume')}>Resume</button>}
        {c.stage === 'PAUSED' && c.pausedReason === 'low_fuel' && <Link href="/fuel" className="sf-btn sf-btn--sm sf-btn--money"><Icon name="fuel" size={16} />Add fuel to restart</Link>}
        {c.lastSyncedAt && <span className="sf-hint" style={{ marginLeft: 'auto' }}>Updated {new Date(c.lastSyncedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>}
      </div>
    </article>
  );
}

function TestEvents({ storeId, tick }: { storeId: string; tick: number }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api<any>(`/boost/events?storeId=${storeId}`).then(setD).catch(() => setD(null)); }, [storeId, tick]);
  if (!d) return null;
  return (
    <section className="sf-card sf-card--flush">
      <div className="sf-spread" style={{ padding: '16px 18px 0' }}>
        <h2 style={{ margin: 0 }}>Purchase tracking</h2>
        {d.testEvents.mode === 'live' && d.testEvents.eventsManagerUrl && <a className="sf-btn sf-btn--sm sf-btn--quiet" href={d.testEvents.eventsManagerUrl} target="_blank" rel="noreferrer">Open Test Events</a>}
      </div>
      <p className="sf-hint" style={{ padding: '0 18px' }}>Each sale is sent twice, from the shopper&apos;s browser and from our server, with the same event ID so Meta counts it once.</p>
      {d.testEvents.mode === 'stub' && d.testEvents.events.length > 0 && (
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead><tr><th>Received (Test Events)</th><th>Event</th><th>From</th><th>Event ID</th><th>Counted</th></tr></thead>
            <tbody>
              {d.testEvents.events.slice(0, 10).map((e: any, i: number) => (
                <tr key={i}>
                  <td className="sf-mono sf-muted">{new Date(e.receivedAt).toLocaleTimeString('en-US')}</td>
                  <td>{e.eventName}</td>
                  <td>{e.source === 'server' ? 'Server' : 'Browser'}</td>
                  <td className="sf-mono">{e.eventId}</td>
                  <td>{e.deduplicated ? <Badge tone="info">Deduplicated</Badge> : <Badge tone="ok">Counted</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.server.length === 0 ? <p className="sf-muted" style={{ padding: '0 18px 18px', margin: 0 }}>No purchases sent yet.</p> : (
        <div className="sf-table-wrap">
          <table className="sf-table">
            <thead><tr><th>Server events</th><th>Event ID</th><th>Status</th><th>Test code</th></tr></thead>
            <tbody>
              {d.server.slice(0, 10).map((e: any) => (
                <tr key={e.id}>
                  <td className="sf-mono sf-muted">{new Date(e.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td className="sf-mono">{e.eventId}</td>
                  <td><Badge tone={e.metaStatus === 'sent' ? 'ok' : e.metaStatus === 'failed' ? 'bad' : e.metaStatus === 'skipped' ? 'neutral' : 'warn'}>{e.metaStatus === 'skipped' ? 'no consent' : e.metaStatus}</Badge>{e.lastError && e.metaStatus !== 'sent' ? <div className="sf-hint">{e.lastError}</div> : null}</td>
                  <td className="sf-mono sf-muted">{e.testEventCode ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function BoostInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [stores, setStores] = useState<any[] | null>(null);
  const [storeId, setStoreId] = useState('');
  const [o, setO] = useState<Overview | null>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [authError, setAuthError] = useState('');
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api<any[]>('/stores').then((s) => {
      setStores(s);
      const want = params.get('store');
      setStoreId((cur) => cur || s.find((x) => x.id === want || x.slug === want)?.id || s[0]?.id || '');
    }).catch((e) => setAuthError(e.message));
    const err = params.get('error');
    if (err) setError(ERRORS[err] ?? 'Facebook connection failed. Try again.');
    if (params.get('connected')) setFlash('Facebook connected. Now pick the ad account, Page and Pixel to use.');
    if (err || params.get('connected')) router.replace('/boost');
  }, [params, router]);

  const refresh = useCallback(() => {
    if (!storeId) return;
    api<Overview>(`/boost?storeId=${storeId}`).then(setO).catch((e) => setError(e.message));
    setTick((t) => t + 1);
  }, [storeId]);
  useEffect(() => { setO(null); refresh(); }, [refresh]);
  const store = useMemo(() => stores?.find((s) => s.id === storeId), [stores, storeId]);
  useEffect(() => { if (store) api<any[]>(`/storefront/${store.slug}/products`).then(setProducts).catch(() => setProducts([])); }, [store]);
  const onError = useCallback((m: string) => { setFlash(''); setError(m); }, []);

  async function act(id: string, a: 'pause' | 'resume') {
    setBusy(id); setError('');
    try { await api(`/boost/campaigns/${id}/${a}`, { method: 'POST', body: '{}' }); refresh(); } catch (e) { onError(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(''); }
  }
  async function sync() {
    setBusy('sync'); setError('');
    try { const r = await api<any>('/boost/sync', { method: 'POST', body: JSON.stringify({ storeId }) }); setO(r.overview); setTick((t) => t + 1); setFlash(`Pulled the latest results from Meta for ${r.synced} campaign${r.synced === 1 ? '' : 's'}.`); }
    catch (e) { onError(e instanceof Error ? e.message : 'Refresh failed'); } finally { setBusy(''); }
  }

  if (authError) return <SignInNeeded error={authError} />;
  const connected = o?.connection?.status === 'active';

  return (
    <>
      <PageHead
        eyebrow="Boost · ads" icon="boost" title="Boost"
        lede="Advertise a product on Facebook and Instagram from your own Meta ad account. Boost sets up the campaign, tracks every sale and shows true results."
        actions={
          <div className="sf-row" style={{ gap: 10 }}>
            {stores && stores.length > 1 && (
              <div className="sf-field" style={{ margin: 0 }}>
                <label className="sf-label" htmlFor="store">Store</label>
                <select id="store" className="sf-select" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                  {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            {o?.campaigns.some((c) => c.externalId) && <button type="button" className="sf-btn sf-btn--alt" disabled={busy === 'sync'} onClick={sync}><Icon name="sync" size={18} />{busy === 'sync' ? 'Refreshing…' : 'Refresh results'}</button>}
          </div>
        }
      />
      {o?.mode === 'stub' && <Callout tone="info" title="Dev mode">Facebook is simulated: no real ads run and nothing is charged. Results come from a stand-in Meta that behaves like the real one.</Callout>}
      {flash && <Callout tone="ok">{flash}</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}
      {stores?.length === 0 && <Callout tone="warn">Open a store first, then boost its products.</Callout>}
      {!o ? (storeId ? <p className="sf-muted">Loading…</p> : null) : !connected ? <Connect o={o} storeId={storeId} onError={onError} /> : !o.account ? (
        <PickAccount storeId={storeId} onSaved={() => { setFlash('All set. Boost your first product below.'); refresh(); }} onError={onError} />
      ) : (
        <div className="grid-2 boost-grid">
          <div className="sf-stack">
            <NewCampaign o={o} storeId={storeId} products={products} onCreated={(m) => { setError(''); setFlash(m); refresh(); }} onError={onError} />
            {o.campaigns.length === 0 ? <p className="sf-muted">No campaigns yet.</p> : o.campaigns.map((c) => <Campaign key={c.id} c={c} onAct={act} busy={busy} />)}
            <TestEvents storeId={storeId} tick={tick} />
          </div>
          <div className="sf-stack">
            <AccountCard key={o.account.id} o={o} storeId={storeId} onChange={refresh} onError={onError} />
            <section className="sf-card">
              <h3 style={{ marginTop: 0 }}>What it costs</h3>
              <p style={{ margin: '0 0 8px' }}>Ad spend: billed by Meta to <strong>your</strong> ad account.</p>
              <p style={{ margin: 0 }}>Boost fee: <strong className="sf-num">{o.feePct}%</strong> of spend{o.feePct > 0 ? ', from Ad Fuel' : ''}. Platform-managed ads (coming later) are <span className="sf-num">{o.managedFeePct}%</span> and run on Ad Fuel.</p>
              <hr className="sf-divider" />
              <Link href="/fuel" className="sf-btn sf-btn--sm sf-btn--quiet"><Icon name="fuel" size={16} />Ad Fuel wallet</Link>
            </section>
          </div>
        </div>
      )}
    </>
  );
}

export default function BoostPage() {
  return <Suspense fallback={null}><BoostInner /></Suspense>;
}
