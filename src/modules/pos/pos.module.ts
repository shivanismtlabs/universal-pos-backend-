import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { CommerceModeGuard } from '../../common/guards/commerce-mode.guard';
import { CommerceEngine } from '../commerce/commerce-engine';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { RentalPosService } from './rental-pos.service';

/** Checkout, sale + rental terminals — FR-POS */
@Module({
  imports: [PaymentsModule, OrdersModule, LoyaltyModule],
  controllers: [PosController],
  providers: [
    PosService,
    RentalPosService,
    CommerceEngine,
    CommerceModeGuard,
  ],
  exports: [PosService, RentalPosService, CommerceEngine],
})
export class PosModule {}
