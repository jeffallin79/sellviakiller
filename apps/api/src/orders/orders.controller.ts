import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
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

  @Get('orders/:id')
  async get(@Param('id') id: string) {
    return this.orders.get(id);
  }

  @Post('orders/:id/stub-pay')
  async stubPay(@Param('id') id: string) {
    if (process.env.SQUARE_ACCESS_TOKEN) {
      return { error: 'Stub pay disabled when Square is configured' };
    }
    return this.orders.markPaid(id, `stub_manual_${Date.now()}`);
  }
}
