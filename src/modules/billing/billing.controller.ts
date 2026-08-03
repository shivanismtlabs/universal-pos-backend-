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
  CreateOrderFeeDto,
  CreateInvoiceDto,
  CreateLayawayDto,
  UpdateLayawayDto,
  ApplyLateFeeDto,
} from './dto/billing.dto';
import { BillingService } from './billing.service';

@ApiTags('billing')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.finance)
@Controller()
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('orders/:orderId/fees')
  @ApiOperation({ summary: 'Add a late/damage/other fee to an order' })
  createFee(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateOrderFeeDto,
  ) {
    return this.billingService.createFee(user, orderId, dto);
  }

  @Post('orders/:orderId/fees/late')
  @ApiOperation({ summary: 'Auto-calculate late fee from return due date' })
  applyLateFee(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: ApplyLateFeeDto,
  ) {
    return this.billingService.applyLateFee(user, orderId, dto);
  }

  @Get('orders/:orderId/fees')
  @ApiOperation({ summary: 'List fees for an order' })
  listFees(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.billingService.listFees(user, orderId);
  }

  @Post('orders/:orderId/layaway')
  @ApiOperation({ summary: 'Create layaway installment schedule for an order' })
  createLayaway(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateLayawayDto,
  ) {
    return this.billingService.createLayaway(user, orderId, dto);
  }

  @Get('orders/:orderId/layaway')
  @ApiOperation({ summary: 'List layaway installments for an order' })
  listLayaway(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.billingService.listLayaway(user, orderId);
  }

  @Patch('layaway/:id')
  @ApiOperation({ summary: 'Update layaway installment status' })
  updateLayaway(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLayawayDto,
  ) {
    return this.billingService.updateLayaway(user, id, dto);
  }

  @Post('orders/:orderId/invoices')
  @ApiOperation({ summary: 'Generate GST invoice for an order' })
  createInvoice(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.billingService.createInvoice(user, orderId, dto);
  }

  @Get('orders/:orderId/invoices')
  @ApiOperation({ summary: 'List invoices for an order' })
  listInvoices(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.billingService.listInvoices(user, orderId);
  }
}
