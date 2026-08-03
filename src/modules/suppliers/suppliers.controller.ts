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
  @ApiOperation({ summary: 'Create purchase / sub-rental / special order' })
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

  @Patch('purchase-orders/:id')
  @ApiOperation({ summary: 'Update PO status / delivery date' })
  updatePo(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    return this.suppliersService.updatePo(user, id, dto);
  }
}
