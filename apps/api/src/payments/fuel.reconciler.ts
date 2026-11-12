import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FuelService } from './fuel.service';

/** Every FUEL_RECONCILE_MS (default 10 min; 0 or NODE_ENV=test disables) confirm pending/unknown refunds. */
@Injectable()
export class FuelReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FuelReconciler.name);
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly fuel: FuelService) {}
  onModuleInit() {
    const ms = Number(process.env.FUEL_RECONCILE_MS ?? 600000);
    if (!ms || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.fuel.reconcilePendingRefunds().then(
        (r) => r.length && this.logger.log(`reconciled ${r.length} fuel refund(s): ${JSON.stringify(r)}`),
        (e) => this.logger.warn(`fuel reconcile: ${e?.message ?? e}`),
      );
    }, ms);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
