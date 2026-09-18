import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateStoreSchema } from '@storeforge/shared';
import { StoresService } from './stores.service';
import { AuthService } from '../auth/auth.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';

@ApiTags('stores')
@Controller('stores')
export class StoresController {
  constructor(
    private readonly stores: StoresService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  @UseGuards(AuthGuard)
  async create(@CurrentUser() user: { id: string }, @Body() body: unknown) {
    const input = CreateStoreSchema.parse(body);
    const accountId = await this.authService.requireAccountId(user.id);
    return this.stores.create(accountId, input);
  }

  @Get()
  @UseGuards(AuthGuard)
  async list(@CurrentUser() user: { id: string }) {
    const accountId = await this.authService.requireAccountId(user.id);
    return this.stores.listForAccount(accountId);
  }

  @Get('by-slug/:slug')
  async bySlug(@Param('slug') slug: string) {
    return this.stores.getBySlug(slug);
  }

  @Delete(':id')
  @UseGuards(AuthGuard)
  async softDelete(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const accountId = await this.authService.requireAccountId(user.id);
    return this.stores.softDelete(accountId, id);
  }
}
