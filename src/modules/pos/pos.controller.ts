import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Body,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { CheckoutDto } from './dto/pos.dto';
import { PosService } from './pos.service';

@ApiTags('pos')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.pos)
@Controller('pos')
export class PosController {
  constructor(private readonly posService: PosService) {}

  @Post('checkout')
  @ApiOperation({
    summary: 'Apply payments to an order and optionally mark it ready',
  })
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutDto) {
    return this.posService.checkout(user, dto);
  }

  @Get('orders/:id/receipt')
  @ApiOperation({ summary: 'Printable order receipt' })
  receipt(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.posService.getReceipt(user, id);
  }
}
