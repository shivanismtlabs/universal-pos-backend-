import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

/** Deposits, layaway, late/damage fees, GST invoices — FR-BIL / FR-LOC */
@Module({
  imports: [PaymentsModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
