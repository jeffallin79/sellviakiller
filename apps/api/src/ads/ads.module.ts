import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdWalletService } from './wallet.service';
import { BoostService } from './boost.service';
import { ConversionsService } from './conversions.service';
import { AdsScheduler } from './ads.scheduler';
import { AdFuelController, BoostController, BoostPublicController, ManagedBoostController } from './ads.controller';
import { ManagedBoostService } from './managed/managed.service';

/** Phase 1 slices 3–4: Ad Fuel wallet, Boost (Meta connect-your-own + managed Meta/Google/TikTok), conversions. */
@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [AdFuelController, BoostController, BoostPublicController, ManagedBoostController],
  providers: [
    { provide: AdWalletService, useFactory: () => new AdWalletService() },
    { provide: BoostService, useFactory: (w: AdWalletService) => new BoostService(w), inject: [AdWalletService] },
    { provide: ConversionsService, useFactory: () => new ConversionsService() },
    { provide: ManagedBoostService, useFactory: (w: AdWalletService, b: BoostService) => new ManagedBoostService(w, b), inject: [AdWalletService, BoostService] },
    AdsScheduler,
  ],
  exports: [AdWalletService, BoostService, ConversionsService, ManagedBoostService],
})
export class AdsModule {}
