import { Injectable } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import { getPaymentProvider, type PayoutAccountStatus } from './index';

const adminUrl = () => process.env.ADMIN_URL ?? 'http://localhost:3001';

/** Stripe Connect Express: one connected account per merchant organization. */
@Injectable()
export class PayoutsService {
  async status(organizationId: string) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    return {
      provider: getPaymentProvider().kind,
      accountId: org.payoutAccountId,
      chargesEnabled: org.payoutChargesEnabled,
      payoutsEnabled: org.payoutPayoutsEnabled,
      detailsSubmitted: org.payoutDetailsSubmitted,
      ready: Boolean(org.payoutAccountId && org.payoutChargesEnabled),
    };
  }

  async startOnboarding(organizationId: string, email: string) {
    const provider = getPaymentProvider();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    let accountId = org.payoutAccountId;
    if (!accountId || org.payoutProvider !== provider.kind) {
      accountId = (await provider.createPayoutAccount({ organizationId, email })).accountId;
      await prisma.organization.update({
        where: { id: organizationId },
        data: { payoutAccountId: accountId, payoutProvider: provider.kind, payoutUpdatedAt: new Date() },
      });
    }
    const link = await provider.createPayoutOnboardingLink({
      accountId,
      refreshUrl: `${adminUrl()}/launchpad?payouts=refresh`,
      returnUrl: `${adminUrl()}/launchpad?payouts=return`,
    });
    if (provider.kind === 'stub') await this.refresh(organizationId);
    return { url: link.url, accountId };
  }

  async refresh(organizationId: string) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (!org.payoutAccountId) return this.status(organizationId);
    await this.apply(await getPaymentProvider().getPayoutAccount(org.payoutAccountId));
    return this.status(organizationId);
  }

  /** From account.updated webhooks or a refresh. Idempotent. */
  async apply(s: PayoutAccountStatus) {
    return prisma.organization.updateMany({
      where: { payoutAccountId: s.accountId },
      data: {
        payoutChargesEnabled: s.chargesEnabled,
        payoutPayoutsEnabled: s.payoutsEnabled,
        payoutDetailsSubmitted: s.detailsSubmitted,
        payoutUpdatedAt: new Date(),
      },
    });
  }
}
