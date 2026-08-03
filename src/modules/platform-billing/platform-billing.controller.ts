import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
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
  @ApiOperation({ summary: 'Create/update current tenant subscription' })
  upsertSubscription(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSubscriptionDto,
  ) {
    return this.platformBillingService.upsertSubscription(user, dto);
  }
}
