// Phase 1 slice 2: custom domains — verification state machine, AC timing, host routing, TLS ask.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@storeforge/db';
import { DomainsService, nextDnsCheckDelayMs } from '../src/domains/domains.service';
import { DomainsController, StorefrontHostController } from '../src/domains/domains.controller';
import { normalizeHost, validateCustomHost, isApex, txtValue } from '../src/domains/host';
import { setDnsForTests, type DnsLookup, type DnsSnapshot } from '../src/domains/dns';
import { setTlsForTests, StubTls, type TlsProvider, type TlsState } from '../src/domains/tls';
import { makeOrg, uid } from './helpers';

const svc = new DomainsService();
const authStub = { requireAccountId: async (id: string) => id } as any;
const ctrl = new DomainsController(svc, authStub);
const hostCtrl = new StorefrontHostController(svc);

/** Programmable DNS: records[host] = snapshot */
class FakeDns implements DnsLookup {
  readonly mode: 'live' | 'stub';
  records = new Map<string, DnsSnapshot>();
  targetA: string[] = [];
  constructor(mode: 'live' | 'stub' = 'live') { this.mode = mode; }
  async lookup(host: string) { return this.records.get(host) ?? { txt: [], cname: [], a: [] }; }
  async resolveA() { return this.targetA; }
}
class FakeTls implements TlsProvider {
  readonly kind = 'caddy' as const;
  next: TlsState = { state: 'pending' };
  requests: string[] = [];
  removed: string[] = [];
  async request(h: string) { this.requests.push(h); return this.next; }
  async status() { return this.next; }
  async remove(h: string) { this.removed.push(h); }
}

let dns: FakeDns;
let tls: FakeTls;
const TARGET = 'stores.storeforge.local';

before(() => { process.env.DOMAIN_CNAME_TARGET = TARGET; process.env.DOMAIN_APEX_IPS = '203.0.113.10'; });
beforeEach(() => { dns = new FakeDns(); tls = new FakeTls(); setDnsForTests(dns); setTlsForTests(tls); });
after(async () => { setDnsForTests(null); setTlsForTests(null); await prisma.$disconnect(); });

async function storeFor(orgId?: string) {
  const org = orgId ? { id: orgId } : await makeOrg();
  const store = await prisma.store.create({ data: { organizationId: org.id, name: 'Juniper Goods', slug: uid('j').toLowerCase().replace(/_/g, '-') } });
  return { org, store };
}
const host = () => `${uid('shop').toLowerCase().replace(/_/g, '')}.example.com`;
const goodDns = (h: string, token: string): DnsSnapshot => ({ txt: [txtValue(token)], cname: [TARGET], a: [] });

// ---------- host parsing ----------
test('host: normalize + validate', () => {
  assert.equal(normalizeHost('HTTPS://Shop.Example.COM:443/path?x#y'), 'shop.example.com');
  assert.equal(normalizeHost('shop.example.com.'), 'shop.example.com');
  assert.equal(normalizeHost('bücher.example'), 'xn--bcher-kva.example');
  assert.equal(validateCustomHost(' Shop.Juniper-Goods.com '), 'shop.juniper-goods.com');
  for (const bad of ['', 'localhost', '10.0.0.1', 'shop', 'demo.storeforge.local', 'storeforge.local', 'a..b.com', '-x.com', 'x.c0m', 'shop.test']) {
    assert.throws(() => validateCustomHost(bad), undefined, bad);
  }
  assert.equal(isApex('example.com'), true);
  assert.equal(isApex('shop.example.com'), false);
  assert.equal(isApex('example.co.uk'), true);
  assert.equal(nextDnsCheckDelayMs(0), 30_000);
  assert.equal(nextDnsCheckDelayMs(30 * 60_000), 120_000);
  assert.equal(nextDnsCheckDelayMs(5 * 3600_000), 900_000);
});

// ---------- verification states ----------
test('domain: PENDING_DNS → (TXT only) still pending → (TXT + CNAME) ISSUING_TLS → ACTIVE; store link updated', async () => {
  const { org, store } = await storeFor();
  const h = host();
  const d = await svc.add(org.id, store.id, h);
  assert.equal(d.status, 'PENDING_DNS');
  assert.equal(d.isPrimary, true);
  assert.deepEqual(d.records.map((r) => [r.type, r.name, r.value]), [
    ['TXT', `_storeforge.${h}`, `storeforge-verify=${d.verificationToken}`],
    ['CNAME', h, TARGET],
  ]);

  const t0 = new Date();
  let row = await svc.check(d.id, t0);
  assert.equal(row.status, 'PENDING_DNS');
  assert.match(row.lastError!, /TXT and CNAME records/);
  assert.equal(row.nextCheckAt.getTime() - t0.getTime(), 30_000);

  dns.records.set(h, { txt: ['storeforge-verify=wrong'], cname: [TARGET], a: [] });
  row = await svc.check(d.id, new Date(t0.getTime() + 30_000));
  assert.equal(row.status, 'PENDING_DNS', 'wrong token is not ownership');
  assert.match(row.lastError!, /TXT record/);

  dns.records.set(h, { txt: [txtValue(d.verificationToken)], cname: [], a: [] });
  row = await svc.check(d.id, new Date(t0.getTime() + 60_000));
  assert.equal(row.status, 'PENDING_DNS');
  assert.match(row.lastError!, /CNAME record/);
  assert.deepEqual((row.lastResult as any).txt, true);

  dns.records.set(h, goodDns(h, d.verificationToken));
  const tVerify = new Date(t0.getTime() + 90_000);
  row = await svc.check(d.id, tVerify);
  assert.equal(row.status, 'ISSUING_TLS');
  assert.equal(row.verifiedAt!.getTime(), tVerify.getTime());
  assert.deepEqual(tls.requests, [h]);
  assert.equal((await hostCtrl.resolve(h).catch(() => null)), null, 'not served before TLS is ready');
  assert.equal(await svc.tlsAllowed(h), true, 'Caddy may issue once DNS is verified');

  tls.next = { state: 'issued' };
  row = await svc.check(d.id, new Date(tVerify.getTime() + 15_000));
  assert.equal(row.status, 'ACTIVE');
  assert.equal(svc.view(row).tlsSeconds, 15);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).customDomain, h);
  const resolved = await hostCtrl.resolve(`${h.toUpperCase()}:443`);
  assert.equal(resolved.slug, store.slug);
  assert.equal(resolved.kind, 'custom');
});

test('domain AC: records added 3 min after the domain → ACTIVE with TLS well under 10 min (sweeper cadence)', async () => {
  setTlsForTests(new StubTls(20_000)); // stub CA: issues 20 s after the request
  const { org, store } = await storeFor();
  const h = host();
  const d = await svc.add(org.id, store.id, h);
  const start = (await prisma.domain.findUniqueOrThrow({ where: { id: d.id } })).createdAt.getTime();
  let activeAt: number | null = null;
  for (let t = start; t <= start + 15 * 60_000; t += 15_000) {
    if (t >= start + 3 * 60_000) dns.records.set(h, goodDns(h, d.verificationToken));
    await svc.sweepDue(new Date(t));
    const row = await prisma.domain.findUniqueOrThrow({ where: { id: d.id } });
    if (row.status === 'ACTIVE') { activeAt = t; break; }
  }
  assert.ok(activeAt, 'became ACTIVE');
  const fromRecords = (activeAt! - (start + 3 * 60_000)) / 1000;
  assert.ok(fromRecords < 10 * 60, `ACTIVE ${fromRecords}s after records appeared`);
  assert.ok(fromRecords <= 75, `dense polling keeps it near a minute (got ${fromRecords}s)`);
});

test('domain: apex uses A record (or ALIAS flattening to the target)', async () => {
  const { org, store } = await storeFor();
  const apex = `${uid('apex').toLowerCase().replace(/_/g, '')}.com`;
  const d = await svc.add(org.id, store.id, apex);
  assert.ok(d.apex);
  assert.deepEqual(d.records.filter((r) => r.purpose === 'routing').map((r) => [r.type, r.value, !!r.alternative]), [['A', '203.0.113.10', false], ['ALIAS', TARGET, true]]);
  dns.records.set(apex, { txt: [txtValue(d.verificationToken)], cname: [], a: ['203.0.113.10'] });
  assert.equal((await svc.check(d.id)).status, 'ISSUING_TLS');

  const apex2 = `${uid('alias').toLowerCase().replace(/_/g, '')}.com`;
  const d2 = await svc.add(org.id, store.id, apex2);
  dns.targetA = ['198.51.100.7'];
  dns.records.set(apex2, { txt: [txtValue(d2.verificationToken)], cname: [], a: ['198.51.100.7'] });
  assert.equal((await svc.check(d2.id)).status, 'ISSUING_TLS', 'ALIAS/ANAME flattened to the target');
});

test('domain: no DNS within 72 h → FAILED; Check again restarts the window', async () => {
  const { org, store } = await storeFor();
  const d = await svc.add(org.id, store.id, host());
  await prisma.domain.update({ where: { id: d.id }, data: { windowStartedAt: new Date(Date.now() - 73 * 3600_000) } });
  const row = await svc.check(d.id);
  assert.equal(row.status, 'FAILED');
  assert.match(row.lastError!, /after 72 hours/);
  assert.equal((await svc.sweepDue(new Date(Date.now() + 86400_000))).checked >= 0, true);
  assert.equal((await prisma.domain.findUniqueOrThrow({ where: { id: d.id } })).status, 'FAILED', 'sweeper leaves FAILED alone');
  const again = await svc.checkNow(org.id, d.id);
  assert.equal(again.status, 'PENDING_DNS');
  assert.equal(again.lastError?.includes('72 hours'), false);
});

test('domain: TLS failure and TLS timeout → FAILED with a CAA hint', async () => {
  const { org, store } = await storeFor();
  const h = host();
  const d = await svc.add(org.id, store.id, h);
  dns.records.set(h, goodDns(h, d.verificationToken));
  tls.next = { state: 'failed', detail: 'CAA record forbids issuance' };
  const row = await svc.check(d.id);
  assert.equal(row.status, 'FAILED');
  assert.match(row.lastError!, /CAA/);

  const h2 = host();
  const d2 = await svc.add(org.id, store.id, h2);
  dns.records.set(h2, goodDns(h2, d2.verificationToken));
  tls.next = { state: 'pending' };
  const t0 = new Date();
  assert.equal((await svc.check(d2.id, t0)).status, 'ISSUING_TLS');
  const late = await svc.check(d2.id, new Date(t0.getTime() + 31 * 60_000));
  assert.equal(late.status, 'FAILED');
  assert.match(late.lastError!, /Certificate wasn't issued/);
});

test('domain: ACTIVE domain that loses its CNAME stays live but warns (no flapping)', async () => {
  const { org, store } = await storeFor();
  const h = host();
  const d = await svc.add(org.id, store.id, h);
  dns.records.set(h, goodDns(h, d.verificationToken));
  tls.next = { state: 'issued' };
  assert.equal((await svc.check(d.id)).status, 'ACTIVE');
  dns.records.set(h, { txt: [], cname: [], a: [] });
  const row = await svc.check(d.id);
  assert.equal(row.status, 'ACTIVE');
  assert.match(row.lastError!, /no longer points/);
});

test('domain (dev stub DNS): Simulate DNS walks it to ACTIVE; refused in live DNS mode', async () => {
  setDnsForTests(new FakeDns('live'));
  const { org, store } = await storeFor();
  const d = await svc.add(org.id, store.id, host());
  await assert.rejects(() => svc.simulateDns(org.id, d.id), /only available in dev/);
  setDnsForTests(null); // real StubDns (DOMAIN_DNS_MODE=stub in tests)
  setTlsForTests(new StubTls(0));
  const pending = await svc.checkNow(org.id, d.id);
  assert.equal(pending.status, 'PENDING_DNS', 'stub DNS has no records until simulated');
  const v = await ctrl.simulate({ id: org.id }, d.id);
  assert.equal(v.status, 'ACTIVE');
});

test('domain: uniqueness, per-store limit, primary switching, ownership, removal', async () => {
  const { org, store } = await storeFor();
  const other = await storeFor();
  const h = host();
  const d = await svc.add(org.id, store.id, h);
  assert.equal((await svc.add(org.id, store.id, h.toUpperCase())).id, d.id, 'same store → same row');
  await assert.rejects(() => svc.add(other.org.id, other.store.id, h), /already connected/);
  await assert.rejects(() => svc.add(other.org.id, store.id, host()), /Store not found/);
  await assert.rejects(() => svc.checkNow(other.org.id, d.id), /Domain not found/);
  await assert.rejects(() => svc.remove(other.org.id, d.id), /Domain not found/);
  const d2 = await svc.add(org.id, store.id, host());
  await svc.add(org.id, store.id, host());
  await assert.rejects(() => svc.add(org.id, store.id, host()), /up to 3/);
  assert.equal(d2.isPrimary, false);
  // both ACTIVE, then switch primary
  for (const x of [d, d2]) {
    const row = await prisma.domain.findUniqueOrThrow({ where: { id: x.id } });
    dns.records.set(row.host, goodDns(row.host, row.verificationToken));
  }
  tls.next = { state: 'issued' };
  await svc.check(d.id);
  await svc.check(d2.id);
  const list = await svc.makePrimary(org.id, d2.id);
  assert.equal(list.find((x) => x.isPrimary)!.id, d2.id);
  const d2host = (await prisma.domain.findUniqueOrThrow({ where: { id: d2.id } })).host;
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).customDomain, d2host);
  // secondary redirects to primary
  const sec = await svc.resolveHost(h);
  assert.equal(sec?.redirectTo, d2host);
  await ctrl.remove({ id: org.id }, d2.id);
  assert.deepEqual(tls.removed, [d2host]);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).customDomain, h, 'next ACTIVE domain promoted');
});

test('sweeper: concurrent sweeps check each due domain once', async () => {
  const { org, store } = await storeFor();
  const d = await svc.add(org.id, store.id, host());
  const now = new Date(Date.now() + 1000);
  await Promise.all([svc.sweepDue(now), svc.sweepDue(now), svc.sweepDue(now)]);
  assert.equal((await prisma.domain.findUniqueOrThrow({ where: { id: d.id } })).checkCount, 1);
});

// ---------- host-based routing ----------
test('routing: subdomain, custom, www twin, unverified, deleted, unknown', async () => {
  const { org, store } = await storeFor();
  assert.equal((await svc.resolveHost(`${store.slug}.storeforge.local:3000`))?.slug, store.slug);
  assert.equal((await svc.resolveHost(`${store.slug}.storeforge.local`))?.kind, 'subdomain');
  assert.equal(await svc.resolveHost('admin.storeforge.local'), null);
  assert.equal(await svc.resolveHost('nope.storeforge.local'), null);
  assert.equal(await svc.resolveHost('a.b.storeforge.local'), null);

  const h = `www.${uid('brand').toLowerCase().replace(/_/g, '')}.com`;
  const d = await svc.add(org.id, store.id, h);
  assert.equal(await svc.resolveHost(h), null, 'PENDING_DNS is never served');
  dns.records.set(h, goodDns(h, d.verificationToken));
  tls.next = { state: 'issued' };
  await svc.check(d.id);
  assert.equal((await svc.resolveHost(h))?.slug, store.slug);
  const bare = await svc.resolveHost(h.slice(4));
  assert.equal(bare?.redirectTo, h, 'bare apex redirects to the registered www host');
  assert.equal((await svc.resolveHost(`${store.slug}.storeforge.local`))?.redirectTo, h, 'platform subdomain → custom domain');
  await assert.rejects(() => hostCtrl.resolve('unknown-shop.example.org'), /No store on this domain/);
  await assert.rejects(() => hostCtrl.resolve(undefined), /No store/);

  await prisma.store.update({ where: { id: store.id }, data: { deletedAt: new Date(), status: 'SOFT_DELETED' } });
  assert.equal(await svc.resolveHost(h), null, 'deleted store not served');
  assert.equal(await svc.tlsAllowed(h), false, 'and no new certificates');
});

test('tls-ask (Caddy on_demand): only verified hosts, optional token', async () => {
  const { org, store } = await storeFor();
  const h = host();
  const d = await svc.add(org.id, store.id, h);
  await assert.rejects(() => ctrl.tlsAsk(h), /Not Found/);
  dns.records.set(h, goodDns(h, d.verificationToken));
  await svc.check(d.id);
  assert.deepEqual(await ctrl.tlsAsk(h), { ok: true });
  process.env.DOMAIN_TLS_ASK_TOKEN = 'ask-secret';
  await assert.rejects(() => ctrl.tlsAsk(h, 'wrong'), /Forbidden/);
  assert.deepEqual(await ctrl.tlsAsk(h, 'ask-secret'), { ok: true });
  delete process.env.DOMAIN_TLS_ASK_TOKEN;
  await assert.rejects(() => ctrl.tlsAsk('random.example.net'), /Not Found/);
});

test('urls: checkout return + email links use the primary ACTIVE domain', async () => {
  const { org, store } = await storeFor();
  assert.deepEqual(await DomainsService.storeUrls(store), { origin: `http://${store.slug}.storeforge.local:3000`, shopPath: '/', custom: false });
  const h = host();
  const d = await svc.add(org.id, store.id, h);
  dns.records.set(h, goodDns(h, d.verificationToken));
  tls.next = { state: 'issued' };
  await svc.check(d.id);
  const s2 = await prisma.store.findUniqueOrThrow({ where: { id: store.id } });
  assert.deepEqual(await DomainsService.storeUrls(s2), { origin: `https://${h}`, shopPath: '/', custom: true });
});
