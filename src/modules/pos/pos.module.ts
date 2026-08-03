import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';

/** Checkout, split pay, cash/UPI/card — FR-POS */
@Module({
  imports: [PaymentsModule],
  controllers: [PosController],
  providers: [PosService],
  exports: [PosService],
})
export class PosModule {}
