import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { OrdersModule } from '../orders/orders.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [OrdersModule, BillingModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
