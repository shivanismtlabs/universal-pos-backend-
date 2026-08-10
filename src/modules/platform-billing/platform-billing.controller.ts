import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  ConfirmPlanCheckoutDto,
  CreatePlanCheckoutDto,
  CreatePlanDto,
  CreateSubscriptionDto,
} from './dto/platform-billing.dto';
import { PlatformBillingService } from './platform-billing.service';

@ApiTags('platform-billing')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.ownerOnly)
@Controller('platform-billing')
export class PlatformBillingController {
  constructor(
    private readonly platformBillingService: PlatformBillingService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: 'List SaaS plans' })
  listPlans() {
    return this.platformBillingService.listPlans();
  }

  @Post('plans')
  @ApiOperation({ summary: 'Create a SaaS plan (admin stub)' })
  createPlan(@Body() dto: CreatePlanDto) {
    return this.platformBillingService.createPlan(dto);
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Get current tenant subscription' })
  getSubscription(@CurrentUser() user: AuthUser) {
    return this.platformBillingService.getSubscription(user);
  }

  @Post('subscription')
  @ApiOperation({
    summary: 'Activate free plan only (paid plans use /checkout)',
  })
  upsertSubscription(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSubscriptionDto,
  ) {
    return this.platformBillingService.upsertSubscription(user, dto);
  }

  @Post('checkout')
  @ApiOperation({
    summary:
      'Start Stripe Checkout for a paid plan — redirect browser to returned url',
  })
  createCheckout(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePlanCheckoutDto,
  ) {
    return this.platformBillingService.createCheckout(user, dto);
  }

  @Post('checkout/confirm')
  @ApiOperation({
    summary: 'Confirm Stripe Checkout payment and activate plan',
  })
  confirmCheckout(
    @CurrentUser() user: AuthUser,
    @Body() dto: ConfirmPlanCheckoutDto,
  ) {
    return this.platformBillingService.confirmCheckout(user, dto);
  }

  @Get('invoices')
  @ApiOperation({ summary: 'Paid platform billing history for this shop' })
  listInvoices(@CurrentUser() user: AuthUser) {
    return this.platformBillingService.listInvoices(user);
  }

  @Post('subscription/cancel')
  @ApiOperation({ summary: 'Cancel current SaaS subscription' })
  cancel(@CurrentUser() user: AuthUser) {
    return this.platformBillingService.cancelSubscription(user);
  }
}
