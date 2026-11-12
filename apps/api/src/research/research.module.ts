import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ResearchService } from './research.service';
import { ResearchController } from './research.controller';

@Module({
  imports: [AuthModule],
  controllers: [ResearchController],
  providers: [ResearchService],
  exports: [ResearchService],
})
export class ResearchModule {}
