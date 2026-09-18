import { Module, forwardRef } from '@nestjs/common';
import { FulfillmentService } from './fulfillment.service';
import { FulfillmentController } from './fulfillment.controller';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SuppliersModule, AuthModule],
  controllers: [FulfillmentController],
  providers: [FulfillmentService],
  exports: [FulfillmentService],
})
export class FulfillmentModule {}
