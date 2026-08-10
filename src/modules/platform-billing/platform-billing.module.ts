import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformBillingService } from './platform-billing.service';

/** SaaS plans, subscriptions, Stripe Checkout — FR-PBIL */
@Module({
  imports: [PaymentsModule],
  controllers: [PlatformBillingController],
  providers: [PlatformBillingService],
})
export class PlatformBillingModule {}
