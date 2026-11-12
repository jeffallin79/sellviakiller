import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { BillingModule } from '../billing/billing.module';
import { FuelService } from './fuel.service';
import { PayoutsService } from './payouts.service';
import { WebhookProcessorService } from './webhook-processor.service';
import { StripeWebhooksController, PayoutsController, FuelController } from './payments.controller';

@Module({
  imports: [AuthModule, OrdersModule, BillingModule],
  controllers: [StripeWebhooksController, PayoutsController, FuelController],
  providers: [FuelService, PayoutsService, WebhookProcessorService],
  exports: [FuelService, PayoutsService],
})
export class PaymentsModule {}
