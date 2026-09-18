import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ExportService } from './export.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';

@ApiTags('export')
@Controller('export')
export class ExportController {
  constructor(
    private readonly exportService: ExportService,
    private readonly authService: AuthService,
  ) {}

  @Get('products.csv')
  @UseGuards(AuthGuard)
  async products(
    @CurrentUser() user: { id: string },
    @Query('storeId') storeId: string | undefined,
    @Res() res: Response,
  ) {
    const accountId = await this.authService.requireAccountId(user.id);
    const csv = await this.exportService.productsCsv(accountId, storeId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
    res.send(csv);
  }

  @Get('orders.csv')
  @UseGuards(AuthGuard)
  async orders(@CurrentUser() user: { id: string }, @Res() res: Response) {
    const accountId = await this.authService.requireAccountId(user.id);
    const csv = await this.exportService.ordersCsv(accountId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
    res.send(csv);
  }
}
