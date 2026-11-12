import { Controller, Get } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import { getPaymentProvider } from './payments';

@Controller('health')
export class HealthController {
  @Get()
  async health() {
    let db = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      payments: getPaymentProvider().kind,
      paymentsMode: getPaymentProvider().mode(),
      stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      stripeConnectWebhookConfigured: Boolean(process.env.STRIPE_CONNECT_WEBHOOK_SECRET),
      cjConfigured: Boolean(process.env.CJ_API_KEY),
      useFixtures: process.env.USE_CATALOG_FIXTURES !== 'false',
    };
  }
}
