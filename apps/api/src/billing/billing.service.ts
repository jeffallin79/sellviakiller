import { Injectable, BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import { PLANS, type PlanId } from '@storeforge/shared';
import {
  getPaymentProvider,
  priceIdForPlan,
  planForPriceId,
  type NormalizedSubscription,
} from '../payments';

const adminUrl = () => process.env.ADMIN_URL ?? 'http://localhost:3001';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  async listPlans() {
    const plans = await prisma.plan.findMany({ orderBy: { priceUsd: 'asc' } });
    const provider = getPaymentProvider();
    return {
      plans: plans.map((p) => ({ ...p, priceConfigured: Boolean(priceIdForPlan(p.id, p.providerPriceId)) })),
      mode: provider.mode(),
      paymentsProvider: provider.kind,
    };
  }

  /**
   * Stub: activates the plan locally (Phase 0 behaviour).
   * Stripe: returns a Checkout URL; the subscription row only turns ACTIVE from the
   * verified webhook (customer.subscription.* / invoice.*), never from the redirect.
   */
  async subscribe(organizationId: string, userEmail: string, planId: PlanId = 'starter') {
    if (!PLANS[planId]) throw new BadRequestException('Invalid plan');
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException('Plan not seeded — run pnpm db:seed');
    const provider = getPaymentProvider();

    if (provider.kind === 'stub') {
      const sub = await prisma.subscription.upsert({
        where: { organizationId },
        update: { planId, status: 'ACTIVE', provider: 'stub', currentPeriodEnd: new Date(Date.now() + 30 * 86400000), cancelAtPeriodEnd: false },
        create: { organizationId, planId, status: 'ACTIVE', provider: 'stub', currentPeriodEnd: new Date(Date.now() + 30 * 86400000) },
        include: { plan: true },
      });
      return {
        subscription: sub,
        checkoutUrl: null,
        mode: 'stub',
        message: 'Payments are in stub mode (no STRIPE_SECRET_KEY). Plan activated locally; no card was charged.',
      };
    }

    const existing = await prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (existing?.provider === 'stripe' && existing.providerSubscriptionId && ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(existing.status)) {
      // Plan changes / cancellation happen in the Customer Portal.
      const portal = await this.portal(organizationId);
      return { subscription: existing, checkoutUrl: portal.url, mode: provider.mode(), message: 'You already have a plan. Opening the billing portal to change it.' };
    }

    const priceId = priceIdForPlan(planId, plan.providerPriceId);
    if (!priceId) {
      throw new ServiceUnavailableException(`STRIPE_PRICE_${planId.toUpperCase()} is not set`);
    }
    const { customerId } = await provider.ensureCustomer({ organizationId, email: userEmail, customerId: org.billingCustomerId });
    if (!org.billingCustomerId) {
      await prisma.organization.update({ where: { id: organizationId }, data: { billingCustomerId: customerId } });
    }
    const session = await provider.createSubscriptionCheckout({
      organizationId,
      planId,
      priceId,
      email: userEmail,
      customerId,
      successUrl: `${adminUrl()}/billing?checkout=success`,
      cancelUrl: `${adminUrl()}/billing?checkout=cancelled`,
    });
    return {
      subscription: existing,
      checkoutUrl: session.url,
      mode: provider.mode(),
      message: 'Redirecting to Stripe Checkout.',
    };
  }

  async portal(organizationId: string) {
    const provider = getPaymentProvider();
    const returnUrl = `${adminUrl()}/billing`;
    if (provider.kind === 'stub') return provider.createBillingPortal({ customerId: 'stub', returnUrl });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (!org.billingCustomerId) throw new BadRequestException('No billing account yet — pick a plan first');
    return provider.createBillingPortal({ customerId: org.billingCustomerId, returnUrl });
  }

  async getSubscription(organizationId: string) {
    return prisma.subscription.findUnique({ where: { organizationId }, include: { plan: true } });
  }

  /**
   * Re-reads the subscription from the provider (authoritative, so event order and
   * replays don't matter) and upserts our row.
   */
  async syncSubscription(providerSubscriptionId: string, hint: { organizationId?: string | null } = {}) {
    const provider = getPaymentProvider();
    const s: NormalizedSubscription = await provider.getSubscription(providerSubscriptionId);
    let organizationId = s.organizationId ?? hint.organizationId ?? null;
    if (!organizationId) {
      const bySub = await prisma.subscription.findUnique({ where: { providerSubscriptionId } });
      organizationId = bySub?.organizationId ?? null;
    }
    if (!organizationId && s.providerCustomerId) {
      const org = await prisma.organization.findUnique({ where: { billingCustomerId: s.providerCustomerId } });
      organizationId = org?.id ?? null;
    }
    if (!organizationId) {
      this.logger.warn(`Subscription ${providerSubscriptionId} has no matching organization — ignored`);
      return null;
    }
    const current = await prisma.subscription.findUnique({ where: { organizationId } });
    const planId = planForPriceId(s.priceId) ?? current?.planId ?? 'starter';
    const data = {
      planId,
      status: s.status,
      provider: provider.kind,
      providerSubscriptionId: s.providerSubscriptionId,
      providerCustomerId: s.providerCustomerId,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    };
    if (s.providerCustomerId) {
      await prisma.organization.updateMany({
        where: { id: organizationId, billingCustomerId: null },
        data: { billingCustomerId: s.providerCustomerId },
      });
    }
    return prisma.subscription.upsert({
      where: { organizationId },
      update: data,
      create: { organizationId, ...data },
    });
  }
}
