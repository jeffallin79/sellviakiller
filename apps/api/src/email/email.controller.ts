import { Controller, Get, Post, Param, Query, UseGuards, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EmailService } from './email.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';
import { getEmailTransport } from './transport';

@ApiTags('emails')
@Controller('emails')
@UseGuards(AuthGuard)
export class EmailController {
  constructor(private readonly emails: EmailService, private readonly auth: AuthService) {}

  @Get()
  async list(@CurrentUser() user: { id: string }, @Query('storeId') storeId?: string, @Query('orderId') orderId?: string) {
    const items = await this.emails.list(await this.auth.requireAccountId(user.id), { storeId, orderId });
    return { transport: getEmailTransport().kind, fromAddress: process.env.EMAIL_FROM_ADDRESS ?? 'orders@storeforge.local', items };
  }

  @Get(':id')
  async get(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.emails.get(await this.auth.requireAccountId(user.id), id);
  }

  /** Rendered HTML for the admin preview iframe (sandboxed there). */
  @Get(':id/html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors 'none'")
  async html(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return (await this.emails.get(await this.auth.requireAccountId(user.id), id)).html;
  }

  @Post(':id/retry')
  async retry(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.emails.retry(await this.auth.requireAccountId(user.id), id);
  }
}
