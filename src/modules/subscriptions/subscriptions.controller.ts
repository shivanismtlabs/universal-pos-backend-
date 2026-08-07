import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreatePlanDto,
  EnrollSubscriptionDto,
  ListSubscriptionsQueryDto,
  RenewSubscriptionDto,
  UpdatePlanDto,
} from './dto/subscriptions.dto';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('subscriptions')
@ApiBearerAuth('access-token')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get('summary')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Subscription floor KPI counts' })
  summary(@CurrentUser() user: AuthUser) {
    return this.subscriptions.summary(user);
  }

  @Get('plans')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List shop membership plans' })
  listPlans(@CurrentUser() user: AuthUser) {
    return this.subscriptions.listPlans(user);
  }

  @Post('plans')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Create a membership plan product' })
  createPlan(@CurrentUser() user: AuthUser, @Body() dto: CreatePlanDto) {
    return this.subscriptions.createPlan(user, dto);
  }

  @Patch('plans/:id')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Update plan price / period / active' })
  updatePlan(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.subscriptions.updatePlan(user, id, dto);
  }

  @Get()
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'List customer memberships' })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListSubscriptionsQueryDto,
  ) {
    return this.subscriptions.listMembers(user, query);
  }

  @Post('enroll')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Enroll customer in a plan (charge + activate)' })
  enroll(@CurrentUser() user: AuthUser, @Body() dto: EnrollSubscriptionDto) {
    return this.subscriptions.enroll(user, dto);
  }

  @Post(':id/renew')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Renew membership for another billing period' })
  renew(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenewSubscriptionDto,
  ) {
    return this.subscriptions.renew(user, id, dto);
  }

  @Post(':id/cancel')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Cancel an active membership' })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subscriptions.cancel(user, id);
  }
}
