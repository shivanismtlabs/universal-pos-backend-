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
  CreatePurchaseOrderDto,
  CreateSupplierDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from './dto/suppliers.dto';
import { SuppliersService } from './suppliers.service';

@ApiTags('suppliers')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.catalogWrite)
@Controller()
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Post('suppliers')
  @ApiOperation({ summary: 'Create supplier' })
  createSupplier(@CurrentUser() user: AuthUser, @Body() dto: CreateSupplierDto) {
    return this.suppliersService.createSupplier(user, dto);
  }

  @Get('suppliers')
  @ApiOperation({ summary: 'List suppliers' })
  listSuppliers(@CurrentUser() user: AuthUser) {
    return this.suppliersService.listSuppliers(user);
  }

  @Post('purchase-orders')
  @ApiOperation({ summary: 'Create purchase order (optional stock lines)' })
  createPo(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return this.suppliersService.createPo(user, dto);
  }

  @Get('purchase-orders')
  @ApiOperation({ summary: 'List purchase orders' })
  listPos(@CurrentUser() user: AuthUser) {
    return this.suppliersService.listPos(user);
  }

  @Get('purchase-orders/:id')
  @ApiOperation({ summary: 'Get purchase order with lines' })
  getPo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.suppliersService.getPo(user, id);
  }

  @Patch('purchase-orders/:id')
  @ApiOperation({ summary: 'Update PO status / delivery (not receive)' })
  updatePo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    return this.suppliersService.updatePo(user, id, dto);
  }

  @Post('purchase-orders/:id/receive')
  @ApiOperation({
    summary: 'Receive goods — increments StockLevel qty on the shelf',
  })
  receivePo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceivePurchaseOrderDto,
  ) {
    return this.suppliersService.receivePo(user, id, dto);
  }
}
