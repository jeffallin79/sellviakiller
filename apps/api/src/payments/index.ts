import { PaymentProvider } from './payment-provider';
import { StubPaymentProvider } from './stub.provider';
import { StripePaymentProvider } from './stripe.provider';

export * from './payment-provider';

let cached: PaymentProvider | null = null;
let override: PaymentProvider | null = null;

/**
 * Stripe when STRIPE_SECRET_KEY is set, otherwise stub. Live keys are refused unless
 * STRIPE_ALLOW_LIVE=true, so a pasted sk_live_ can't take real money by accident.
 */
export function getPaymentProvider(): PaymentProvider {
  if (override) return override;
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    cached = new StubPaymentProvider();
  } else {
    if (/^(sk|rk)_live_/.test(key) && process.env.STRIPE_ALLOW_LIVE !== 'true') {
      throw new Error('STRIPE_SECRET_KEY is a live key but STRIPE_ALLOW_LIVE is not "true". Use test keys until launch is approved.');
    }
    cached = new StripePaymentProvider(key);
  }
  return cached;
}

export function isStubPayments(): boolean {
  return getPaymentProvider().kind === 'stub';
}

/** Tests only. */
export function setPaymentProviderForTests(p: PaymentProvider | null) {
  override = p;
  cached = null;
}
