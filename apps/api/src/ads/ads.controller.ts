import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';
import { FuelService } from '../payments/fuel.service';
import { AdWalletService } from './wallet.service';
import { BoostService } from './boost.service';
import { ConversionsService } from './conversions.service';
import { adminUrl } from './ads.config';
import { prisma } from '@storeforge/db';

type U = { id: string; email: string };
const StoreQ = z.object({ storeId: z.string().min(1) });

/** Ad Fuel wallet: overview, Checkout top-up, auto-reload settings (refunds: POST /fuel/refunds). */
@ApiTags('ad-fuel')
@Controller('fuel')
@UseGuards(AuthGuard)
export class AdFuelController {
  constructor(private readonly auth: AuthService, private readonly wallet: AdWalletService, private readonly fuel: FuelService) {}

  @Get('wallet')
  async overview(@CurrentUser() u: U) {
    return this.wallet.overview(await this.auth.requireAccountId(u.id));
  }

  /** Stripe Checkout (saves the card for auto-reload). Stub mode credits immediately. */
  @Post('checkout')
  async checkout(@CurrentUser() u: U, @Body() body: unknown) {
    const { amountCents, requestId } = z.object({ amountCents: z.number().int(), requestId: z.string().min(8).max(64) }).parse(body ?? {});
    return this.fuel.startTopUpCheckout(await this.auth.requireAccountId(u.id), u.email, amountCents, requestId, `${adminUrl()}/fuel`);
  }

  @Post('settings')
  async settings(@CurrentUser() u: U, @Body() body: unknown) {
    const s = z.object({ autoReloadEnabled: z.boolean(), thresholdCents: z.number().int().min(0), autoReloadCents: z.number().int().min(0) }).parse(body ?? {});
    const org = await this.auth.requireAccountId(u.id);
    await this.wallet.updateSettings(org, s);
    return this.wallet.overview(org);
  }
}

const CampaignSchema = z.object({
  storeId: z.string().min(1),
  storeProductId: z.string().min(1),
  dailyBudgetCents: z.number().int(),
  requestId: z.string().min(8).max(100),
  headline: z.string().max(40).optional(),
  body: z.string().max(125).optional(),
  countries: z.array(z.string().length(2)).min(1).max(25).optional(),
});

/** Boost: Meta "connect your own" (admin, signed in). */
@ApiTags('boost')
@Controller('boost')
@UseGuards(AuthGuard)
export class BoostController {
  constructor(private readonly auth: AuthService, private readonly boost: BoostService, private readonly conversions: ConversionsService) {}

  @Get()
  async overview(@CurrentUser() u: U, @Query() q: unknown) {
    const { storeId } = StoreQ.parse(q);
    return this.boost.overview(await this.auth.requireAccountId(u.id), storeId);
  }

  @Post('meta/connect')
  async connect(@CurrentUser() u: U, @Body() body: unknown) {
    const { storeId } = StoreQ.parse(body ?? {});
    return this.boost.startConnect(await this.auth.requireAccountId(u.id), u.id, storeId);
  }

  @Get('meta/options')
  async options(@CurrentUser() u: U, @Query() q: unknown) {
    const { storeId, adAccountId } = StoreQ.extend({ adAccountId: z.string().optional() }).parse(q);
    return this.boost.options(await this.auth.requireAccountId(u.id), storeId, adAccountId);
  }

  @Post('meta/account')
  async select(@CurrentUser() u: U, @Body() body: unknown) {
    const b = StoreQ.extend({ adAccountId: z.string().min(1), pageId: z.string().min(1), pixelId: z.string().min(1), testEventCode: z.string().max(40).nullish() }).parse(body ?? {});
    return this.boost.selectAccount(await this.auth.requireAccountId(u.id), b.storeId, b);
  }

  @Post('meta/test-code')
  async testCode(@CurrentUser() u: U, @Body() body: unknown) {
    const b = StoreQ.extend({ code: z.string().max(40).nullable() }).parse(body ?? {});
    return this.boost.setTestEventCode(await this.auth.requireAccountId(u.id), b.storeId, b.code);
  }

  @Post('meta/disconnect')
  async disconnect(@CurrentUser() u: U, @Body() body: unknown) {
    const { storeId } = StoreQ.parse(body ?? {});
    return this.boost.disconnect(await this.auth.requireAccountId(u.id), storeId);
  }

  @Post('campaigns')
  async create(@CurrentUser() u: U, @Body() body: unknown) {
    return this.boost.createCampaign(await this.auth.requireAccountId(u.id), CampaignSchema.parse(body ?? {}));
  }

  @Post('campaigns/:id/pause')
  async pause(@CurrentUser() u: U, @Param('id') id: string) {
    return this.boost.pause(await this.auth.requireAccountId(u.id), id);
  }

  @Post('campaigns/:id/resume')
  async resume(@CurrentUser() u: U, @Param('id') id: string) {
    return this.boost.resume(await this.auth.requireAccountId(u.id), id);
  }

  /** "Refresh": pull insights + charge fuel for this store's campaigns now. */
  @Post('sync')
  async sync(@CurrentUser() u: U, @Body() body: unknown) {
    const { storeId } = StoreQ.parse(body ?? {});
    const org = await this.auth.requireAccountId(u.id);
    const ids = await prisma.adCampaign.findMany({ where: { storeId, store: { organizationId: org }, externalId: { not: null }, launchedAt: { not: null } }, select: { id: true } });
    const out = [];
    for (const c of ids) out.push(await this.boost.syncCampaign(c.id).catch((e: any) => ({ error: String(e?.message ?? e) })));
    return { synced: out.length, overview: await this.boost.overview(org, storeId) };
  }

  @Get('events')
  async events(@CurrentUser() u: U, @Query() q: unknown) {
    const { storeId } = StoreQ.parse(q);
    const org = await this.auth.requireAccountId(u.id);
    return { testEvents: await this.boost.testEvents(org, storeId), server: await this.conversions.list(org, storeId) };
  }
}

/** Public endpoints: Facebook's OAuth redirect and the storefront Pixel. */
@ApiTags('boost')
@Controller()
export class BoostPublicController {
  constructor(private readonly boost: BoostService, private readonly conversions: ConversionsService) {}

  @Get('boost/meta/callback')
  async callback(@Query() q: Record<string, string>, @Res() res: Response) {
    res.redirect(302, await this.boost.callback(q));
  }

  @Get('storefront/stores/:storeId/pixel')
  async storePixel(@Param('storeId') storeId: string) {
    return (await this.conversions.pixelForStore(storeId)) ?? { pixelId: null };
  }

  @Get('storefront/orders/:id/pixel')
  async orderPixel(@Param('id') id: string) {
    return this.conversions.pixelForOrder(id);
  }

  /** Stub mode only (404 otherwise): the storefront's stand-in Pixel. */
  @Post('storefront/stub-pixel')
  @HttpCode(202)
  async stubPixel(@Body() body: unknown) {
    const b = z.object({ pixelId: z.string().regex(/^\d{6,20}$/), eventName: z.enum(['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase']), eventId: z.string().max(100).optional() }).parse(body ?? {});
    const acct = await prisma.adAccount.findFirst({ where: { pixelId: b.pixelId, status: 'active' } });
    return this.conversions.recordStubBrowserEvent({ ...b, eventId: b.eventId ?? `${b.eventName}_${Date.now()}` }, acct?.testEventCode ?? null);
  }
}
