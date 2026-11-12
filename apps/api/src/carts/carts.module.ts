import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailModule } from '../email/email.module';
import { CartsService } from './carts.service';
import { CartsController } from './carts.controller';
import { CartsSweeper } from './carts.sweeper';

@Module({
  imports: [AuthModule, EmailModule],
  controllers: [CartsController],
  providers: [CartsService, CartsSweeper],
  exports: [CartsService],
})
export class CartsModule {}
