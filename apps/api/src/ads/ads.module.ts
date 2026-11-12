import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdWalletService } from './wallet.service';
import { BoostService } from './boost.service';
import { ConversionsService } from './conversions.service';
import { AdsScheduler } from './ads.scheduler';
import { AdFuelController, BoostController, BoostPublicController } from './ads.controller';

/** Phase 1 slice 3: Ad Fuel wallet + Boost (Meta, connect your own) + Conversions API. */
@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [AdFuelController, BoostController, BoostPublicController],
  providers: [
    { provide: AdWalletService, useFactory: () => new AdWalletService() },
    { provide: BoostService, useFactory: (w: AdWalletService) => new BoostService(w), inject: [AdWalletService] },
    { provide: ConversionsService, useFactory: () => new ConversionsService() },
    AdsScheduler,
  ],
  exports: [AdWalletService, BoostService, ConversionsService],
})
export class AdsModule {}
