import { Module } from '@nestjs/common';
import { PlatformBillingController } from './platform-billing.controller';
import { PlatformBillingService } from './platform-billing.service';

/** SaaS plans, subscriptions, dunning — FR-PBIL */
@Module({
  controllers: [PlatformBillingController],
  providers: [PlatformBillingService],
})
export class PlatformBillingModule {}
