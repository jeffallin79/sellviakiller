import { Controller, Post, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { FulfillmentService } from './fulfillment.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';
import { prisma } from '@storeforge/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

@ApiTags('fulfillment')
@Controller('fulfillment')
export class FulfillmentController {
  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly authService: AuthService,
  ) {}

  @Post('orders/:orderId/approve')
  @UseGuards(AuthGuard)
  async approve(
    @CurrentUser() user: { id: string },
    @Param('orderId') orderId: string,
  ) {
    const accountId = await this.authService.requireAccountId(user.id);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { store: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.store.organizationId !== accountId) throw new ForbiddenException();
    return this.fulfillment.approveAndSubmit(orderId);
  }
}
