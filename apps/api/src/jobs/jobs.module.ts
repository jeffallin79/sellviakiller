import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { initQueues, startWorkers } from './queues';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { FulfillmentService } from '../fulfillment/fulfillment.service';

@Module({
  imports: [forwardRef(() => FulfillmentModule)],
})
export class JobsModule implements OnModuleInit {
  constructor(
    @Inject(forwardRef(() => FulfillmentService))
    private readonly fulfillment: FulfillmentService,
  ) {}

  async onModuleInit() {
    await initQueues();
    startWorkers({
      route: async (orderId) => { await this.fulfillment.routeOrder(orderId); },
      tracking: (id) => this.fulfillment.pollTracking(id),
    });
  }
}
