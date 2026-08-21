import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/auth.decorators';
import { QrPlaceOrderDto } from './dto/restaurant.dto';
import { RestaurantGuestService } from './restaurant-guest.service';

@ApiTags('dining-qr')
@Public()
@Controller('public/dining')
export class RestaurantPublicController {
  constructor(private readonly guest: RestaurantGuestService) {}

  @Get('t/:qrToken')
  @ApiOperation({ summary: 'Guest QR table + menu' })
  menu(@Param('qrToken') qrToken: string) {
    return this.guest.menu(qrToken);
  }

  @Post('t/:qrToken/order')
  @ApiOperation({ summary: 'Guest QR place parked order — no stock deduct' })
  place(
    @Param('qrToken') qrToken: string,
    @Body() dto: QrPlaceOrderDto,
  ) {
    return this.guest.placeOrder(qrToken, dto);
  }
}
