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
  IssueGiftCardDto,
  LookupGiftCardDto,
  PatchCouponDto,
  PatchGiftCardDto,
  PatchLoyaltySettingsDto,
  QuoteLoyaltyRedeemDto,
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
  @ApiOperation({ summary: 'Create coupon' })
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

  @Get('settings')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Loyalty points settings' })
  settings(@CurrentUser() user: AuthUser) {
    return this.loyalty.getLoyaltySettings(user);
  }

  @Patch('settings')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Update loyalty points settings' })
  patchSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: PatchLoyaltySettingsDto,
  ) {
    return this.loyalty.patchLoyaltySettings(user, dto);
  }

  @Post('points/quote')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Quote loyalty points redemption' })
  quotePoints(
    @CurrentUser() user: AuthUser,
    @Body() dto: QuoteLoyaltyRedeemDto,
  ) {
    return this.loyalty.quoteRedeem(user, dto);
  }

  @Get('gift-cards')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'List gift cards' })
  listCards(@CurrentUser() user: AuthUser) {
    return this.loyalty.listGiftCards(user);
  }

  @Post('gift-cards')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Issue a gift card' })
  issueCard(@CurrentUser() user: AuthUser, @Body() dto: IssueGiftCardDto) {
    return this.loyalty.issueGiftCard(user, dto);
  }

  @Post('gift-cards/lookup')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Lookup gift card by code' })
  lookupCard(@CurrentUser() user: AuthUser, @Body() dto: LookupGiftCardDto) {
    return this.loyalty.lookupGiftCard(user, dto.code);
  }

  @Patch('gift-cards/:id')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Enable/disable gift card' })
  patchCard(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchGiftCardDto,
  ) {
    return this.loyalty.patchGiftCard(user, id, dto);
  }
}
