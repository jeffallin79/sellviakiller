import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BoostService } from './boost.service';
import { AdWalletService } from './wallet.service';
import { ConversionsService } from './conversions.service';
import { scheduleAdsSync, startAdsWorkers } from '../jobs/queues';
import { ManagedBoostService } from './managed/managed.service';

/**
 * Blueprint queues for Boost:
 *   ads.sync-insights + ads.wallet-debit  every ADS_SYNC_MS (default 1 h): insights → fuel charges
 *   ads.low-fuel                          in-process fuelEvents 'empty' → pause + notify (BoostService.listen)
 *   capi.dispatch                         BullMQ with retries; without Redis, retried here every minute
 *   ads.autoreload reconcile              unknown-outcome reloads re-checked with the same idempotency key
 *   managed Boost (slice 4):
 *     ads.sync-insights (managed)          same cadence: platform insights → spend + 15% fee, ceilings, ladder, runway
 *     ads.reconcile                        daily 02:00 UTC: D-1…D-7 vs platform, drift → adjust (+ alert > 1%)
 *     ads.launch / provision resume        every 30 s: groups stuck LAUNCHING, accounts still provisioning
 *     capi.dispatch (managed)              per-account deliveries retried every minute
 * With Redis the hourly sync is a repeatable job (one schedule across instances); without it, an
 * in-process interval. Every step claims rows, so overlapping runs are safe. Off in NODE_ENV=test.
 */
@Injectable()
export class AdsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdsScheduler.name);
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();
  constructor(private readonly boost: BoostService, private readonly wallet: AdWalletService, private readonly conversions: ConversionsService, private readonly managed: ManagedBoostService) {}

  async onModuleInit() {
    this.managed.listen(); // fuel signals for both modes (managed + connect-your-own)
    if (process.env.NODE_ENV === 'test') return;
    const syncMs = Number(process.env.ADS_SYNC_MS ?? 3_600_000);
    const syncBoth = async () => [...(await this.boost.syncAll()), ...(await this.managed.syncAll())];
    const workers = startAdsWorkers({ capi: (id) => this.conversions.dispatch(id), sync: syncBoth });
    if (syncMs > 0) {
      const q = await scheduleAdsSync(syncMs).catch(() => ({ queued: false }));
      if (!q.queued || !workers) this.every('sync', syncMs, syncBoth);
    }
    this.every('capi-retry', 60_000, () => this.conversions.retryPending());
    this.every('reload-reconcile', 5 * 60_000, () => this.wallet.reconcileReloads());
    this.every('managed-capi', 60_000, () => this.conversions.managed.retryDue());
    this.every('managed-resume', 30_000, async () => [...(await this.managed.provisionPending()), ...(await this.managed.resumeLaunches())]);
    this.dailyAt('ads-reconcile', 2, () => this.managed.reconcile());
  }
  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
  }
  /** Once a day at hh:00 UTC (checked each minute; a run per UTC day per process, and the work itself is idempotent). */
  private dailyAt(name: string, hourUtc: number, fn: () => Promise<unknown>) {
    let lastDay = '';
    this.every(name, 60_000, async () => {
      const now = new Date();
      const d = now.toISOString().slice(0, 10);
      if (now.getUTCHours() !== hourUtc || d === lastDay) return [];
      lastDay = d;
      return fn();
    });
  }
  private every(name: string, ms: number, fn: () => Promise<unknown>) {
    const t = setInterval(() => {
      if (this.busy.has(name)) return;
      this.busy.add(name);
      fn()
        .then((r) => { if (Array.isArray(r) && r.length) this.logger.log(`${name}: ${JSON.stringify(r).slice(0, 500)}`); })
        .catch((e) => this.logger.warn(`${name}: ${e?.message ?? e}`))
        .finally(() => this.busy.delete(name));
    }, ms);
    t.unref();
    this.timers.push(t);
  }
}
