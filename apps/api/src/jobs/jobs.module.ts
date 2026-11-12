import { Module, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { initQueues, startWorkers } from './queues';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { EmailModule } from '../email/email.module';
import { EmailService } from '../email/email.service';

@Module({
  imports: [forwardRef(() => FulfillmentModule), EmailModule],
})
export class JobsModule implements OnModuleInit {
  constructor(
    @Inject(forwardRef(() => FulfillmentService))
    private readonly fulfillment: FulfillmentService,
    private readonly emails: EmailService,
  ) {}

  async onModuleInit() {
    await initQueues();
    startWorkers({
      route: async (orderId) => { await this.fulfillment.routeOrder(orderId); },
      tracking: (id) => this.fulfillment.pollTracking(id),
      email: (id) => this.emails.send(id),
    });
  }
}
