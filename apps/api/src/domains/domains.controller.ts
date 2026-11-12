import { Controller, Get, Post, Delete, Body, Param, Query, UseGuards, NotFoundException, ForbiddenException, HttpCode } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { DomainsService } from './domains.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';

const AddDomainSchema = z.object({ storeId: z.string().min(1), host: z.string().min(3).max(300) });

@ApiTags('domains')
@Controller('domains')
export class DomainsController {
  constructor(private readonly domains: DomainsService, private readonly auth: AuthService) {}

  @Get('config')
  @UseGuards(AuthGuard)
  config() {
    return this.domains.config();
  }

  @Get()
  @UseGuards(AuthGuard)
  async list(@CurrentUser() user: { id: string }, @Query('storeId') storeId?: string) {
    return this.domains.list(await this.auth.requireAccountId(user.id), storeId || undefined);
  }

  @Post()
  @UseGuards(AuthGuard)
  async add(@CurrentUser() user: { id: string }, @Body() body: unknown) {
    const input = AddDomainSchema.parse(body);
    return this.domains.add(await this.auth.requireAccountId(user.id), input.storeId, input.host);
  }

  @Post(':id/check')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async check(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.domains.checkNow(await this.auth.requireAccountId(user.id), id);
  }

  /** Dev only (DOMAIN_DNS_MODE=stub): mark the records as present. */
  @Post(':id/dev/simulate-dns')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async simulate(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.domains.simulateDns(await this.auth.requireAccountId(user.id), id);
  }

  @Post(':id/primary')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async primary(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.domains.makePrimary(await this.auth.requireAccountId(user.id), id);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async remove(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    return this.domains.remove(await this.auth.requireAccountId(user.id), id);
  }

  /**
   * Caddy `on_demand_tls { ask <API>/api/domains/tls-ask?token=… }`. Caddy treats 200 as
   * "issue a cert". If DOMAIN_TLS_ASK_TOKEN is set the token must match.
   */
  @Get('tls-ask')
  async tlsAsk(@Query('domain') domain?: string, @Query('token') token?: string) {
    const want = process.env.DOMAIN_TLS_ASK_TOKEN;
    if (want && token !== want) throw new ForbiddenException();
    if (!domain || !(await this.domains.tlsAllowed(domain))) throw new NotFoundException();
    return { ok: true };
  }
}

/** Public: storefront middleware turns the Host header into a store. */
@ApiTags('storefront')
@Controller('storefront')
export class StorefrontHostController {
  constructor(private readonly domains: DomainsService) {}

  @Get('resolve-host')
  async resolve(@Query('host') host?: string) {
    const r = host ? await this.domains.resolveHost(host) : null;
    if (!r) throw new NotFoundException('No store on this domain');
    return r;
  }
}
