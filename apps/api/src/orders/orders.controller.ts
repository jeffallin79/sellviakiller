import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  NotFoundException,
  ForbiddenException,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { CheckoutSchema } from '@storeforge/shared';
import { OrdersService } from './orders.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';
import { isStubPayments } from '../payments';
import { RefundsService } from './refunds.service';
import { z } from 'zod';

const RefundSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.string().max(500).optional(),
  requestId: z.string().min(8).max(100),
});

@ApiTags('orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly authService: AuthService,
    private readonly refunds: RefundsService,
  ) {}

  /** Merchant refund. requestId makes retries idempotent. Customer is emailed when it succeeds. */
  @Post('orders/:id/refunds')
  @UseGuards(AuthGuard)
  async refund(@CurrentUser() user: { id: string }, @Param('id') id: string, @Body() body: unknown) {
    const input = RefundSchema.parse(body);
    return this.refunds.create(await this.authService.requireAccountId(user.id), id, input);
  }

  @Get('orders/:id/refunds')
  @UseGuards(AuthGuard)
  async listRefunds(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.refunds.list(await this.authService.requireAccountId(user.id), id);
  }

  @Post('checkout')
  async checkout(@Body() body: unknown, @Req() req: Request) {
    const input = CheckoutSchema.parse(body);
    // Behind the storefront's same-origin proxy the shopper's address is the first X-Forwarded-For hop.
    // x-sf-client-ip is set by the storefront from its trusted-proxy chain (client-sent values are
    // stripped there). It only feeds Meta match quality, never auth or money. Not present → no IP
    // (the socket here is the storefront, not the shopper).
    const ipHeader = req.headers['x-sf-client-ip'];
    const ip = typeof ipHeader === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(ipHeader) ? ipHeader : null;
    const ua = req.headers['user-agent'];
    return this.orders.checkout(input, { ip, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null });
  }

  @Get('orders')
  @UseGuards(AuthGuard)
  async list(@CurrentUser() user: { id: string }) {
    const accountId = await this.authService.requireAccountId(user.id);
    return this.orders.listForAccount(accountId);
  }

  /** Merchant-only: order must belong to the caller's organization. */
  @Get('orders/:id')
  @UseGuards(AuthGuard)
  async get(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const accountId = await this.authService.requireAccountId(user.id);
    return this.orders.getForAccount(accountId, id);
  }

  /**
   * Local/demo only. Requires ALLOW_STUB_PAY=true and merchant auth.
   * Without the flag (including production), returns 404.
   * Checkout stub (no Stripe keys) still marks new orders PAID without this endpoint.
   */
  @Post('orders/:id/stub-pay')
  @UseGuards(AuthGuard)
  async stubPay(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    // Production (and any env) without the explicit flag → 404
    if (process.env.ALLOW_STUB_PAY !== 'true') {
      throw new NotFoundException();
    }
    if (!isStubPayments()) {
      throw new ForbiddenException('Stub pay disabled when Stripe is configured');
    }
    const accountId = await this.authService.requireAccountId(user.id);
    await this.orders.getForAccount(accountId, id);
    return this.orders.markPaid(id, `stub_manual_${Date.now()}`, 'stub');
  }
}
