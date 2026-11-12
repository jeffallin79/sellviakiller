// Phase 1 slice 3: Ad Fuel wallet — spend/fee debits (never below 0, idempotent, concurrent),
// shortfall → pause → settle, auto-reload single-flight + daily cap + failure handling.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@storeforge/db';
import { setPaymentProviderForTests } from '../src/payments';
import { StubPaymentProvider } from '../src/payments/stub.provider';
import { FuelService } from '../src/payments/fuel.service';
import { AdWalletService, MAX_RELOAD_FAILURES } from '../src/ads/wallet.service';
import { BoostService } from '../src/ads/boost.service';
import { fuelEvents } from '../src/ads/fuel-events';
import { creditTopUp } from '../src/ads/ledger';
import { makeOrg, makeStoreWithProduct, uid } from './helpers';

const wallet = new AdWalletService();
const boost = new BoostService(wallet);
const fuel = new FuelService();
const DAY = '2026-11-10';

/** Stub provider that counts / scripts saved-card charges (and is slow, to widen races). */
class SpyProvider extends StubPaymentProvider {
  charges: { idempotencyKey: string; amountCents: number }[] = [];
  next: Array<'succeeded' | 'processing' | 'requires_action' | 'timeout' | 'decline'> = [];
  delayMs = 40;
  async chargeSavedCard(o: any) {
    this.charges.push({ idempotencyKey: o.idempotencyKey, amountCents: o.amountCents });
    await new Promise((r) => setTimeout(r, this.delayMs));
    const n = this.next.shift() ?? 'succeeded';
    if (n === 'timeout') throw Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' });
    if (n === 'decline') throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', statusCode: 402, code: 'card_declined' });
    return { paymentIntentId: `pi_${o.idempotencyKey}`, status: n };
  }
}
let spy: SpyProvider;
beforeEach(() => { spy = new SpyProvider(); setPaymentProviderForTests(spy); });
after(async () => { setPaymentProviderForTests(null); await prisma.$disconnect(); });

async function setup(o: { balance?: number; bonus?: number; campaigns?: number; mode?: 'MANAGED' | 'OWNED' } = {}) {
  const org = await makeOrg();
  const { store } = await makeStoreWithProduct(org.id);
  const w = await wallet.walletFor(org.id);
  if (o.balance) await creditTopUp({ paymentIntentId: uid('pi'), amountCents: o.balance, walletId: w.id, provider: 'stub', source: 'manual', paymentMethodId: 'stub_pm_visa', paymentMethodLabel: 'Visa •••• 4242 (test)' });
  if (o.bonus) await prisma.adWallet.update({ where: { id: w.id }, data: { bonusCents: o.bonus } });
  const acct = await prisma.adAccount.create({ data: { storeId: store.id, channel: 'META', mode: o.mode ?? 'MANAGED', externalId: `act_${uid('a')}`, name: 'A', pixelId: '873462519203', pageId: '104857600123456' } });
  const campaigns = [];
  for (let i = 0; i < (o.campaigns ?? 1); i++) {
    campaigns.push(await prisma.adCampaign.create({ data: { storeId: store.id, adAccountId: acct.id, channel: 'META', name: `C${i}`, dailyBudgetCents: 1000, requestId: uid('rq'), stage: 'WARMING', launchedAt: new Date() } }));
  }
  return { org, store, walletId: w.id, campaigns };
}
const bal = async (id: string) => prisma.adWallet.findUniqueOrThrow({ where: { id } });

// ---------- debits ----------
test('spend debits never take fuel below 0, even with 20 campaigns charging at once', async () => {
  const s = await setup({ balance: 1000, campaigns: 20 });
  const rs = await Promise.all(s.campaigns.map((c) => wallet.chargeDay(c.id, DAY, { spendCents: 260, feeCents: 39 })));
  const w = await bal(s.walletId);
  assert.ok(w.balanceCents >= 0 && w.bonusCents >= 0);
  const debited = rs.reduce((a, r) => a + r.chargedNowCents, 0);
  assert.equal(debited, 1000, 'every cent used, none invented');
  assert.equal(w.balanceCents, 0);
  assert.equal(rs.reduce((a, r) => a + r.shortfallCents, 0), 20 * 299 - 1000, 'the rest is recorded as shortfall');
  const days = await prisma.adChargeDay.findMany({ where: { walletId: s.walletId } });
  for (const d of days) assert.ok(d.spendDebitedCents + d.feeDebitedCents <= d.spendOwedCents + d.feeOwedCents);
  // ledger running balances: every entry ≥ 0 and the latest equals the wallet
  const led = await prisma.walletTxn.findMany({ where: { walletId: s.walletId, kind: { in: ['SPEND', 'FEE'] } } });
  assert.ok(led.every((t) => (t.balanceAfterCents ?? 0) >= 0));
  assert.equal(Math.min(...led.map((t) => t.balanceAfterCents!)), 0);
  await assert.rejects(() => prisma.adWallet.update({ where: { id: s.walletId }, data: { balanceCents: -1 } }), /check constraint|nonnegative/i, 'DB CHECK is the backstop');
});

test('re-running the same day (hourly sync, two workers) charges only once', async () => {
  const s = await setup({ balance: 5000 });
  const c = s.campaigns[0];
  const rs = await Promise.all(Array.from({ length: 10 }, () => wallet.chargeDay(c.id, DAY, { spendCents: 800, feeCents: 120 })));
  assert.equal(rs.reduce((a, r) => a + r.chargedNowCents, 0), 920);
  assert.equal((await bal(s.walletId)).balanceCents, 4080);
  // spend grows through the day: only the delta is charged
  const r2 = await wallet.chargeDay(c.id, DAY, { spendCents: 1000, feeCents: 150 });
  assert.equal(r2.chargedNowCents, 230);
  assert.equal((await bal(s.walletId)).balanceCents, 3850);
  const kinds = (await prisma.walletTxn.findMany({ where: { campaignId: c.id }, orderBy: { createdAt: 'asc' } })).map((t) => `${t.kind}:${t.amountCents}`);
  assert.deepEqual(kinds, ['SPEND:-800', 'FEE:-120', 'SPEND:-200', 'FEE:-30']);
});

test('Meta revises spend down → the excess is credited back (bonus first), bonus fuel is spent first', async () => {
  const s = await setup({ balance: 1000, bonus: 200 });
  const c = s.campaigns[0];
  await wallet.chargeDay(c.id, DAY, { spendCents: 500, feeCents: 0 });
  let w = await bal(s.walletId);
  assert.deepEqual([w.bonusCents, w.balanceCents], [0, 700], 'bonus used first');
  const r = await wallet.chargeDay(c.id, DAY, { spendCents: 100, feeCents: 0 });
  assert.equal(r.chargedNowCents, -400);
  w = await bal(s.walletId);
  assert.deepEqual([w.bonusCents, w.balanceCents], [200, 900], 'bonus returned to bonus, the rest to paid fuel');
  const adj = await prisma.walletTxn.findFirstOrThrow({ where: { campaignId: c.id, kind: 'ADJUST' } });
  assert.equal(adj.amountCents, 400);
  assert.equal(adj.balanceAfterCents, 900);
});

test('shortfall → fuel empty → campaigns pause; top-up settles the shortfall and resumes them', async () => {
  const s = await setup({ balance: 300, campaigns: 2 });
  const empties: string[] = [];
  const onEmpty = (id: string) => empties.push(id);
  fuelEvents.on('empty', onEmpty);
  try {
    const r = await wallet.chargeDay(s.campaigns[0].id, DAY, { spendCents: 500, feeCents: 75 });
    assert.equal(r.chargedNowCents, 300);
    assert.equal(r.shortfallCents, 275);
    assert.deepEqual(empties, [s.walletId]);
  } finally {
    fuelEvents.off('empty', onEmpty);
  }
  const p = await boost.onFuelEmpty(s.walletId);
  assert.equal(p.paused, 2);
  for (const c of await prisma.adCampaign.findMany({ where: { storeId: s.store.id } })) assert.deepEqual([c.stage, c.pausedReason], ['PAUSED', 'low_fuel']);
  assert.equal((await prisma.notification.findMany({ where: { organizationId: s.org.id, kind: 'fuel_empty' } })).length, 1);
  await boost.onFuelEmpty(s.walletId); // a second empty signal in the same episode: no second alert
  assert.equal((await prisma.notification.findMany({ where: { organizationId: s.org.id, kind: 'fuel_empty' } })).length, 1);
  await assert.rejects(() => boost.resume(s.org.id, s.campaigns[0].id), /unpaid spend|Ad Fuel/);

  await fuel.startTopUp(s.org.id, 'm@x.test', 2000, uid('req')); // stub: credited now
  const res = await boost.onFuelAdded(s.walletId);
  assert.equal(res.resumed, 2);
  const w = await bal(s.walletId);
  assert.equal(w.balanceCents, 2000 - 275, 'shortfall collected from the new fuel');
  assert.equal(w.lowFuelAt, null);
  const day = await prisma.adChargeDay.findFirstOrThrow({ where: { campaignId: s.campaigns[0].id } });
  assert.equal(day.shortfallCents, 0);
  for (const c of await prisma.adCampaign.findMany({ where: { storeId: s.store.id } })) assert.deepEqual([c.stage, c.pausedReason], ['WARMING', null]);
});

// ---------- auto-reload ----------
async function autoWallet(o: { balance: number; threshold: number; reload: number; campaigns?: number; card?: string }) {
  const s = await setup({ balance: o.balance, campaigns: o.campaigns ?? 1 });
  await prisma.adWallet.update({ where: { id: s.walletId }, data: { autoReloadEnabled: true, thresholdCents: o.threshold, autoReloadCents: o.reload, paymentMethodId: o.card ?? 'stub_pm_visa' } });
  return s;
}

test('auto-reload race: 12 concurrent debits below the threshold start exactly ONE reload / PaymentIntent', async () => {
  const s = await autoWallet({ balance: 1500, threshold: 1000, reload: 2000, campaigns: 12 });
  await Promise.all(s.campaigns.map((c) => wallet.chargeDay(c.id, DAY, { spendCents: 100, feeCents: 15 })));
  assert.equal(spy.charges.length, 1, 'one off-session charge');
  const ups = await prisma.walletTxn.findMany({ where: { walletId: s.walletId, kind: 'TOPUP', source: 'auto' } });
  assert.equal(ups.length, 1);
  assert.equal(ups[0].amountCents, 2000);
  const w = await bal(s.walletId);
  assert.equal(w.reloadInFlight, false);
  assert.equal(w.balanceCents, 1500 - 12 * 115 + 2000);
  assert.equal(spy.charges[0].idempotencyKey, `sf-autoreload-${s.walletId}-${w.reloadSeq}`);
});

test('auto-reload: concurrent maybeAutoReload calls are single-flight; a retried run reuses the key', async () => {
  const s = await autoWallet({ balance: 500, threshold: 1000, reload: 1500 });
  const rs = await Promise.all(Array.from({ length: 8 }, () => wallet.maybeAutoReload(s.walletId)));
  assert.equal(rs.filter((r) => r.started).length, 1);
  const w = await bal(s.walletId);
  await wallet.runReload(s.walletId, w.reloadSeq); // stale retry of the finished reload
  assert.equal(spy.charges.length, 1);
  assert.equal(await prisma.walletTxn.count({ where: { walletId: s.walletId, kind: 'TOPUP', source: 'auto' } }), 1);
});

test('auto-reload daily cap (ADS_AUTORELOAD_MAX_PER_DAY)', async () => {
  const prev = process.env.ADS_AUTORELOAD_MAX_PER_DAY;
  process.env.ADS_AUTORELOAD_MAX_PER_DAY = '2';
  try {
    const s = await autoWallet({ balance: 100, threshold: 1000, reload: 1000 });
    const c = s.campaigns[0];
    let owed = 0;
    for (let i = 0; i < 4; i++) {
      owed += 1050;
      await wallet.chargeDay(c.id, DAY, { spendCents: owed, feeCents: 0 });
    }
    assert.equal(spy.charges.length, 2, 'stops after 2 reloads today');
    const w = await bal(s.walletId);
    assert.match(w.reloadLastError ?? '', /limit 2/);
    assert.equal(w.reloadInFlight, false);
    assert.ok(w.balanceCents >= 0);
  } finally {
    if (prev === undefined) delete process.env.ADS_AUTORELOAD_MAX_PER_DAY; else process.env.ADS_AUTORELOAD_MAX_PER_DAY = prev;
  }
});

test(`auto-reload: declines count up; after ${MAX_RELOAD_FAILURES} it turns itself off and tells the merchant`, async () => {
  const s = await autoWallet({ balance: 200, threshold: 1000, reload: 2000, card: 'stub_pm_declined' });
  spy.next = ['decline', 'decline', 'decline'];
  for (let i = 0; i < 5; i++) await wallet.maybeAutoReload(s.walletId);
  const w = await bal(s.walletId);
  assert.equal(spy.charges.length, MAX_RELOAD_FAILURES);
  assert.equal(w.reloadFailures, MAX_RELOAD_FAILURES);
  assert.equal(w.autoReloadEnabled, false);
  assert.equal(w.balanceCents, 200, 'no credit for declined charges');
  assert.equal(await prisma.notification.count({ where: { organizationId: s.org.id, kind: 'autoreload_off' } }), 1);
});

test('auto-reload: requires_action (bank wants the cardholder) disables at once', async () => {
  const s = await autoWallet({ balance: 200, threshold: 1000, reload: 2000 });
  spy.next = ['requires_action'];
  const r = await wallet.maybeAutoReload(s.walletId);
  assert.equal((r as any).status, 'failed');
  const w = await bal(s.walletId);
  assert.equal(w.autoReloadEnabled, false);
  assert.equal(w.reloadInFlight, false);
});

test('auto-reload: unknown outcome stays in flight; reconcile retries with the SAME key and credits once', async () => {
  const s = await autoWallet({ balance: 200, threshold: 1000, reload: 2000 });
  spy.next = ['timeout'];
  const r = await wallet.maybeAutoReload(s.walletId);
  assert.equal((r as any).status, 'unknown');
  let w = await bal(s.walletId);
  assert.equal(w.reloadInFlight, true);
  assert.equal((await wallet.maybeAutoReload(s.walletId)).started, false, 'no second reload while one is unresolved');
  assert.deepEqual(await wallet.reconcileReloads(new Date(), 10 * 60_000), [], 'too fresh to re-check');
  const later = new Date(Date.now() + 11 * 60_000);
  await Promise.all([wallet.reconcileReloads(later), wallet.reconcileReloads(later)]);
  assert.equal(new Set(spy.charges.map((c) => c.idempotencyKey)).size, 1, 'same idempotency key every time');
  w = await bal(s.walletId);
  assert.equal(w.reloadInFlight, false);
  assert.equal(w.balanceCents, 2200);
  assert.equal(await prisma.walletTxn.count({ where: { walletId: s.walletId, kind: 'TOPUP', source: 'auto' } }), 1);
});

test('auto-reload: processing → credited by the payment_intent.succeeded webhook, which releases the claim', async () => {
  const s = await autoWallet({ balance: 200, threshold: 1000, reload: 2000 });
  spy.next = ['processing'];
  await wallet.maybeAutoReload(s.walletId);
  let w = await bal(s.walletId);
  assert.equal(w.reloadInFlight, true);
  const pi = `pi_sf-autoreload-${s.walletId}-${w.reloadSeq}`;
  await Promise.all([1, 2].map(() => fuel.creditTopUp({ paymentIntentId: pi, amountCents: 2000, walletId: s.walletId, provider: 'stripe', source: 'auto', paymentMethodId: 'stub_pm_visa' })));
  w = await bal(s.walletId);
  assert.equal(w.reloadInFlight, false);
  assert.equal(w.balanceCents, 2200, 'credited once despite a replayed webhook');
  // payment_failed for an auto reload while one is in flight counts as a failure
  spy.next = ['processing'];
  await prisma.adWallet.update({ where: { id: s.walletId }, data: { thresholdCents: 5000 } });
  await wallet.maybeAutoReload(s.walletId);
  await wallet.reloadPaymentFailed(s.walletId, 'insufficient_funds');
  w = await bal(s.walletId);
  assert.deepEqual([w.reloadInFlight, w.reloadFailures], [false, 1]);
});

test('settings: auto-reload needs a saved card; Checkout top-up (stub) saves one; overview shows refundable per top-up', async () => {
  const org = await makeOrg();
  await assert.rejects(() => wallet.updateSettings(org.id, { autoReloadEnabled: true, thresholdCents: 1000, autoReloadCents: 2000 }), /saved card|Top up once/);
  setPaymentProviderForTests(null);
  const r = await fuel.startTopUpCheckout(org.id, 'm@x.test', 2500, uid('req'), 'http://localhost:3001/fuel');
  assert.equal(r.credited, true);
  await assert.rejects(() => wallet.updateSettings(org.id, { autoReloadEnabled: true, thresholdCents: 1000, autoReloadCents: 500 }), /between/);
  await wallet.updateSettings(org.id, { autoReloadEnabled: true, thresholdCents: 1000, autoReloadCents: 2000 });
  const o = await wallet.overview(org.id);
  assert.equal(o.wallet.card?.label, 'Visa •••• 4242 (test)');
  assert.equal(o.wallet.autoReloadEnabled, true);
  assert.equal(o.topups[0].refundableCents, 2500);
  await fuel.refundTopUp(org.id, o.topups[0].id, 1000);
  const o2 = await wallet.overview(org.id);
  assert.equal(o2.topups[0].refundedCents, 1000);
  assert.equal(o2.topups[0].refundableCents, 1500);
  assert.equal(o2.ledger[0].kind, 'REFUND');
  assert.equal(o2.ledger[0].balanceAfterCents, 1500);
});
