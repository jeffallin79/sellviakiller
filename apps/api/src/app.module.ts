import { AdsModule } from './ads/ads.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { StoresModule } from './stores/stores.module';
import { CatalogModule } from './catalog/catalog.module';
import { OrdersModule } from './orders/orders.module';
import { FulfillmentModule } from './fulfillment/fulfillment.module';
import { BillingModule } from './billing/billing.module';
import { PaymentsModule } from './payments/payments.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { ExportModule } from './export/export.module';
import { JobsModule } from './jobs/jobs.module';
import { DomainsModule } from './domains/domains.module';
import { EmailModule } from './email/email.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    AdsModule,
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    StoresModule,
    CatalogModule,
    OrdersModule,
    FulfillmentModule,
    BillingModule,
    PaymentsModule,
    SuppliersModule,
    ExportModule,
    JobsModule,
    DomainsModule,
    EmailModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
