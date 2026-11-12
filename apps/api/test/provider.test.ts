import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPaymentProvider, setPaymentProviderForTests, platformFeeCents, planForPriceId } from '../src/payments';
import { normalizeStripeSubscription } from '../src/payments/stripe.provider';

test('provider: stub without key, stripe test with sk_test_, live key refused unless allowed', () => {
  const saved = { ...process.env };
  setPaymentProviderForTests(null);
  process.env.STRIPE_SECRET_KEY = '';
  assert.equal(getPaymentProvider().kind, 'stub');
  setPaymentProviderForTests(null);
  process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
  assert.equal(getPaymentProvider().kind, 'stripe');
  assert.equal(getPaymentProvider().mode(), 'test');
  setPaymentProviderForTests(null);
  process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
  delete process.env.STRIPE_ALLOW_LIVE;
  assert.throws(() => getPaymentProvider(), /live key/);
  setPaymentProviderForTests(null);
  process.env = saved;
});

test('platform fee: default 0, bps, clamped at 20%', () => {
  delete process.env.PLATFORM_FEE_BPS;
  assert.equal(platformFeeCents(10000), 0);
  process.env.PLATFORM_FEE_BPS = '150';
  assert.equal(platformFeeCents(10000), 150);
  process.env.PLATFORM_FEE_BPS = '99999';
  assert.equal(platformFeeCents(10000), 2000);
  delete process.env.PLATFORM_FEE_BPS;
});

test('price id ↔ plan mapping', () => {
  process.env.STRIPE_PRICE_GROWTH = 'price_g';
  assert.equal(planForPriceId('price_g'), 'growth');
  assert.equal(planForPriceId('price_unknown'), null);
});

test('normalize Stripe subscription (period end on items, status map)', () => {
  const n = normalizeStripeSubscription({
    id: 'sub_1', status: 'past_due', customer: 'cus_1', cancel_at_period_end: true, metadata: { organizationId: 'org_1' },
    items: { data: [{ current_period_end: 1800000000, price: { id: 'price_g' } }] },
  } as any);
  assert.equal(n.status, 'PAST_DUE');
  assert.equal(n.organizationId, 'org_1');
  assert.equal(n.priceId, 'price_g');
  assert.equal(n.currentPeriodEnd?.getTime(), 1800000000 * 1000);
  assert.equal(n.cancelAtPeriodEnd, true);
  assert.equal(normalizeStripeSubscription({ id: 's', status: 'canceled', customer: { id: 'c' }, items: { data: [] }, metadata: {} } as any).status, 'CANCELLED');
});
