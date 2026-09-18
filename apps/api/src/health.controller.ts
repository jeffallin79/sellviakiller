import { Controller, Get } from '@nestjs/common';
import { prisma } from '@storeforge/db';

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
      payments: 'square',
      squareConfigured: Boolean(process.env.SQUARE_ACCESS_TOKEN),
      cjConfigured: Boolean(process.env.CJ_API_KEY),
      useFixtures: process.env.USE_CATALOG_FIXTURES !== 'false',
    };
  }
}
