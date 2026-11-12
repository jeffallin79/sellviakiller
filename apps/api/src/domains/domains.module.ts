import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DomainsService } from './domains.service';
import { DomainsSweeper } from './domains.sweeper';
import { DomainsController, StorefrontHostController } from './domains.controller';

@Module({
  imports: [AuthModule],
  controllers: [DomainsController, StorefrontHostController],
  providers: [DomainsService, DomainsSweeper],
  exports: [DomainsService],
})
export class DomainsModule {}
