import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { RefundsService } from './refunds.service';
import { EmailService } from '../email/email.service';

/**
 * Crash recovery, every ORDER_SWEEP_MS (default 60 s; 0 or NODE_ENV=test disables):
 *   - PAID orders with no fulfilment → route (and missing confirmation emails → outbox)
 *   - QUEUED emails nobody is delivering → send
 *   - order refunds stuck pending/unknown → reconcile against Stripe (every 5th tick)
 * All steps are idempotent and claim rows, so several API instances may run it.
 */
@Injectable()
export class OrdersSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrdersSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;
  constructor(private readonly orders: OrdersService, private readonly refunds: RefundsService, private readonly emails: EmailService) {}

  onModuleInit() {
    const ms = Number(process.env.ORDER_SWEEP_MS ?? 60000);
    if (!ms || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const p = await this.orders.sweepPaid();
      if (p.routed.length || p.confirmed.length) this.logger.warn(`recovered orders: routed ${p.routed.join(',') || '-'}; confirmation queued ${p.confirmed.join(',') || '-'}`);
      const e = await this.emails.sweepOutbox();
      if (e.length) this.logger.log(`outbox: resent ${e.length}`);
      if (this.ticks++ % 5 === 0) {
        const r = await this.refunds.reconcileStuck();
        if (r.length) this.logger.log(`reconciled ${r.length} order refund(s): ${JSON.stringify(r)}`);
      }
    } catch (err: any) {
      this.logger.warn(`order sweep: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
