import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreateCouponDto,
  PatchCouponDto,
  ValidateCouponDto,
} from './dto/loyalty.dto';
import { LoyaltyService } from './loyalty.service';

@ApiTags('loyalty')
@ApiBearerAuth('access-token')
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('coupons')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'List discount coupons' })
  list(@CurrentUser() user: AuthUser) {
    return this.loyalty.listCoupons(user);
  }

  @Post('coupons')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Create coupon (P2 loyalty path)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCouponDto) {
    return this.loyalty.createCoupon(user, dto);
  }

  @Patch('coupons/:id')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Enable/disable coupon' })
  patch(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchCouponDto,
  ) {
    return this.loyalty.patchCoupon(user, id, dto);
  }

  @Post('coupons/validate')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Validate coupon for cart subtotal' })
  validate(@CurrentUser() user: AuthUser, @Body() dto: ValidateCouponDto) {
    return this.loyalty.validate(user, dto);
  }
}
