import { Controller, Get, Post, Body, Req, Param, Headers, UseGuards, HttpCode, BadRequestException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';
import { FuelService } from './fuel.service';
import { PayoutsService } from './payouts.service';
import { WebhookProcessorService } from './webhook-processor.service';
import { NotificationsService } from './notifications.service';
import { getPaymentProvider, WebhookSignatureError, ProviderNotConfiguredError, type WebhookEndpoint } from './index';

@ApiTags('webhooks')
@Controller('webhooks')
export class StripeWebhooksController {
  private readonly logger = new Logger(StripeWebhooksController.name);
  constructor(private readonly processor: WebhookProcessorService) {}

  /** Platform events: Billing, Checkout, PaymentIntents (Ad Fuel), refunds. */
  @Post('stripe')
  @HttpCode(200)
  platform(@Req() req: Request & { rawBody?: Buffer }, @Headers('stripe-signature') sig?: string) {
    return this.handle(req, sig, 'platform');
  }

  /** Connect events (account.updated etc.) — separate endpoint + signing secret in Stripe. */
  @Post('stripe/connect')
  @HttpCode(200)
  connect(@Req() req: Request & { rawBody?: Buffer }, @Headers('stripe-signature') sig?: string) {
    return this.handle(req, sig, 'connect');
  }

  private async handle(req: Request & { rawBody?: Buffer }, sig: string | undefined, endpoint: WebhookEndpoint) {
    if (!req.rawBody) throw new BadRequestException('Raw body unavailable');
    let event;
    try {
      event = getPaymentProvider().verifyWebhook(req.rawBody, sig, endpoint);
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) throw new ServiceUnavailableException(e.message);
      if (e instanceof WebhookSignatureError) {
        this.logger.warn(`Rejected ${endpoint} webhook: ${e.message}`);
        throw new BadRequestException('Invalid signature');
      }
      throw e;
    }
    return this.processor.process(event, endpoint);
  }
}

@ApiTags('payouts')
@Controller('payouts')
@UseGuards(AuthGuard)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService, private readonly auth: AuthService) {}

  @Get('status')
  async status(@CurrentUser() user: { id: string }) {
    return this.payouts.refresh(await this.auth.requireAccountId(user.id));
  }

  /** Creates the merchant's Express account (once) and returns a Stripe onboarding link. */
  @Post('onboard')
  async onboard(@CurrentUser() user: { id: string; email: string }) {
    return this.payouts.startOnboarding(await this.auth.requireAccountId(user.id), user.email);
  }
}

@ApiTags('ad-fuel')
@Controller('fuel')
@UseGuards(AuthGuard)
export class FuelController {
  constructor(private readonly fuel: FuelService, private readonly auth: AuthService) {}

  @Get()
  async summary(@CurrentUser() user: { id: string }) {
    return this.fuel.summary(await this.auth.requireAccountId(user.id));
  }

  @Post('topups')
  async topUp(@CurrentUser() user: { id: string; email: string }, @Body() body: unknown) {
    const { amountCents, requestId } = z
      .object({ amountCents: z.number().int(), requestId: z.string().min(8).max(64) })
      .parse(body ?? {});
    return this.fuel.startTopUp(await this.auth.requireAccountId(user.id), user.email, amountCents, requestId);
  }

  @Post('refunds')
  async refund(@CurrentUser() user: { id: string }, @Body() body: unknown) {
    const { topupTxnId, amountCents } = z
      .object({ topupTxnId: z.string(), amountCents: z.number().int().positive().optional() })
      .parse(body ?? {});
    return this.fuel.refundTopUp(await this.auth.requireAccountId(user.id), topupTxnId, amountCents);
  }
}

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService, private readonly auth: AuthService) {}

  @Get()
  async list(@CurrentUser() user: { id: string }) {
    return this.notifications.list(await this.auth.requireAccountId(user.id));
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.notifications.markRead(await this.auth.requireAccountId(user.id), id);
  }
}
