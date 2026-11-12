import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailService } from './email.service';
import { EmailController } from './email.controller';

@Module({
  imports: [AuthModule],
  controllers: [EmailController],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
