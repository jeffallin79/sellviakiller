import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { StoresModule } from './stores/stores.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { FulfillmentModule } from './fulfillment/fulfillment.module';
import { BillingModule } from './billing/billing.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { ExportModule } from './export/export.module';
import { JobsModule } from './jobs/jobs.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    StoresModule,
    CatalogModule,
    OrdersModule,
    FulfillmentModule,
    BillingModule,
    WebhooksModule,
    SuppliersModule,
    ExportModule,
    JobsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
