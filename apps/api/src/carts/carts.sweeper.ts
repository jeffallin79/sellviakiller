import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CartsService } from './carts.service';

/** Every CART_SWEEP_MS (default 60 s; 0 or NODE_ENV=test disables): due reminders → outbox, stale carts → expired. */
@Injectable()
export class CartsSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartsSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly carts: CartsService) {}
  onModuleInit() {
    const ms = Number(process.env.CART_SWEEP_MS ?? 60000);
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
      const r = await this.carts.sweep();
      const sent = r.reminders.filter((x) => x.result === 'queued').length;
      if (sent || r.expired) this.logger.log(`cart recovery: ${sent} reminder(s) queued, ${r.expired} expired`);
    } catch (e: any) {
      this.logger.warn(`cart sweep: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }
}
