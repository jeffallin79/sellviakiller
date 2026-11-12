import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrdersModule } from '../orders/orders.module';
import { BillingModule } from '../billing/billing.module';
import { FuelService } from './fuel.service';
import { PayoutsService } from './payouts.service';
import { WebhookProcessorService } from './webhook-processor.service';
import { NotificationsService } from './notifications.service';
import { DisputesService } from './disputes.service';
import { FuelReconciler } from './fuel.reconciler';
import { StripeWebhooksController, PayoutsController, FuelController, NotificationsController } from './payments.controller';

@Module({
  imports: [AuthModule, OrdersModule, BillingModule],
  controllers: [StripeWebhooksController, PayoutsController, FuelController, NotificationsController],
  providers: [FuelService, PayoutsService, WebhookProcessorService, NotificationsService, DisputesService, FuelReconciler],
  exports: [FuelService, PayoutsService, NotificationsService],
})
export class PaymentsModule {}
