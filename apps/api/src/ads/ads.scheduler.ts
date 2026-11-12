import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BoostService } from './boost.service';
import { AdWalletService } from './wallet.service';
import { ConversionsService } from './conversions.service';
import { scheduleAdsSync, startAdsWorkers } from '../jobs/queues';

/**
 * Blueprint queues for Boost:
 *   ads.sync-insights + ads.wallet-debit  every ADS_SYNC_MS (default 1 h): insights → fuel charges
 *   ads.low-fuel                          in-process fuelEvents 'empty' → pause + notify (BoostService.listen)
 *   capi.dispatch                         BullMQ with retries; without Redis, retried here every minute
 *   ads.autoreload reconcile              unknown-outcome reloads re-checked with the same idempotency key
 * With Redis the hourly sync is a repeatable job (one schedule across instances); without it, an
 * in-process interval. Every step claims rows, so overlapping runs are safe. Off in NODE_ENV=test.
 */
@Injectable()
export class AdsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdsScheduler.name);
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();
  constructor(private readonly boost: BoostService, private readonly wallet: AdWalletService, private readonly conversions: ConversionsService) {}

  async onModuleInit() {
    this.boost.listen();
    if (process.env.NODE_ENV === 'test') return;
    const syncMs = Number(process.env.ADS_SYNC_MS ?? 3_600_000);
    const workers = startAdsWorkers({ capi: (id) => this.conversions.dispatch(id), sync: () => this.boost.syncAll() });
    if (syncMs > 0) {
      const q = await scheduleAdsSync(syncMs).catch(() => ({ queued: false }));
      if (!q.queued || !workers) this.every('sync', syncMs, () => this.boost.syncAll());
    }
    this.every('capi-retry', 60_000, () => this.conversions.retryPending());
    this.every('reload-reconcile', 5 * 60_000, () => this.wallet.reconcileReloads());
  }
  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t);
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
