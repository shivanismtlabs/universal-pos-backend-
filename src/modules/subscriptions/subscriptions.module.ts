import { Module } from '@nestjs/common';
import { ServicesCommerceController } from './services-commerce.controller';
import { ServicesCommerceService } from './services-commerce.service';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

/** Customer memberships + billable services (commerce modes). */
@Module({
  controllers: [SubscriptionsController, ServicesCommerceController],
  providers: [SubscriptionsService, ServicesCommerceService],
  exports: [SubscriptionsService, ServicesCommerceService],
})
export class SubscriptionsModule {}
