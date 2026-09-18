import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { BillingService } from './billing.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';
import type { PlanId } from '@storeforge/shared';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly authService: AuthService,
  ) {}

  @Get('plans')
  plans() {
    return this.billing.listPlans();
  }

  @Post('subscribe')
  @UseGuards(AuthGuard)
  async subscribe(
    @CurrentUser() user: { id: string; email: string },
    @Body() body: unknown,
  ) {
    const schema = z.object({
      planId: z.enum(['starter', 'growth', 'scale']).default('starter'),
    });
    const { planId } = schema.parse(body ?? {});
    const accountId = await this.authService.requireAccountId(user.id);
    return this.billing.subscribe(accountId, user.email, planId as PlanId);
  }

  @Get('subscription')
  @UseGuards(AuthGuard)
  async subscription(@CurrentUser() user: { id: string }) {
    const accountId = await this.authService.requireAccountId(user.id);
    return this.billing.getSubscription(accountId);
  }
}
