import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { NotifyModule } from '../notify/notify.module';
import { BillingModule } from '../billing/billing.module';
import { AccountingModule } from '../accounting/accounting.module';
import { CommerceModeGuard } from '../../common/guards/commerce-mode.guard';
import { CommerceEngine } from '../commerce/commerce-engine';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { RentalPosService } from './rental-pos.service';
import { SaleReturnsService } from './sale-returns.service';

/** Checkout, sale + rental terminals — FR-POS */
@Module({
  imports: [
    PaymentsModule,
    OrdersModule,
    LoyaltyModule,
    NotifyModule,
    BillingModule,
    AccountingModule,
  ],
  controllers: [PosController],
  providers: [
    PosService,
    RentalPosService,
    SaleReturnsService,
    CommerceEngine,
    CommerceModeGuard,
  ],
  exports: [PosService, RentalPosService, SaleReturnsService, CommerceEngine],
})
export class PosModule {}
