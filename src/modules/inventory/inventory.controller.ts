import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup, Role } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  AvailabilityQueryDto,
  CreateCategoryDto,
  CreateInventoryUnitDto,
  CreateProductStyleDto,
  CreateRetailSkuDto,
  ListRetailSkusQueryDto,
  ListUnitsQueryDto,
  ReleaseReservationDto,
  ReserveUnitDto,
  TransferStockDto,
  UpdateUnitStatusDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('categories')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Create inventory category' })
  createCategory(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.inventoryService.createCategory(user, dto);
  }

  @Get('categories')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List categories' })
  listCategories(@CurrentUser() user: AuthUser) {
    return this.inventoryService.listCategories(user);
  }

  @Post('product-styles')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Create product style (catalog)' })
  createStyle(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProductStyleDto,
  ) {
    return this.inventoryService.createStyle(user, dto);
  }

  @Get('product-styles')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List product styles' })
  listStyles(@CurrentUser() user: AuthUser) {
    return this.inventoryService.listStyles(user);
  }

  @Get('product-styles/:id')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'Get product style' })
  getStyle(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventoryService.getStyle(user, id);
  }

  @Post('inventory-units')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Create physical inventory unit' })
  createUnit(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateInventoryUnitDto,
  ) {
    return this.inventoryService.createUnit(user, dto);
  }

  @Get('inventory-units')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List units (paginated, filterable)' })
  listUnits(@CurrentUser() user: AuthUser, @Query() query: ListUnitsQueryDto) {
    return this.inventoryService.listUnits(user, query);
  }

  @Get('inventory-units/:id')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'Get unit + active reservations' })
  getUnit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventoryService.getUnit(user, id);
  }

  @Get('inventory/availability')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({
    summary: 'Check units available for date range (no double-booking)',
  })
  availability(
    @CurrentUser() user: AuthUser,
    @Query() query: AvailabilityQueryDto,
  ) {
    return this.inventoryService.checkAvailability(user, query);
  }

  @Post('inventory/reservations')
  @Roles(...RoleGroup.studio, Role.inventory)
  @ApiOperation({
    summary: 'Hold unit for dates (transaction + row lock + overlap check)',
  })
  reserve(@CurrentUser() user: AuthUser, @Body() dto: ReserveUnitDto) {
    return this.inventoryService.reserveUnit(user, dto);
  }

  @Post('inventory/reservations/:id/release')
  @HttpCode(200)
  @Roles(...RoleGroup.studio, Role.inventory)
  @ApiOperation({ summary: 'Cancel a held reservation' })
  release(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReleaseReservationDto,
  ) {
    return this.inventoryService.releaseReservation(user, id, dto);
  }

  @Patch('inventory-units/:id/status')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({
    summary: 'Update unit availability/condition + movement log',
  })
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnitStatusDto,
  ) {
    return this.inventoryService.updateUnitStatus(user, id, dto);
  }

  @Get('inventory-units/:id/movements')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'Unit status movement timeline' })
  movements(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventoryService.listMovements(user, id);
  }

  @Post('retail-skus')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Create a retail (buy, not rent) SKU' })
  createRetailSku(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRetailSkuDto,
  ) {
    return this.inventoryService.createRetailSku(user, dto);
  }

  @Get('retail-skus')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List retail SKUs' })
  listRetailSkus(
    @CurrentUser() user: AuthUser,
    @Query() query: ListRetailSkusQueryDto,
  ) {
    return this.inventoryService.listRetailSkus(user, query);
  }

  @Get('stock-levels')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({
    summary:
      'List quantity stock at a location (any sale product type with trackQty)',
  })
  listStockAtLocation(
    @CurrentUser() user: AuthUser,
    @Query('locationId', ParseUUIDPipe) locationId: string,
    @Query('q') q?: string,
  ) {
    return this.inventoryService.listStockAtLocation(user, locationId, q);
  }

  @Post('stock-transfers')
  @HttpCode(200)
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({
    summary:
      'Transfer quantity-tracked stock between locations (multi-store, business-agnostic)',
  })
  transferStock(
    @CurrentUser() user: AuthUser,
    @Body() dto: TransferStockDto,
  ) {
    return this.inventoryService.transferStock(user, dto);
  }
}
