import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DomainsService } from './domains.service';

/**
 * Re-checks due domains every DOMAIN_SWEEP_MS (default 15 s). Runs in-process so it works with or
 * without Redis; rows are claimed with compare-and-set, so several API instances are safe.
 * DOMAIN_SWEEP_MS=0 or NODE_ENV=test disables it.
 */
@Injectable()
export class DomainsSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DomainsSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly domains: DomainsService) {}

  onModuleInit() {
    const ms = Number(process.env.DOMAIN_SWEEP_MS ?? 15000);
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
      await this.domains.sweepDue();
    } catch (e: any) {
      this.logger.warn(`domain sweep: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }
}
