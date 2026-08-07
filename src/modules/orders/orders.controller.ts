import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  CreateOrderDto,
  CreateOrderItemDto,
  ListOrdersQueryDto,
  UpdateOrderDto,
  UpdateOrderStatusDto,
  UpdateRentalLifecycleDto,
} from './dto/orders.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.orders)
@Controller()
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('orders')
  @ApiOperation({ summary: 'Create a rental order (quote)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(user, dto);
  }

  @Get('orders')
  @ApiOperation({ summary: 'List / search orders (paginated)' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListOrdersQueryDto) {
    return this.ordersService.list(user, query);
  }

  @Get('orders/:id')
  @ApiOperation({
    summary: 'Get order with items, payments, fees and customer',
  })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ordersService.getById(user, id);
  }

  @Patch('orders/:id')
  @ApiOperation({ summary: 'Update order dates / party' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.ordersService.update(user, id, dto);
  }

  @Post('orders/:id/items')
  @ApiOperation({ summary: 'Add a line item to an order' })
  addItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateOrderItemDto,
  ) {
    return this.ordersService.addItem(user, id, dto);
  }

  @Delete('orders/:id/items/:itemId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove a line item from an order' })
  removeItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.ordersService.removeItem(user, id, itemId);
  }

  @Post('orders/:id/status')
  @HttpCode(200)
  @ApiOperation({ summary: 'Transition Core order status' })
  changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    return this.ordersService.changeStatus(user, id, dto);
  }

  @Post('orders/:id/rental-lifecycle')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Advance rental module lifecycle (quote→reserved→checked_out→returned…)',
  })
  changeRentalLifecycle(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRentalLifecycleDto,
  ) {
    return this.ordersService.changeRentalLifecycle(user, id, dto);
  }
}
