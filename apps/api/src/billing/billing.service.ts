import { Injectable, BadRequestException } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import { PLANS, type PlanId } from '@storeforge/shared';
import { createSquareSubscription, squareMode } from './square.client';

@Injectable()
export class BillingService {
  async listPlans() {
    const plans = await prisma.plan.findMany({ orderBy: { priceUsd: 'asc' } });
    return {
      plans,
      mode: squareMode(),
      paymentsProvider: 'square',
    };
  }

  async subscribe(organizationId: string, userEmail: string, planId: PlanId = 'starter') {
    if (!PLANS[planId]) throw new BadRequestException('Invalid plan');

    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException('Plan not seeded — run pnpm db:seed');

    const sq = await createSquareSubscription({
      planId,
      email: userEmail,
      accountId: organizationId,
      planCatalogId: plan.squareCatalogId,
    });

    const sub = await prisma.subscription.upsert({
      where: { organizationId },
      update: {
        planId,
        status: 'ACTIVE',
        squareSubscriptionId: sq.subscriptionId,
        squareCustomerId: sq.customerId,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
        cancelAtPeriodEnd: false,
      },
      create: {
        organizationId,
        planId,
        status: 'ACTIVE',
        squareSubscriptionId: sq.subscriptionId,
        squareCustomerId: sq.customerId,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
      include: { plan: true },
    });

    return { subscription: sub, square: sq };
  }

  async getSubscription(organizationId: string) {
    return prisma.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
  }
}
