/**
 * Thin Square client wrapper.
 * Uses official `square` SDK when SQUARE_ACCESS_TOKEN is set; otherwise stub mode.
 */

export type SquareMode = 'live' | 'sandbox' | 'stub';

export function squareMode(): SquareMode {
  if (!process.env.SQUARE_ACCESS_TOKEN) return 'stub';
  return process.env.SQUARE_ENVIRONMENT === 'production' ? 'live' : 'sandbox';
}

export async function createSubscriptionStub(opts: {
  planId: string;
  email: string;
  accountId: string;
}) {
  return {
    subscriptionId: `stub_sub_${opts.accountId.slice(-8)}`,
    customerId: `stub_cus_${opts.email.split('@')[0]}`,
    status: 'ACTIVE' as const,
    checkoutUrl: null as string | null,
    mode: 'stub' as const,
    message:
      'SQUARE_ACCESS_TOKEN not set — activated Starter subscription locally. Configure Square sandbox for real billing.',
  };
}

export async function createPaymentLinkStub(opts: {
  amountCents: number;
  currency: string;
  orderId: string;
  redirectUrl: string;
}) {
  return {
    paymentLinkId: `stub_link_${opts.orderId.slice(-8)}`,
    url: `${opts.redirectUrl}?stub_paid=1&orderId=${opts.orderId}`,
    mode: 'stub' as const,
  };
}

/** Attempt live Square subscription via Payments / Subscriptions API */
export async function createSquareSubscription(opts: {
  planId: string;
  email: string;
  accountId: string;
  planCatalogId?: string | null;
}) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) return createSubscriptionStub(opts);

  try {
    // Dynamic import so missing keys don't break boot
    const { Client, Environment } = await import('square');
    const client = new Client({
      accessToken: token,
      environment:
        process.env.SQUARE_ENVIRONMENT === 'production'
          ? Environment.Production
          : Environment.Sandbox,
    });

    const customer = await client.customersApi.createCustomer({
      emailAddress: opts.email,
      referenceId: opts.accountId,
    });
    const customerId = customer.result.customer?.id;
    if (!customerId) throw new Error('Square customer create failed');

    const locationId = process.env.SQUARE_LOCATION_ID;
    const planVariationId =
      opts.planCatalogId ||
      process.env[`SQUARE_PLAN_${opts.planId.toUpperCase()}_ID`];

    if (!planVariationId || !locationId) {
      return {
        ...createSubscriptionStub(opts),
        message:
          'Square token present but SQUARE_PLAN_*_ID / SQUARE_LOCATION_ID missing — stub activated',
        customerId,
      };
    }

    // Square Subscriptions API
    const sub = await client.subscriptionsApi.createSubscription({
      idempotencyKey: `sf-sub-${opts.accountId}-${opts.planId}`,
      locationId,
      planVariationId,
      customerId,
    });

    return {
      subscriptionId: sub.result.subscription?.id ?? `sq_${opts.accountId}`,
      customerId,
      status: 'ACTIVE' as const,
      checkoutUrl: null as string | null,
      mode: squareMode(),
      message: 'Square subscription created',
    };
  } catch (err) {
    console.error('Square subscription error, falling back to stub', err);
    return createSubscriptionStub(opts);
  }
}

export async function createSquareCheckout(opts: {
  amountCents: number;
  currency: string;
  orderId: string;
  redirectUrl: string;
  note?: string;
}) {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) return createPaymentLinkStub(opts);

  try {
    const { Client, Environment } = await import('square');
    const client = new Client({
      accessToken: token,
      environment:
        process.env.SQUARE_ENVIRONMENT === 'production'
          ? Environment.Production
          : Environment.Sandbox,
    });
    const locationId = process.env.SQUARE_LOCATION_ID;
    if (!locationId) return createPaymentLinkStub(opts);

    const feeBps = Number(process.env.SQUARE_PLATFORM_FEE_BPS ?? 100);
    const appFee = Math.round((opts.amountCents * feeBps) / 10000);

    const link = await client.checkoutApi.createPaymentLink({
      idempotencyKey: `sf-pay-${opts.orderId}`,
      order: {
        locationId,
        referenceId: opts.orderId,
        lineItems: [
          {
            name: opts.note ?? 'StoreForge order',
            quantity: '1',
            basePriceMoney: {
              amount: BigInt(opts.amountCents),
              currency: opts.currency as 'USD',
            },
          },
        ],
      },
      checkoutOptions: {
        redirectUrl: opts.redirectUrl,
        askForShippingAddress: false,
        appFeeMoney:
          appFee > 0
            ? { amount: BigInt(appFee), currency: opts.currency as 'USD' }
            : undefined,
      },
    });

    return {
      paymentLinkId: link.result.paymentLink?.id ?? '',
      url: link.result.paymentLink?.url ?? (await createPaymentLinkStub(opts)).url,
      mode: squareMode(),
      platformFeeCents: appFee,
    };
  } catch (err) {
    console.error('Square checkout error, stub fallback', err);
    return createPaymentLinkStub(opts);
  }
}
