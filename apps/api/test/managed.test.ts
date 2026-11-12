// Phase 1 slice 4: managed Boost (Meta managed, Google Ads PMax, TikTok) against the stub platform clients.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@storeforge/db';
import { setPaymentProviderForTests } from '../src/payments';
import { SuppliersService } from '../src/suppliers/suppliers.service';
import { FulfillmentService } from '../src/fulfillment/fulfillment.service';
import { OrdersService } from '../src/orders/orders.service';
import { EmailService } from '../src/email/email.service';
import { setEmailTransportForTests } from '../src/email/transport';
import { AdWalletService } from '../src/ads/wallet.service';
import { BoostService } from '../src/ads/boost.service';
import { ConversionsService } from '../src/ads/conversions.service';
import { creditTopUp } from '../src/ads/ledger';
import { ManagedBoostService } from '../src/ads/managed/managed.service';
import { GoogleChannel, TikTokChannel, MetaManagedChannel, setManagedChannelForTests } from '../src/ads/managed/adapters';
import { StubGoogle, GoogleAdsError } from '../src/ads/managed/google';
import { StubTikTok } from '../src/ads/managed/tiktok';
import { StubMetaGraph } from '../src/ads/managed/metam';
import { splitBudget, minTotalFor, LADDER } from '../src/ads/managed/config';
import type { Channel } from '../src/ads/managed/types';
import { makeOrg, makeStoreWithProduct, checkoutInput, uid } from './helpers';

const H = 3_600_000;
const wallet = new AdWalletService();
const boost = new BoostService(wallet);
const managed = new ManagedBoostService(wallet, boost);
const emails = new EmailService();
const orders = new OrdersService(new FulfillmentService(new SuppliersService(), emails), emails);
const capi: ConversionsService = (orders as any).conversions;
managed.listen(); // fuel 'empty' / 'added' → pause / resume every channel (the scheduler does this in the app)
let g: StubGoogle;
let t: StubTikTok;
let m: StubMetaGraph;
let offset = 0;
const at = () => new Date(Date.now() + offset);

beforeEach(() => {
  offset = 0;
  g = new StubGoogle(null);
  t = new StubTikTok(null);
  m = new StubMetaGraph(null);
  const seq = 1_000_000 + Math.floor(Math.random() * 1e9);
  for (const s of [g, t, m]) { s.sim.now = () => Date.now() + offset; s.sim.state.seq = seq; }
  setManagedChannelForTests('GOOGLE', new GoogleChannel(g));
  setManagedChannelForTests('TIKTOK', new TikTokChannel(t));
  setManagedChannelForTests('META', new MetaManagedChannel(m));
  setPaymentProviderForTests(null);
  setEmailTransportForTests({ kind: 'outbox', send: async () => ({ providerMessageId: 'x' }) } as any);
});
after(async () => {
  await managed.idle(); await capi.idle(); await emails.idle();
  for (const c of ['GOOGLE', 'TIKTOK', 'META'] as Channel[]) setManagedChannelForTests(c, null);
  setEmailTransportForTests(null);
  await prisma.$disconnect();
});

async function fund(orgId: string, cents: number) {
  const w = await wallet.walletFor(orgId);
  await creditTopUp({ paymentIntentId: uid('pi'), amountCents: cents, walletId: w.id, provider: 'stub', source: 'manual' });
  return w;
}
async function setup(o: { channels?: Channel[]; fuel?: number; title?: string } = {}) {
  const org = await makeOrg();
  const { store, sp, product } = await makeStoreWithProduct(org.id, 4650);
  await prisma.product.update({ where: { id: product.id }, data: { etaDaysMin: 6, etaDaysMax: 10, category: 'Home & Garden', ...(o.title ? { title: o.title } : {}) } });
  if (o.fuel) await fund(org.id, o.fuel);
  ORG = org.id;
  const ov = await managed.enable(org.id, store.id, o.channels ?? ['META', 'GOOGLE', 'TIKTOK']);
  return { org, store, sp, ov };
}
async function launched(o: { channels?: Channel[]; fuel?: number; budget?: number } = {}) {
  const s = await setup({ fuel: o.fuel ?? 20_000, channels: o.channels });
  let v: any = await managed.createDraft(s.org.id, s.store.id, { storeProductId: s.sp.id, requestId: uid('req') });
  if (o.budget) v = await managed.updateDraft(s.org.id, v.id, { dailyBudgetCents: o.budget });
  await managed.launch(s.org.id, v.id);
  await managed.idle();
  const group: any = await managed.groupView(v.id);
  return { ...s, group };
}
const walletOf = async (orgId: string) => prisma.adWallet.findUniqueOrThrow({ where: { organizationId: orgId } });
let ORG = '';
const sync = (now = at()) => managed.syncAll(now, 0, ORG);

// ---------- config ----------
test('budget split: 40/40/20 with per-channel minimums, totals exact', () => {
  const s3 = splitBudget(3000, ['META', 'GOOGLE', 'TIKTOK']);
  assert.equal(s3.META + s3.GOOGLE + s3.TIKTOK, 3000);
  assert.ok(s3.TIKTOK >= 2000 && s3.META >= 100 && s3.GOOGLE >= 100 && s3.META === s3.GOOGLE, JSON.stringify(s3));
  const s = splitBudget(10_000, ['META', 'GOOGLE', 'TIKTOK']);
  assert.equal(s.META + s.GOOGLE + s.TIKTOK, 10_000);
  assert.ok(s.TIKTOK >= 2000);
  const s2 = splitBudget(1001, ['META', 'GOOGLE']);
  assert.ok(s2.META + s2.GOOGLE === 1001 && Math.abs(s2.META - s2.GOOGLE) <= 1);
  assert.equal(minTotalFor(['TIKTOK']), 2000);
  assert.equal(minTotalFor(['META']), 1000);
});

// ---------- provisioning ----------
test('provision: one account per store per channel, idempotent, resumes after a crash without duplicates', async () => {
  const org = await makeOrg();
  const { store } = await makeStoreWithProduct(org.id, 4650);
  // Google creates the client account, then the response is lost (timeout after commit)
  g.failAfterCommit.createCustomerClient = new GoogleAdsError('Deadline exceeded', 504, 'DEADLINE_EXCEEDED');
  await managed.enable(org.id, store.id, ['GOOGLE', 'TIKTOK', 'META']);
  const accts = await prisma.adAccount.findMany({ where: { storeId: store.id, mode: 'MANAGED' } });
  assert.equal(accts.length, 3);
  const goog = accts.find((a) => a.channel === 'GOOGLE')!;
  assert.equal(goog.provisionStatus, 'provisioning', 'transient failure stays retryable');
  assert.match(goog.lastError ?? '', /Deadline/);
  assert.deepEqual(accts.filter((a) => a.channel !== 'GOOGLE').map((a) => a.provisionStatus), ['ready', 'ready']);
  await managed.provisionPending(new Date(Date.now() + 5 * 60_000));
  const ready = await prisma.adAccount.findUniqueOrThrow({ where: { id: goog.id } });
  assert.equal(ready.provisionStatus, 'ready');
  assert.ok(ready.merchantCenterId && ready.dataSourceId && ready.conversionActionId && ready.conversionTag?.startsWith('AW-'), 'Merchant Center + conversion action wired');
  const clients = Object.values(g.sim.state.accounts).filter((a) => a.name.includes(goog.provisionKey!));
  assert.equal(clients.length, 1, 'found by its [sf:key] tag instead of a second client account');
  // re-enable (also concurrent double click) is a no-op
  await Promise.all([managed.enable(org.id, store.id, ['GOOGLE', 'TIKTOK', 'META']), managed.enable(org.id, store.id, ['GOOGLE'])]);
  assert.equal(await prisma.adAccount.count({ where: { storeId: store.id, mode: 'MANAGED' } }), 3);
  assert.equal(Object.values(g.sim.state.accounts).filter((a) => a.name.includes(goog.provisionKey!)).length, 1);
  assert.equal(Object.keys(t.sim.state.accounts).length, 1);
  assert.equal(Object.keys(m.sim.state.accounts).length, 1);
  // another org can't enable on this store
  const other = await makeOrg();
  await assert.rejects(() => managed.enable(other.id, store.id, ['META']), /Store not found/);
});

test('provision: a permanent platform error marks the account failed (no retry loop)', async () => {
  const org = await makeOrg();
  const { store } = await makeStoreWithProduct(org.id, 4650);
  g.failNext.createCustomerClient = new GoogleAdsError('Developer token is only approved for test accounts', 403, 'PERMISSION_DENIED', [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'x' }]);
  await managed.enable(org.id, store.id, ['GOOGLE']);
  const a = await prisma.adAccount.findFirstOrThrow({ where: { storeId: store.id, channel: 'GOOGLE' } });
  assert.equal(a.provisionStatus, 'failed');
  assert.deepEqual(await managed.provisionPending(new Date(Date.now() + 600_000)), []);
});

// ---------- draft + policy ----------
test('draft: 4 copy variants, 4 crops, policy scan; idempotent on requestId', async () => {
  const s = await setup({ fuel: 10_000 });
  const req = uid('req');
  const [a, b]: any[] = await Promise.all([managed.createDraft(s.org.id, s.store.id, { storeProductId: s.sp.id, requestId: req }), managed.createDraft(s.org.id, s.store.id, { storeProductId: s.sp.id, requestId: req })]);
  assert.equal(a.id, b.id);
  assert.equal(await prisma.boostGroup.count({ where: { storeId: s.store.id } }), 1);
  assert.equal(a.variants.length, 4);
  assert.deepEqual(a.assets.map((x: any) => x.ratio), ['1:1', '4:5', '9:16', '1.91:1']);
  assert.ok(a.assets.every((x: any) => /\/api\/managed\/render\/.+\/(1x1|4x5|9x16|191x100)\.png/.test(x.url)));
  for (const v of a.variants) { assert.ok(v.headline.length <= 40 && v.body.length <= 125); assert.ok(v.headlines.every((h: string) => h.length <= 30)); }
  assert.deepEqual(a.channels, ['META', 'GOOGLE', 'TIKTOK']);
  assert.equal(a.feePct, 15);
});

test('policy: a blocked claim stops launch with the findings; fixing the text unblocks it', async () => {
  const s = await setup({ fuel: 10_000 });
  const v: any = await managed.createDraft(s.org.id, s.store.id, { storeProductId: s.sp.id, requestId: uid('req') });
  const bad: any = await managed.updateDraft(s.org.id, v.id, { headline: 'Miracle lamp cures anxiety', body: 'Guaranteed results in 1 night!!' });
  assert.equal(bad.policyResult, 'block');
  await assert.rejects(() => managed.launch(s.org.id, v.id), (e: any) => { assert.match(e.message, /Fix the flagged text/); assert.ok(e.response.findings.some((f: any) => f.rule === 'claims.miracle')); return true; });
  assert.equal(await prisma.adCampaign.count({ where: { groupId: v.id } }), 0);
  const sup = managed.policy.scan({ title: 'Lamp', category: null, texts: [{ field: 'body', text: 'The #1 lamp in town' }], landing: { priceCents: 100, etaDaysMin: 1, etaDaysMax: 5, https: true } });
  assert.ok(sup.rules.includes('claims.superlative'), '"#1" is caught');
  const ok: any = await managed.updateDraft(s.org.id, v.id, { headline: 'Warm light for small rooms', body: 'Dimmable lamp, ships in 6-10 days.' });
  assert.notEqual(ok.policyResult, 'block');
  // a prohibited product category blocks every variant
  const s2 = await setup({ fuel: 10_000, title: 'CBD vape kit' });
  const v2: any = await managed.createDraft(s2.org.id, s2.store.id, { storeProductId: s2.sp.id, requestId: uid('req') });
  assert.equal(v2.policyResult, 'block');
  assert.ok(v2.variants.every((x: any) => x.policy.result === 'block'));
});

// ---------- launch ----------
test('launch: needs a day of budget + 15% in fuel; pick → live on 3 channels in < 3 min; ceilings set first', async () => {
  const s = await setup({ fuel: 3000 });
  const v: any = await managed.createDraft(s.org.id, s.store.id, { storeProductId: s.sp.id, requestId: uid('req') });
  assert.equal(v.dailyBudgetCents, 3000);
  await assert.rejects(() => managed.launch(s.org.id, v.id), /launching needs one day of budget \+ 15% fee \(\$34\.50\)/);
  await fund(s.org.id, 500);
  const r: any = await managed.launch(s.org.id, v.id);
  assert.equal(r.status, 'LAUNCHING');
  await managed.idle();
  const live: any = await managed.groupView(v.id);
  assert.equal(live.status, 'LIVE');
  assert.ok(live.launchMs >= 0 && live.launchMs < 180_000, `launch took ${live.launchMs} ms`);
  assert.deepEqual(live.campaigns.map((c: any) => [c.channel, c.stage]).sort(), [['GOOGLE', 'REVIEW'], ['META', 'REVIEW'], ['TIKTOK', 'REVIEW']]);
  const accts = await prisma.adAccount.findMany({ where: { storeId: s.store.id, mode: 'MANAGED' } });
  assert.ok(accts.every((a) => a.capMinor !== null && a.capMinor > 0 && a.capAppliedAt), 'every account has a ceiling');
  // Ceiling targets sum to at most what the fuel can pay for (spend + 15%). Meta's applied spend_cap has a
  // platform minimum (META_MIN_SPEND_CAP_CENTS, $100), so for Meta the low-fuel pause is the backstop.
  let total = 0;
  for (const a of accts) {
    const tg = await managed.ceilingTarget(a.id);
    total += tg.capMinor;
    assert.equal(a.capMinor, a.channel === 'META' ? Math.max(tg.capMinor, 10_000) : tg.capMinor);
  }
  assert.ok(total <= Math.floor(3500 / 1.15), `ceilings ${total} ≤ fuel / 1.15`);
  // Google: one PMax campaign, listing group limited to the offer, enhanced conversions on
  const camps = Object.values(g.sim.state.campaigns);
  assert.equal(camps.length, 1);
  // double click / second request = no-op
  await managed.launch(s.org.id, v.id);
  await managed.idle();
  assert.equal(await prisma.adCampaign.count({ where: { groupId: v.id } }), 3);
  assert.equal(Object.values(t.sim.state.campaigns).length, 1);
  assert.equal(Object.values(m.sim.state.campaigns).length, 1);
  const n = await prisma.notification.findMany({ where: { organizationId: s.org.id, kind: 'boost_live' } });
  assert.equal(n.length, 1);
});

test('launch: a lost response mid-launch resumes on the next run without duplicate platform objects', async () => {
  const s = await setup({ fuel: 20_000 });
  const v: any = await managed.createDraft(s.org.id, s.store.id, { storeProductId: s.sp.id, requestId: uid('req') });
  g.failAfterCommit.mutate = new GoogleAdsError('Internal error', 500, 'INTERNAL');
  t.failNext['/adgroup/create/'] = Object.assign(new Error('socket hang up'));
  await managed.launch(s.org.id, v.id);
  await managed.idle();
  let view: any = await managed.groupView(v.id);
  assert.equal(view.status, 'LAUNCHING');
  assert.equal(view.campaigns.find((c: any) => c.channel === 'META').stage, 'REVIEW', 'healthy channel not held back');
  await managed.resumeLaunches(new Date(Date.now() + 60_000));
  view = await managed.groupView(v.id);
  assert.equal(view.status, 'LIVE');
  assert.equal(Object.values(g.sim.state.campaigns).length, 1, 'Google PMax found by its [sf:] tag');
  assert.equal(Object.values(t.sim.state.campaigns).length, 1, 'TikTok ad group created once');
  assert.ok(view.campaigns.every((c: any) => c.externalId));
});

test('launch: ceilings are sized while campaigns are still being created, and current when the group reports LIVE', async () => {
  const s = await setup({ fuel: 20_000 });
  const v: any = await managed.createDraft(s.org.id, s.store.id, { storeProductId: s.sp.id, requestId: uid('req') });
  const run = managed.runLaunch.bind(managed);
  let during: number[] = [];
  (managed as any).runLaunch = async (id: string) => { during = (await prisma.adAccount.findMany({ where: { storeId: s.store.id, mode: 'MANAGED' } })).map((a) => a.capMinor ?? 0); return run(id); };
  try { await managed.launch(s.org.id, v.id); await managed.idle(); } finally { (managed as any).runLaunch = run; }
  assert.ok(during.length === 3 && during.every((c) => c > 0), `ceilings before the platform objects exist: ${during}`);
  const view: any = await managed.groupView(v.id);
  assert.equal(view.status, 'LIVE');
  for (const a of await prisma.adAccount.findMany({ where: { storeId: s.store.id, mode: 'MANAGED' } })) {
    const tg = await managed.ceilingTarget(a.id);
    assert.equal(a.capMinor, a.channel === 'META' ? Math.max(tg.capMinor, 10_000) : tg.capMinor);
  }
});

test('launch: a channel that rejects the ad fails alone; the others go live', async () => {
  const s = await setup({ fuel: 20_000 });
  const v: any = await managed.createDraft(s.org.id, s.store.id, { storeProductId: s.sp.id, requestId: uid('req') });
  t.failNext['/ad/create/'] = new (await import('../src/ads/managed/tiktok')).TikTokError('Ad text violates advertising policy', 40002, 'rid');
  await managed.launch(s.org.id, v.id);
  await managed.idle();
  const view: any = await managed.groupView(v.id);
  assert.equal(view.status, 'LIVE');
  const tk = view.campaigns.find((c: any) => c.channel === 'TIKTOK');
  assert.equal(tk.stage, 'REJECTED');
  assert.ok(view.policy.some((p: any) => p.source === 'tiktok'));
});

// ---------- charges ----------
test('sync: platform spend charged to fuel as spend + 15%, hourly, idempotent', async () => {
  const s = await launched({ fuel: 20_000 });
  const before = await walletOf(s.org.id);
  offset = 20 * H;
  await sync();
  await sync(); // replay: deltas only
  const charges = await prisma.adChargeDay.findMany({ where: { campaign: { groupId: s.group.id } } });
  assert.ok(charges.length >= 3, 'every channel delivered');
  let spend = 0;
  let fee = 0;
  for (const c of charges) {
    assert.equal(c.feeOwedCents, Math.round(c.spendOwedCents * 0.15), `fee 15% of ${c.spendOwedCents}`);
    spend += c.spendOwedCents; fee += c.feeOwedCents;
  }
  const w = await walletOf(s.org.id);
  assert.equal(before.balanceCents + before.bonusCents - (w.balanceCents + w.bonusCents), spend + fee);
  // platform spend == what we charged (nothing the platform spent is uncollected)
  const platform = g.sim.accountSpend(Object.keys(g.sim.state.accounts)[0]) + t.sim.accountSpend(Object.keys(t.sim.state.accounts)[0]) + m.sim.accountSpend(Object.keys(m.sim.state.accounts)[0]);
  assert.equal(platform, spend);
  const view: any = await managed.groupView(s.group.id);
  assert.equal(view.totals.spendCents, spend);
  assert.equal(view.totals.feeCents, fee);
  assert.equal(view.totals.trueProfitCents, view.totals.revenueCents - view.totals.cogsCents - view.totals.shippingCents - spend - fee);
  if (view.totals.purchases) assert.equal(view.totals.cpaCents, Math.round((spend + fee) / view.totals.purchases));
  assert.ok(view.campaigns.every((c: any) => c.stage !== 'REVIEW'), 'review → warming after approval');
});

// ---------- float protection ----------
test('ceilings: platforms can never spend fuel we cannot collect; Meta spend_cap is never 0; low fuel pauses every channel, top-up resumes', async () => {
  const s = await launched({ fuel: 3500, budget: 3000 });
  for (let h = 1; h <= 6 * 24; h += 1) { offset = h * H; await sync(); await managed.idle(); }
  const w = await walletOf(s.org.id);
  const charges = await prisma.adChargeDay.findMany({ where: { campaign: { groupId: s.group.id } } });
  const owed = charges.reduce((n, c) => n + c.spendOwedCents + c.feeOwedCents, 0);
  const debited = charges.reduce((n, c) => n + c.spendDebitedCents + c.feeDebitedCents, 0);
  const short = charges.reduce((n, c) => n + c.shortfallCents, 0);
  assert.equal(owed, debited + short);
  assert.ok(debited <= 3500 && w.balanceCents + w.bonusCents >= 0, 'fuel never negative');
  // what the platforms spent, beyond what fuel covered, is bounded by rounding (≤ $1 across 3 channels)
  assert.ok(short <= 100, `uncollected ${short}¢`);
  assert.ok(m.capWrites.length > 0 && m.capWrites.every((x) => x.value !== '0'), `Meta caps: ${m.capWrites.map((x) => x.value).join(',')}`);
  const camps = await prisma.adCampaign.findMany({ where: { groupId: s.group.id } });
  assert.ok(camps.every((c) => c.stage === 'PAUSED' && c.pausedReason === 'low_fuel'), camps.map((c) => `${c.channel}:${c.stage}/${c.pausedReason}`).join(' '));
  assert.equal(await prisma.notification.count({ where: { organizationId: s.org.id, kind: 'fuel_empty' } }), 1, 'one notice for the episode');
  // top up → shortfall settled, ceilings raised first, every channel back on
  await fund(s.org.id, 10_000);
  await managed.idle();
  await managed.onFuelAdded(w.id);
  const after = await prisma.adCampaign.findMany({ where: { groupId: s.group.id } });
  assert.ok(after.every((c) => c.stage !== 'PAUSED'), after.map((c) => `${c.channel}:${c.stage}`).join(' '));
  assert.equal((await prisma.adChargeDay.aggregate({ where: { campaign: { groupId: s.group.id } }, _sum: { shortfallCents: true } }))._sum.shortfallCents ?? 0, 0);
});

test('ceilings: concurrent recomputes coalesce under the lease (no lost update, last write = latest fuel)', async () => {
  const s = await launched({ fuel: 20_000 });
  await Promise.all([1, 2, 3, 4, 5].map(async (i) => { if (i === 3) await fund(s.org.id, 5000); await managed.recomputeCeilings(s.org.id); }));
  await managed.recomputeCeilings(s.org.id);
  const accts = await prisma.adAccount.findMany({ where: { storeId: s.store.id, mode: 'MANAGED' } });
  for (const a of accts) {
    const tgt = await managed.ceilingTarget(a.id);
    assert.equal(a.capMinor, a.channel === 'META' ? Math.max(tgt.capMinor, 10_000) : tgt.capMinor, `${a.channel} cap is current`);
    assert.equal(a.capDirty, false);
    assert.equal(a.capLockedUntil, null);
  }
});

// ---------- ladder ----------
test('ladder: budget steps up with spend; lowering it by hand turns auto steps off', async () => {
  const s = await launched({ fuel: 200_000, channels: ['META', 'GOOGLE'], budget: 1000 });
  const ids = (await prisma.adCampaign.findMany({ where: { groupId: s.group.id } })).map((c) => c.id);
  await prisma.adInsightDaily.create({ data: { campaignId: ids[0], date: new Date('2026-01-01T00:00:00Z'), spendCents: LADDER[0].atSpendCents } });
  const r = await managed.ladder(s.group.id);
  assert.deepEqual(r, { step: 1, target: LADDER[0].dailyCents });
  let v: any = await managed.groupView(s.group.id);
  assert.equal(v.dailyBudgetCents, 1500);
  assert.equal(Object.values(v.split as Record<string, number>).reduce((n, x) => n + x, 0), 1500);
  assert.equal(await managed.ladder(s.group.id), null, 'same step twice = no-op');
  v = await managed.setBudget(s.org.id, s.group.id, 1200);
  assert.equal(v.autoLadder, false);
  await prisma.adInsightDaily.create({ data: { campaignId: ids[0], date: new Date('2026-01-02T00:00:00Z'), spendCents: LADDER[1].atSpendCents } });
  assert.equal(await managed.ladder(s.group.id), null);
});

// ---------- reconcile ----------
test('reconcile: platform revises past days → fuel adjusted to the platform number, drift > 1% alerts', async () => {
  const s = await launched({ fuel: 50_000 });
  offset = 50 * H;
  await sync();
  const before = await walletOf(s.org.id);
  const gCamp = Object.values(g.sim.state.campaigns)[0];
  g.sim.revise(gCamp.id, 0.9); // invalid-click credit on past days
  const out = await managed.reconcile(at(), s.org.id);
  const rows = await prisma.adReconcile.findMany({ where: { campaign: { groupId: s.group.id } } });
  assert.ok(rows.length >= 3);
  const gRows = out.filter((r) => r.status !== 'ok');
  assert.ok(gRows.length >= 1 && gRows.every((r) => r.driftBps >= 900), JSON.stringify(gRows));
  const w = await walletOf(s.org.id);
  assert.ok(w.balanceCents + w.bonusCents > before.balanceCents + before.bonusCents, 'credited back');
  const ops = await prisma.notification.findMany({ where: { kind: 'ads_reconcile_drift', body: { contains: s.group.campaigns.find((c: any) => c.channel === 'GOOGLE').id } } });
  assert.ok(ops.length >= 1);
  // second run: nothing left to adjust
  const again = await managed.reconcile(at(), s.org.id);
  assert.ok(again.filter((r) => r.campaignId === gRows[0].campaignId).every((r) => r.driftBps === 0));
});

// ---------- conversions ----------
test('conversions: one Purchase per channel (Meta CAPI, Google enhanced conversion, TikTok Events API), deduped with the browser tags', async () => {
  const s = await launched({ fuel: 20_000 });
  const res: any = await orders.checkout({ ...checkoutInput(s.store.slug, s.sp.id, 1), email: ' Ada@Example.COM ', attribution: { consent: true, gclid: 'Cj0KCQiA-test_gclid', ttclid: 'E.C.P.test-ttclid', ttp: '2Kq.ttp-cookie' } } as any, { ip: '203.0.113.77', userAgent: 'Mozilla/5.0' });
  const orderId = res.order.id;
  await orders.markPaid(orderId, uid('pi'), 'stub');
  await capi.idle();
  await orders.markPaid(orderId, uid('pi'), 'stub'); // replayed webhook
  await capi.idle();
  const ev = await prisma.conversionEvent.findUniqueOrThrow({ where: { eventId: `order_${orderId}` } });
  assert.equal(ev.metaStatus, 'skipped', 'no owned Pixel on this store');
  const d = await prisma.conversionDelivery.findMany({ where: { conversionEventId: ev.id } });
  assert.deepEqual(d.map((x) => [x.channel, x.status]).sort(), [['GOOGLE', 'sent'], ['META', 'sent'], ['TIKTOK', 'sent']]);
  assert.deepEqual([ev.sentGoogle, ev.sentTikTok], [true, true]);
  // browser twins with the same ids
  const tags = await capi.pixelForOrder(orderId);
  assert.deepEqual(tags.tags.map((x: any) => x.kind).sort(), ['gtag', 'meta', 'tiktok']);
  assert.equal(tags.transactionId, orderId);
  for (const tg of tags.tags as any[]) await capi.recordManagedBrowserEvent({ kind: tg.kind, id: tg.id, eventName: tg.kind === 'tiktok' ? 'CompletePayment' : tg.kind === 'gtag' ? 'purchase' : 'Purchase', eventId: tg.kind === 'gtag' ? orderId : `order_${orderId}` });
  const evs: any[] = await managed.testEvents(s.org.id, s.store.id);
  for (const ch of evs) {
    assert.ok(ch.events.length >= 2, `${ch.channel}: server + browser`);
    assert.equal(ch.events.filter((e: any) => !e.deduplicated).length, 1, `${ch.channel}: counted once`);
  }
  // Google gets the hashed email only, never raw PII
  const gEv = g.sim.state.events.find((e: any) => e.source === 'server');
  assert.ok(gEv && !JSON.stringify(g.sim.state.events).includes('ada@example.com'));
});

test('conversions: no consent → nothing sent to any managed channel', async () => {
  const s = await launched({ fuel: 20_000 });
  const res: any = await orders.checkout({ ...checkoutInput(s.store.slug, s.sp.id, 1), attribution: { consent: false, gclid: 'abc' } } as any, { ip: '203.0.113.77', userAgent: 'x' });
  await orders.markPaid(res.order.id, uid('pi'), 'stub');
  await capi.idle();
  const ev = await prisma.conversionEvent.findUniqueOrThrow({ where: { eventId: `order_${res.order.id}` } });
  assert.equal(ev.lastError, 'no_consent');
  assert.equal(ev.payload, null);
  assert.equal(await prisma.conversionDelivery.count({ where: { conversionEventId: ev.id } }), 0);
});

// ---------- pause / resume ----------
test('pause / resume: every channel follows; resume needs fuel', async () => {
  const s = await launched({ fuel: 20_000 });
  let v: any = await managed.pause(s.org.id, s.group.id);
  assert.equal(v.status, 'PAUSED');
  assert.ok(v.campaigns.every((c: any) => c.stage === 'PAUSED'));
  v = await managed.resume(s.org.id, s.group.id);
  assert.equal(v.status, 'LIVE');
  assert.ok(v.campaigns.every((c: any) => c.stage !== 'PAUSED'));
  const other = await makeOrg();
  await assert.rejects(() => managed.pause(other.id, s.group.id), /Boost not found/);
});
