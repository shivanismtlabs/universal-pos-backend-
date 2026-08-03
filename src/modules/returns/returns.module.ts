import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';

/** Returns, inspection fields, cleaning, damage — FR-RTN */
@Module({
  imports: [PaymentsModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
