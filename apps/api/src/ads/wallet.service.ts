import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import { getPaymentProvider, isDefiniteRejection } from '../payments';
import { NotificationsService } from '../payments/notifications.service';
import { creditTopUp, lockWallet } from './ledger';
import { fuelEvents } from './fuel-events';

export const MAX_RELOAD_FAILURES = 3;
const reloadMaxPerDay = () => Math.max(1, Number(process.env.ADS_AUTORELOAD_MAX_PER_DAY ?? 3) || 3);
const RELOAD_MIN = 1000; // $10
const RELOAD_MAX = 500000; // $5,000

export type ChargeResult = {
  spendDebitedCents: number;
  feeDebitedCents: number;
  /** this run (negative = credited back after Meta revised spend down) */
  chargedNowCents: number;
  shortfallCents: number;
  availableAfterCents: number;
};

/**
 * Ad Fuel money for Boost: daily spend/fee charges and auto-reload.
 *
 * Charges are DELTAS against AdChargeDay (what a campaign owes for a day vs what was debited),
 * computed under the wallet row lock. Re-running the job (hourly insights, retries, two workers)
 * charges only the difference, never twice; if Meta revises spend down, the excess is credited
 * back. Bonus fuel is used first. Fuel never goes below zero: whatever can't be covered is a
 * shortfall, the campaign is paused, and the shortfall is collected after the next top-up.
 */
@Injectable()
export class AdWalletService {
  private readonly logger = new Logger(AdWalletService.name);
  private readonly notifications = new NotificationsService();

  async walletFor(organizationId: string) {
    return prisma.adWallet.upsert({ where: { organizationId }, update: {}, create: { organizationId } });
  }

  async updateSettings(organizationId: string, s: { autoReloadEnabled: boolean; thresholdCents: number; autoReloadCents: number }) {
    const w = await this.walletFor(organizationId);
    if (s.autoReloadEnabled) {
      if (!w.paymentMethodId) throw new BadRequestException('Top up once with a card first; auto-reload charges that saved card');
      if (!Number.isInteger(s.autoReloadCents) || s.autoReloadCents < RELOAD_MIN || s.autoReloadCents > RELOAD_MAX) {
        throw new BadRequestException(`Reload amount must be between $${RELOAD_MIN / 100} and $${RELOAD_MAX / 100}`);
      }
      if (!Number.isInteger(s.thresholdCents) || s.thresholdCents < 0 || s.thresholdCents > RELOAD_MAX) throw new BadRequestException('Invalid threshold');
    }
    const updated = await prisma.adWallet.update({
      where: { id: w.id },
      data: {
        autoReloadEnabled: s.autoReloadEnabled,
        ...(s.autoReloadEnabled ? { thresholdCents: s.thresholdCents, autoReloadCents: s.autoReloadCents, reloadFailures: 0, reloadLastError: null } : {}),
      },
    });
    if (updated.autoReloadEnabled) await this.maybeAutoReload(updated.id);
    return prisma.adWallet.findUniqueOrThrow({ where: { id: w.id } });
  }

  /**
   * Brings one campaign-day to `owed` (spend + fee, cents). Idempotent and concurrency-safe.
   * date = YYYY-MM-DD (ad account day).
   */
  async chargeDay(campaignId: string, date: string, owed: { spendCents: number; feeCents: number }): Promise<ChargeResult> {
    const spendOwed = Math.max(0, Math.round(owed.spendCents));
    const feeOwed = Math.max(0, Math.round(owed.feeCents));
    const campaign = await prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { store: true } });
    const wallet = await this.walletFor(campaign.store.organizationId);
    const day = new Date(`${date}T00:00:00.000Z`);

    const r = await prisma.$transaction(async (tx) => {
      const w = await lockWallet(tx, wallet.id);
      const cd = await tx.adChargeDay.upsert({
        where: { campaignId_date: { campaignId, date: day } },
        create: { campaignId, walletId: w.id, date: day },
        update: {},
      });
      let balance = w.balanceCents;
      let bonus = w.bonusCents;
      let spendDebited = cd.spendDebitedCents;
      let feeDebited = cd.feeDebitedCents;
      const entries: { kind: 'SPEND' | 'FEE' | 'ADJUST'; amount: number; bonus: number; note?: string }[] = [];

      // How much of this day's debits came from bonus fuel (credit-backs return it there first).
      const bonusUsed = async () => {
        const a = await tx.walletTxn.aggregate({ where: { walletId: w.id, campaignId, day, kind: { in: ['SPEND', 'FEE', 'ADJUST'] } }, _sum: { bonusCents: true } });
        return Math.max(0, -(a._sum.bonusCents ?? 0));
      };

      // 1) Meta revised the day down → give the excess back.
      let back = Math.max(0, spendDebited - spendOwed) + Math.max(0, feeDebited - feeOwed);
      if (back > 0) {
        const toBonus = Math.min(back, await bonusUsed());
        const toBalance = back - toBonus;
        bonus += toBonus;
        balance += toBalance;
        entries.push({ kind: 'ADJUST', amount: back, bonus: toBonus, note: 'Ad spend revised down by Meta' });
        spendDebited = Math.min(spendDebited, spendOwed);
        feeDebited = Math.min(feeDebited, feeOwed);
      }

      // 2) Collect what's still owed: spend first, then fee; bonus fuel first, then paid fuel.
      const take = (need: number) => {
        const fromBonus = Math.min(bonus, need);
        bonus -= fromBonus;
        const fromBalance = Math.min(balance, need - fromBonus);
        balance -= fromBalance;
        return { total: fromBonus + fromBalance, fromBonus };
      };
      const s = take(spendOwed - spendDebited);
      if (s.total > 0) { entries.push({ kind: 'SPEND', amount: -s.total, bonus: -s.fromBonus }); spendDebited += s.total; }
      const f = take(feeOwed - feeDebited);
      if (f.total > 0) { entries.push({ kind: 'FEE', amount: -f.total, bonus: -f.fromBonus }); feeDebited += f.total; }

      if (balance < 0 || bonus < 0) throw new Error('invariant: wallet would go negative'); // unreachable; CHECK backs it up
      const shortfall = spendOwed - spendDebited + (feeOwed - feeDebited);

      // Ledger entries carry the running balance (applied in order).
      let runBal = w.balanceCents;
      let runBonus = w.bonusCents;
      for (const e of entries) {
        runBonus += e.bonus;
        runBal += e.amount - e.bonus;
        await tx.walletTxn.create({
          data: {
            walletId: w.id, kind: e.kind, amountCents: e.amount, bonusCents: e.bonus, campaignId, day, note: e.note ?? null,
            balanceAfterCents: runBal, bonusAfterCents: runBonus, provider: 'internal',
          },
        });
      }
      if (entries.length) await tx.adWallet.update({ where: { id: w.id }, data: { balanceCents: balance, bonusCents: bonus } });
      await tx.adChargeDay.update({
        where: { id: cd.id },
        data: { spendOwedCents: spendOwed, feeOwedCents: feeOwed, spendDebitedCents: spendDebited, feeDebitedCents: feeDebited, shortfallCents: shortfall },
      });
      return {
        spendDebitedCents: spendDebited,
        feeDebitedCents: feeDebited,
        chargedNowCents: -entries.reduce((n, e) => n + e.amount, 0),
        shortfallCents: shortfall,
        availableAfterCents: balance + bonus,
      };
    });

    if (r.shortfallCents > 0 || (r.availableAfterCents === 0 && spendOwed + feeOwed > 0)) fuelEvents.emit('empty', wallet.id);
    await this.maybeAutoReload(wallet.id);
    return r;
  }

  /** Re-runs every campaign-day with an open shortfall (after fuel was added). */
  async settleShortfalls(walletId: string) {
    const open = await prisma.adChargeDay.findMany({ where: { walletId, shortfallCents: { gt: 0 } }, orderBy: { date: 'asc' } });
    let collected = 0;
    for (const d of open) {
      const r = await this.chargeDay(d.campaignId, d.date.toISOString().slice(0, 10), { spendCents: d.spendOwedCents, feeCents: d.feeOwedCents });
      collected += r.chargedNowCents;
      if (r.shortfallCents > 0) break; // still dry
    }
    return { collected };
  }

  /**
   * Auto-reload, single-flight: one atomic UPDATE claims the wallet (fuel < threshold, enabled,
   * card saved, nothing in flight) and bumps reloadSeq. Only the claimer charges, with the
   * idempotency key sf-autoreload-<wallet>-<seq>, so racing debits start exactly one reload and
   * a retried call can never create a second PaymentIntent.
   */
  async maybeAutoReload(walletId: string, now = new Date()) {
    const claimed = await prisma.$queryRaw<{ reloadSeq: number }[]>`
      UPDATE "AdWallet"
         SET "reloadInFlight" = true, "reloadSeq" = "reloadSeq" + 1, "reloadStartedAt" = ${now}, "reloadAmountCents" = "autoReloadCents"
       WHERE "id" = ${walletId} AND "autoReloadEnabled" AND NOT "reloadInFlight" AND "paymentMethodId" IS NOT NULL
         AND "autoReloadCents" > 0 AND ("balanceCents" + "bonusCents") < "thresholdCents"
       RETURNING "reloadSeq"`;
    if (!claimed[0]) return { started: false as const };

    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const today = await prisma.walletTxn.count({ where: { walletId, kind: 'TOPUP', source: 'auto', createdAt: { gte: dayStart } } });
    if (today >= reloadMaxPerDay()) {
      await prisma.adWallet.update({ where: { id: walletId }, data: { reloadInFlight: false, reloadLastError: `Auto-reload already ran ${today} times today (limit ${reloadMaxPerDay()})` } });
      return { started: false as const, reason: 'daily_limit' as const };
    }
    return { started: true as const, ...(await this.runReload(walletId, claimed[0].reloadSeq)) };
  }

  /** Charges the saved card for reload #seq. Safe to call again for the same seq (same key). */
  async runReload(walletId: string, seq: number): Promise<{ status: 'credited' | 'processing' | 'failed' | 'unknown'; error?: string }> {
    const w = await prisma.adWallet.findUniqueOrThrow({ where: { id: walletId }, include: { organization: true } });
    if (!w.reloadInFlight || w.reloadSeq !== seq || !w.paymentMethodId) return { status: 'unknown', error: 'not in flight' };
    const provider = getPaymentProvider();
    const amount = w.reloadAmountCents || w.autoReloadCents;
    try {
      const { customerId } = await provider.ensureCustomer({ organizationId: w.organizationId, email: '', customerId: w.organization.billingCustomerId });
      const pi = await provider.chargeSavedCard({
        organizationId: w.organizationId, walletId, customerId, paymentMethodId: w.paymentMethodId, amountCents: amount, currency: w.currency,
        idempotencyKey: `sf-autoreload-${walletId}-${seq}`,
      });
      if (pi.status === 'succeeded') {
        await creditTopUp({ paymentIntentId: pi.paymentIntentId, amountCents: amount, walletId, provider: provider.kind, source: 'auto' });
        await prisma.adWallet.updateMany({ where: { id: walletId, reloadSeq: seq }, data: { reloadInFlight: false } });
        return { status: 'credited' };
      }
      if (pi.status === 'processing') return { status: 'processing' }; // payment_intent.succeeded will credit + release
      // requires_action / requires_payment_method: the bank wants the cardholder present.
      await this.reloadFailed(walletId, seq, 'Your bank asked to confirm this charge. Top up once by hand to re-enable auto-reload.', true);
      return { status: 'failed', error: pi.status };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isDefiniteRejection(e)) {
        await this.reloadFailed(walletId, seq, msg, false);
        return { status: 'failed', error: msg };
      }
      // Timeout / 5xx: the charge may exist. Stay in flight; reconcileReloads retries with the same key.
      await prisma.adWallet.update({ where: { id: walletId }, data: { reloadLastError: `Checking with Stripe: ${msg}`.slice(0, 500) } });
      this.logger.warn(`Auto-reload ${walletId}#${seq} outcome unknown: ${msg}`);
      return { status: 'unknown', error: msg };
    }
  }

  async reloadFailed(walletId: string, seq: number, reason: string, disableNow: boolean) {
    const r = await prisma.adWallet.updateMany({
      where: { id: walletId, reloadSeq: seq, reloadInFlight: true },
      data: { reloadInFlight: false, reloadFailures: { increment: 1 }, reloadLastError: reason.slice(0, 500) },
    });
    if (!r.count) return;
    const w = await prisma.adWallet.findUniqueOrThrow({ where: { id: walletId } });
    if (disableNow || w.reloadFailures >= MAX_RELOAD_FAILURES) {
      await prisma.adWallet.update({ where: { id: walletId }, data: { autoReloadEnabled: false } });
      await this.notifications.notify({
        organizationId: w.organizationId, kind: 'autoreload_off', severity: 'warning',
        title: 'Auto-reload is off',
        body: `We couldn't charge your saved card (${reason}). Ads that run on Ad Fuel pause when it reaches $0. Top up to keep them running.`,
        dedupeKey: `m:autoreload_off:${walletId}:${seq}`,
      });
    }
  }

  /** payment_intent.payment_failed for an auto-reload */
  async reloadPaymentFailed(walletId: string, reason: string) {
    const w = await prisma.adWallet.findUnique({ where: { id: walletId } });
    if (w?.reloadInFlight) await this.reloadFailed(walletId, w.reloadSeq, reason, false);
  }

  /** Reloads stuck in flight (unknown outcome) are retried with their original key. */
  async reconcileReloads(now = new Date(), staleMs = 10 * 60_000) {
    const stuck = await prisma.adWallet.findMany({ where: { reloadInFlight: true, reloadStartedAt: { lt: new Date(now.getTime() - staleMs) } }, take: 50 });
    const out: { walletId: string; status: string }[] = [];
    for (const w of stuck) out.push({ walletId: w.id, status: (await this.runReload(w.id, w.reloadSeq)).status });
    return out;
  }

  /** Ledger page: newest first, with campaign names. */
  async ledger(organizationId: string, take = 100) {
    const w = await this.walletFor(organizationId);
    const txns = await prisma.walletTxn.findMany({ where: { walletId: w.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: Math.min(take, 500) });
    const ids = [...new Set(txns.map((t) => t.campaignId).filter(Boolean))] as string[];
    const names = Object.fromEntries((await prisma.adCampaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    return txns.map((t) => ({ ...t, campaignName: t.campaignId ? names[t.campaignId] ?? null : null }));
  }
}
