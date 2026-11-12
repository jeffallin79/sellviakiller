import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { RefundsService } from './refunds.service';

@Module({
  imports: [FulfillmentModule, AuthModule, EmailModule],
  controllers: [OrdersController],
  providers: [OrdersService, RefundsService],
  exports: [OrdersService, RefundsService],
})
export class OrdersModule {}
