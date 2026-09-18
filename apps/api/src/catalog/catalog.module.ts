import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { AuthModule } from '../auth/auth.module';
import { StoresModule } from '../stores/stores.module';

@Module({
  imports: [SuppliersModule, AuthModule, StoresModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
