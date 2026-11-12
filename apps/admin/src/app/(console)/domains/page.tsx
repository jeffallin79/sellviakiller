'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { PageHead } from '@/components/PageHead';
import { SignInNeeded } from '@/components/SignInNeeded';
import { Icon } from '@storeforge/ui/icons';
import { Badge, Callout, StatusBadge } from '@storeforge/ui/components';

type Rec = { type: string; name: string; value: string; purpose: 'ownership' | 'routing'; ok: boolean | null; alternative?: boolean };
type Domain = {
  id: string; host: string; status: 'PENDING_DNS' | 'ISSUING_TLS' | 'ACTIVE' | 'FAILED'; isPrimary: boolean; apex: boolean;
  records: Rec[]; lastError: string | null; lastCheckedAt: string | null; nextCheckAt: string | null; verifiedAt: string | null;
  tlsIssuedAt: string | null; tlsSeconds: number | null; dnsMode: 'live' | 'stub'; tlsProvider: string | null; createdAt: string;
};
type Config = { dnsMode: 'live' | 'stub'; tlsProvider: string; cnameTarget: string; apexIps: string[]; maxPerStore: number; dnsTimeoutHours: number };

const STEPS = [
  { key: 'records', label: 'Add DNS records' },
  { key: 'dns', label: 'DNS verified' },
  { key: 'tls', label: 'HTTPS certificate' },
  { key: 'live', label: 'Live' },
] as const;

function stepIndex(d: Domain) {
  if (d.status === 'ACTIVE') return 4;
  if (d.status === 'ISSUING_TLS') return 2;
  if (d.status === 'FAILED') return d.verifiedAt ? 2 : 0;
  return 0;
}

function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copybtn"
      aria-label={done ? `${label} copied` : `Copy ${label}`}
      title={done ? 'Copied' : 'Copy'}
      onClick={() => { navigator.clipboard?.writeText(text).catch(() => null); setDone(true); setTimeout(() => setDone(false), 1500); }}
    >
      <Icon name={done ? 'done' : 'copy'} size={16} />
    </button>
  );
}

function CopyCell({ text, label }: { text: string; label: string }) {
  return <span className="copycell"><span className="sf-mono recval">{text}</span><Copy text={text} label={label} /></span>;
}

function RecordState({ ok }: { ok: boolean | null }) {
  if (ok === true) return <span className="recstate recstate--ok"><Icon name="done" size={16} />Found</span>;
  if (ok === false) return <span className="recstate recstate--bad"><Icon name="warning" size={16} />Not yet</span>;
  return <span className="recstate sf-muted"><Icon name="todo" size={16} />Not checked</span>;
}

function DomainCard({ d, onChange, busy, act }: { d: Domain; onChange: () => void; busy: string; act: (id: string, what: string, fn: () => Promise<unknown>) => void }) {
  const idx = stepIndex(d);
  const failed = d.status === 'FAILED';
  const routing = d.records.filter((r) => r.purpose === 'routing');
  const main = routing.filter((r) => !r.alternative);
  const alt = routing.filter((r) => r.alternative);
  const ownership = d.records.filter((r) => r.purpose === 'ownership');
  const row = (r: Rec, i: number) => (
    <tr key={`${r.type}-${r.name}-${r.value}-${i}`}>
      <td data-label="Type"><Badge tone={r.purpose === 'ownership' ? 'info' : 'brand'}>{r.type}</Badge></td>
      <td data-label="Name / host"><CopyCell text={r.name} label={`${r.type} name`} /></td>
      <td data-label="Value"><CopyCell text={r.value} label={`${r.type} value`} /></td>
      <td data-label="Status"><RecordState ok={r.ok} /></td>
    </tr>
  );
  return (
    <article className="sf-card domain" aria-labelledby={`dom-${d.id}`}>
      <div className="sf-spread">
        <div className="sf-row" style={{ flexWrap: 'wrap' }}>
          <h2 id={`dom-${d.id}`} className="domain__host sf-mono">{d.host}</h2>
          <StatusBadge status={d.status} />
          {d.isPrimary && <Badge tone="money">Primary</Badge>}
        </div>
        {d.status === 'ACTIVE' && <a className="sf-btn sf-btn--sm" href={`https://${d.host}`} target="_blank" rel="noreferrer"><Icon name="next" size={16} />Open</a>}
      </div>

      <ol className="stepper" aria-label="Connection progress">
        {STEPS.map((s, i) => {
          const state = i < idx ? 'done' : i === idx && !failed ? 'now' : i === idx && failed ? 'bad' : 'todo';
          return (
            <li key={s.key} className={`stepper__step stepper__step--${state}`} aria-current={state === 'now' ? 'step' : undefined}>
              <span className="stepper__dot" aria-hidden="true">{state === 'done' ? <Icon name="done" size={16} /> : state === 'bad' ? <Icon name="warning" size={16} /> : i + 1}</span>
              <span>{s.label}</span>
            </li>
          );
        })}
      </ol>

      {d.status === 'ACTIVE' && (
        <Callout tone="ok" title="Your shop is live here">
          HTTPS is on{d.tlsSeconds != null ? `, about ${Math.max(1, Math.round(d.tlsSeconds / 60))} min after DNS checked out` : ''}. Customers, receipts and checkout now use <span className="sf-mono">{d.host}</span>{d.isPrimary ? '' : ' (it redirects to your primary domain)'}.
          {d.lastError ? <><br /><strong>Heads up:</strong> {d.lastError}</> : null}
        </Callout>
      )}
      {d.status === 'ISSUING_TLS' && <Callout tone="info" title="DNS checked out">We&apos;re getting the HTTPS certificate. This usually takes under a minute.</Callout>}
      {failed && <Callout tone="bad" title="This domain isn't connected">{d.lastError}</Callout>}
      {d.status === 'PENDING_DNS' && (
        <Callout tone="warn" title="Add these records at your DNS host">
          Where you bought the domain (GoDaddy, Namecheap, Cloudflare…), add both records below. We check automatically, every 30 seconds at first.
          {d.lastError ? <><br /><span className="sf-muted">Last check {ago(d.lastCheckedAt)}: {d.lastError}</span></> : null}
        </Callout>
      )}

      {d.status !== 'ACTIVE' && (
        <div className="sf-table-wrap">
          <table className="sf-table rectable">
            <thead><tr><th>Type</th><th>Name / host</th><th>Value</th><th>Status</th></tr></thead>
            <tbody>{[...ownership, ...main].map(row)}</tbody>
          </table>
        </div>
      )}
      {d.status !== 'ACTIVE' && alt.length > 0 && (
        <p className="sf-hint">Root domain: use the A record{main.length > 1 ? 's' : ''} above, or, if your DNS host supports ALIAS / ANAME / CNAME flattening (Cloudflare does), an ALIAS from <span className="sf-mono">{d.host}</span> to <span className="sf-mono">{alt[0].value}</span> instead.</p>
      )}
      {d.status !== 'ACTIVE' && d.apex && alt.length === 0 && (
        <p className="sf-hint">Root domains can&apos;t use a CNAME. Pick <strong>ALIAS</strong>, <strong>ANAME</strong> or CNAME flattening at your DNS host, or use <span className="sf-mono">www.</span>{d.host} instead.</p>
      )}
      {d.status !== 'ACTIVE' && <p className="sf-hint">Some DNS hosts add your domain automatically. If so, enter only the first part of the name, like <span className="sf-mono">{ownership[0]?.name.replace(new RegExp(`\\.${d.host.split('.').slice(-2).join('\\.')}$`), '')}</span>.</p>}

      <div className="sf-row" style={{ flexWrap: 'wrap' }}>
        {d.status !== 'ACTIVE' && (
          <button className="sf-btn sf-btn--sm sf-btn--brand" disabled={!!busy} onClick={() => act(d.id, 'check', () => api(`/domains/${d.id}/check`, { method: 'POST' }))}>
            <Icon name="sync" size={16} />{busy === `${d.id}:check` ? 'Checking…' : failed ? 'Check again' : 'Check now'}
          </button>
        )}
        {d.dnsMode === 'stub' && d.status === 'PENDING_DNS' && (
          <button className="sf-btn sf-btn--sm sf-btn--money" disabled={!!busy} onClick={() => act(d.id, 'sim', () => api(`/domains/${d.id}/dev/simulate-dns`, { method: 'POST' }))}>
            <Icon name="spark" size={16} />Simulate DNS (dev)
          </button>
        )}
        {d.status === 'ACTIVE' && !d.isPrimary && (
          <button className="sf-btn sf-btn--sm" disabled={!!busy} onClick={() => act(d.id, 'primary', () => api(`/domains/${d.id}/primary`, { method: 'POST' }))}><Icon name="seal" size={16} />Make primary</button>
        )}
        <button
          className="sf-btn sf-btn--sm sf-btn--quiet"
          disabled={!!busy}
          onClick={() => { if (window.confirm(`Disconnect ${d.host}? The shop stays open at its StoreForge address.`)) act(d.id, 'remove', () => api(`/domains/${d.id}`, { method: 'DELETE' })); }}
        >
          <Icon name="trash" size={16} />Remove
        </button>
        <span className="sf-hint" style={{ marginLeft: 'auto' }}>Checked {ago(d.lastCheckedAt)}</span>
      </div>
    </article>
  );
}

function DomainsInner() {
  const params = useSearchParams();
  const [stores, setStores] = useState<any[] | null>(null);
  const [storeId, setStoreId] = useState<string>('');
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [host, setHost] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    api<any[]>('/stores').then((s) => {
      setStores(s);
      const want = params.get('store');
      setStoreId((cur) => cur || s.find((x) => x.slug === want || x.id === want)?.id || s[0]?.id || '');
    }).catch((e) => setAuthError(e.message));
    api<Config>('/domains/config').then(setConfig).catch(() => null);
  }, [params]);

  const refresh = useCallback(() => {
    if (!storeId) return;
    api<Domain[]>(`/domains?storeId=${storeId}`).then(setDomains).catch((e) => setError(e.message));
  }, [storeId]);
  useEffect(() => { setDomains(null); refresh(); }, [refresh]);

  const inFlight = useMemo(() => (domains ?? []).some((d) => d.status === 'PENDING_DNS' || d.status === 'ISSUING_TLS'), [domains]);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [inFlight, refresh]);

  const act = async (id: string, what: string, fn: () => Promise<unknown>) => {
    setBusy(`${id}:${what}`); setError('');
    try { await fn(); refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(''); }
  };

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setBusy('add');
    try {
      await api('/domains', { method: 'POST', body: JSON.stringify({ storeId, host }) });
      setHost('');
      refresh();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not add that domain'); } finally { setBusy(''); }
  }

  if (authError) return <SignInNeeded error={authError} />;
  const store = stores?.find((s) => s.id === storeId);
  const atLimit = (domains?.length ?? 0) >= (config?.maxPerStore ?? 3);

  return (
    <>
      <PageHead
        eyebrow="Stores · domains"
        icon="domains"
        title="Domains"
        lede="Put your shop on your own web address. Add the domain, copy two DNS records to wherever you bought it, and we take care of HTTPS."
        actions={stores && stores.length > 1 ? (
          <div className="sf-field" style={{ margin: 0 }}>
            <label className="sf-label" htmlFor="store">Store</label>
            <select id="store" className="sf-select" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
              {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        ) : null}
      />
      {config?.dnsMode === 'stub' && (
        <Callout tone="info" title="Dev mode">DNS isn&apos;t looked up for real and certificates are simulated. Use <strong>Simulate DNS</strong> to walk a domain through to live.</Callout>
      )}
      {stores?.length === 0 && <Callout tone="warn">Open a store first, then connect a domain to it.</Callout>}
      {error && <Callout tone="bad">{error}</Callout>}

      <div className="grid-2 domains-grid">
        <div className="sf-stack">
          {domains === null && storeId && <p className="sf-muted">Loading…</p>}
          {domains?.map((d) => <DomainCard key={d.id} d={d} onChange={refresh} busy={busy} act={act} />)}
          {domains?.length === 0 && (
            <div className="sf-card empty">
              <span className="empty__icon" aria-hidden="true"><Icon name="domains" size={64} /></span>
              <div><h3>No custom domain yet</h3><p className="sf-muted">{store ? <>{store.name} is open at <span className="sf-mono">{store.slug}.{process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local'}</span>. </> : null}Add your own address on the right.</p></div>
            </div>
          )}
        </div>
        <div className="sf-stack">
          <form className="sf-card sf-card--ticket" onSubmit={add}>
            <h2>Connect a domain</h2>
            <div className="sf-field">
              <label className="sf-label" htmlFor="host">Domain</label>
              <input id="host" className="sf-input sf-mono" value={host} onChange={(e) => setHost(e.target.value)} placeholder="shop.yourbrand.com" required disabled={!storeId || atLimit} autoComplete="off" spellCheck={false} />
              <span className="sf-hint">We recommend a subdomain like <span className="sf-mono">shop.</span> or <span className="sf-mono">www.</span>. Root domains work too.</span>
            </div>
            <button className="sf-btn sf-btn--brand" type="submit" disabled={!storeId || atLimit || busy === 'add'}><Icon name="add" size={18} />{busy === 'add' ? 'Adding…' : 'Add domain'}</button>
            {atLimit && <p className="sf-hint">Up to {config?.maxPerStore ?? 3} domains per store.</p>}
          </form>
          <div className="sf-card sf-card--sunken">
            <h3>How it works</h3>
            <ol className="howto">
              <li><strong>TXT record</strong> proves the domain is yours.</li>
              <li><strong>CNAME</strong> (or A for a root domain) sends visitors to your shop{config ? <> at <span className="sf-mono">{config.cnameTarget}</span></> : null}.</li>
              <li>We issue an HTTPS certificate automatically, usually within a minute of DNS checking out.</li>
            </ol>
            <p className="sf-hint">DNS changes can take a few minutes to show up. We keep checking for {config?.dnsTimeoutHours ?? 72} hours.</p>
          </div>
        </div>
      </div>
    </>
  );
}

export default function DomainsPage() {
  return <Suspense fallback={<p className="sf-muted">Loading…</p>}><DomainsInner /></Suspense>;
}
