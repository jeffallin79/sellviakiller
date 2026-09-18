import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ImportProductsSchema } from '@storeforge/shared';
import { CatalogService } from './catalog.service';
import { AuthGuard } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user';
import { AuthService } from '../auth/auth.service';
import { StoresService } from '../stores/stores.service';

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly authService: AuthService,
    private readonly stores: StoresService,
  ) {}

  @Get('catalog/products')
  @UseGuards(AuthGuard)
  list(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.catalog.listProducts({
      q,
      category,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Post('catalog/sync')
  @UseGuards(AuthGuard)
  sync(@Query('supplier') supplier?: string) {
    return this.catalog.syncFromSupplier(supplier ?? 'cj');
  }

  @Post('stores/:storeId/import')
  @UseGuards(AuthGuard)
  async import(
    @CurrentUser() user: { id: string },
    @Param('storeId') storeId: string,
    @Body() body: unknown,
  ) {
    const accountId = await this.authService.requireAccountId(user.id);
    await this.stores.assertOwned(accountId, storeId);
    const input = ImportProductsSchema.parse(body);
    return this.catalog.importToStore(storeId, input);
  }

  @Get('storefront/:slug/products')
  storefrontProducts(@Param('slug') slug: string) {
    return this.catalog.listStoreProducts(slug);
  }
}
