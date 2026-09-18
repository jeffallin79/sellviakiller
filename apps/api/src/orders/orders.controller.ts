import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CheckoutSchema } from '@storeforge/shared';
import { OrdersService } from './orders.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';

@ApiTags('orders')
@Controller()
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly authService: AuthService,
  ) {}

  @Post('checkout')
  async checkout(@Body() body: unknown) {
    const input = CheckoutSchema.parse(body);
    return this.orders.checkout(input);
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
   * Checkout stub (no Square) still marks new orders PAID without this endpoint.
   */
  @Post('orders/:id/stub-pay')
  @UseGuards(AuthGuard)
  async stubPay(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    // Production (and any env) without the explicit flag → 404
    if (process.env.ALLOW_STUB_PAY !== 'true') {
      throw new NotFoundException();
    }
    if (process.env.SQUARE_ACCESS_TOKEN) {
      throw new ForbiddenException('Stub pay disabled when Square is configured');
    }
    const accountId = await this.authService.requireAccountId(user.id);
    await this.orders.getForAccount(accountId, id);
    return this.orders.markPaid(id, `stub_manual_${Date.now()}`);
  }
}
