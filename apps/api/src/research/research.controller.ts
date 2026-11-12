import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { marginCalc, MarginInputSchema } from '@storeforge/shared';
import { ResearchService } from './research.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';

const RefreshSchema = z.object({ limit: z.number().int().min(1).max(100).optional(), productIds: z.array(z.string().max(64)).max(100).optional() });
/** One batch refresh per account every 30 s (live sources are billed per call). */
const lastRefresh = new Map<string, number>();

@ApiTags('research')
@Controller('research')
@UseGuards(AuthGuard)
export class ResearchController {
  constructor(private readonly research: ResearchService, private readonly auth: AuthService) {}

  @Get('products')
  async list(@CurrentUser() user: { id: string }, @Query('q') q?: string, @Query('category') category?: string, @Query('sort') sort?: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    await this.auth.requireAccountId(user.id);
    return this.research.list({ q, category, sort, take: take ? Number(take) || undefined : undefined, skip: skip ? Number(skip) || 0 : 0 });
  }

  @Get('products/:id')
  async get(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    await this.auth.requireAccountId(user.id);
    return this.research.get(id);
  }

  @Post('products/:id/refresh')
  @HttpCode(200)
  async refreshOne(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    await this.auth.requireAccountId(user.id);
    await this.research.score(id, { force: true });
    return this.research.get(id);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@CurrentUser() user: { id: string }, @Body() body: unknown) {
    const account = await this.auth.requireAccountId(user.id);
    const input = RefreshSchema.parse(body ?? {});
    const last = lastRefresh.get(account) ?? 0;
    if (Date.now() - last < 30_000 && process.env.NODE_ENV !== 'test') return { scored: 0, failed: [], remaining: null, throttled: true };
    lastRefresh.set(account, Date.now());
    return this.research.refreshBatch(input.limit ?? 50, { productIds: input.productIds, force: !!input.productIds });
  }

  /** Same calculator the admin runs in the browser (shared code), for API users. */
  @Post('margin')
  @HttpCode(200)
  margin(@Body() body: unknown) {
    return marginCalc(MarginInputSchema.parse(body));
  }
}
