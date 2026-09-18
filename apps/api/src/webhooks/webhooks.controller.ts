import { Controller, Post, Req, Headers, BadRequestException, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { OrdersService } from '../orders/orders.service';
import { BillingService } from '../billing/billing.service';
import { prisma } from '@storeforge/db';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly billing: BillingService,
  ) {}

  @Post('square')
  async square(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-square-hmacsha256-signature') signature?: string,
  ) {
    const body = req.body;
    const secret = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

    if (secret && signature && req.rawBody) {
      const url = `${process.env.BETTER_AUTH_URL ?? 'http://localhost:4000'}/api/webhooks/square`;
      const hmac = createHmac('sha256', secret)
        .update(url + req.rawBody.toString('utf8'))
        .digest('base64');
      const a = Buffer.from(hmac);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new BadRequestException('Invalid Square webhook signature');
      }
    } else if (secret && !signature) {
      this.logger.warn('Square webhook missing signature — rejecting');
      throw new BadRequestException('Missing signature');
    } else {
      this.logger.warn('SQUARE_WEBHOOK_SIGNATURE_KEY not set — accepting unsigned webhook (dev)');
    }

    const type = body?.type as string | undefined;
    const data = body?.data?.object ?? body?.data;

    this.logger.log(`Square webhook: ${type}`);

    // Payment completed
    if (type === 'payment.updated' || type === 'payment.created') {
      const payment = data?.payment ?? data;
      const ref = payment?.order_id ?? payment?.reference_id;
      const status = payment?.status;
      if (status === 'COMPLETED' && ref) {
        const order = await prisma.order.findFirst({
          where: {
            OR: [{ id: String(ref) }, { squareOrderId: String(ref) }],
          },
        });
        if (order && order.status === 'PENDING_PAYMENT') {
          await this.orders.markPaid(order.id, payment.id ?? `sq_${Date.now()}`);
        }
      }
    }

    // Subscription events
    if (type?.startsWith('subscription.')) {
      const sub = data?.subscription ?? data;
      const squareSubId = sub?.id as string | undefined;
      if (squareSubId) {
        const statusMap: Record<string, 'ACTIVE' | 'CANCELLED' | 'PAST_DUE'> = {
          ACTIVE: 'ACTIVE',
          CANCELED: 'CANCELLED',
          DEACTIVATED: 'CANCELLED',
          PAUSED: 'PAST_DUE',
        };
        const mapped = statusMap[sub.status] ?? 'ACTIVE';
        await prisma.subscription.updateMany({
          where: { squareSubscriptionId: squareSubId },
          data: { status: mapped },
        });
      }
    }

    return { received: true, provider: 'square' };
  }
}
