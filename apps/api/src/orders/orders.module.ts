import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [FulfillmentModule, AuthModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
