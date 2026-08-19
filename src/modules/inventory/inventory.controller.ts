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
import {
  CompleteStockCountDto,
  CreateStockCountDto,
  DamageStockDto,
  ListLedgerQueryDto,
  SetReorderDto,
  StockMoveDto,
  UpsertStockCountLinesDto,
} from './dto/inventory-ops.dto';
import { InventoryOpsService } from './inventory-ops.service';
import { InventoryService } from './inventory.service';
import { InventoryLifecycleService } from './inventory-lifecycle.service';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller()
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly ops: InventoryOpsService,
    private readonly lifecycle: InventoryLifecycleService,
  ) {}

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

  @Get('stock-transfers')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List stock transfer history' })
  listStockTransfers(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
  ) {
    return this.inventoryService.listStockTransfers(
      user,
      limit ? Number(limit) : 100,
    );
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

  // ── Inventory operations (stock in/out, ledger, audit, damage, reorder) ─

  @Post('inventory/stock-in')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Stock In — increase sellable qty' })
  stockIn(@CurrentUser() user: AuthUser, @Body() dto: StockMoveDto) {
    return this.ops.stockIn(user, dto);
  }

  @Post('inventory/stock-out')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Stock Out — decrease sellable qty' })
  stockOut(@CurrentUser() user: AuthUser, @Body() dto: StockMoveDto) {
    return this.ops.stockOut(user, dto);
  }

  @Post('inventory/adjust')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Signed stock adjustment' })
  adjust(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      locationId: string;
      stockLevelId?: string;
      productId?: string;
      delta: number;
      reason?: string;
    },
  ) {
    return this.ops.adjust(user, body);
  }

  @Post('inventory/damage')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Move sellable qty to damaged quarantine' })
  markDamaged(@CurrentUser() user: AuthUser, @Body() dto: DamageStockDto) {
    return this.ops.markDamaged(user, dto);
  }

  @Post('inventory/damage/restore')
  @Roles(...RoleGroup.catalogWrite)
  restoreDamaged(@CurrentUser() user: AuthUser, @Body() dto: DamageStockDto) {
    return this.ops.restoreDamaged(user, dto);
  }

  @Patch('inventory/reorder')
  @Roles(...RoleGroup.catalogWrite)
  setReorder(@CurrentUser() user: AuthUser, @Body() dto: SetReorderDto) {
    return this.ops.setReorder(user, dto);
  }

  @Get('inventory/levels')
  @Roles(...RoleGroup.catalogRead)
  listLevels(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('q') q?: string,
    @Query('lowStock') lowStock?: string,
    @Query('includeZero') includeZero?: string,
  ) {
    return this.ops.listLevels(user, {
      locationId,
      q,
      lowStockOnly: lowStock === '1' || lowStock === 'true',
      includeZero: includeZero === '1' || includeZero === 'true',
    });
  }

  @Get('inventory/low-stock')
  @Roles(...RoleGroup.catalogRead)
  lowStock(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.ops.lowStockAlerts(user, locationId);
  }

  @Get('inventory/ledger')
  @Roles(...RoleGroup.catalogRead)
  ledger(
    @CurrentUser() user: AuthUser,
    @Query() query: ListLedgerQueryDto,
  ) {
    return this.ops.listLedger(user, query);
  }

  @Post('inventory/counts')
  @Roles(...RoleGroup.catalogWrite)
  createCount(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStockCountDto,
  ) {
    return this.ops.createCount(user, dto);
  }

  @Get('inventory/counts')
  @Roles(...RoleGroup.catalogRead)
  listCounts(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.ops.listCounts(user, locationId);
  }

  @Get('inventory/counts/:id')
  @Roles(...RoleGroup.catalogRead)
  getCount(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ops.getCount(user, id);
  }

  @Post('inventory/counts/:id/lines')
  @Roles(...RoleGroup.catalogWrite)
  upsertCountLines(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertStockCountLinesDto,
  ) {
    return this.ops.upsertCountLines(user, id, dto.lines);
  }

  @Post('inventory/counts/:id/complete')
  @Roles(...RoleGroup.catalogWrite)
  completeCount(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteStockCountDto,
  ) {
    return this.ops.completeCount(
      user,
      id,
      dto.apply !== false && dto.apply !== 'false',
    );
  }

  @Post('inventory/qty-reservations')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Reserve quantity (does not reduce on-hand)' })
  reserveQty(@CurrentUser() user: AuthUser, @Body() dto: Record<string, unknown>) {
    return this.lifecycle.reserveQty(user, dto as never);
  }

  @Post('inventory/qty-reservations/:id/:action')
  @Roles(...RoleGroup.catalogWrite)
  reservationAction(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: 'release' | 'consume' | 'cancel',
  ) {
    return this.lifecycle.releaseOrConsumeReservation(user, id, action);
  }

  @Post('inventory/transfers')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Create draft stock transfer document' })
  createTransferDoc(
    @CurrentUser() user: AuthUser,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.lifecycle.createTransfer(user, dto as never);
  }

  @Get('inventory/transfers')
  @Roles(...RoleGroup.catalogRead)
  listTransferDocs(@CurrentUser() user: AuthUser) {
    return this.lifecycle.listTransfers(user);
  }

  @Post('inventory/transfers/:id/issue')
  @Roles(...RoleGroup.catalogWrite)
  issueTransfer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lifecycle.issueTransfer(user, id);
  }

  @Post('inventory/transfers/:id/receive')
  @Roles(...RoleGroup.catalogWrite)
  receiveTransfer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: { lines: Array<{ lineId: string; qty: number; damagedQty?: number }> },
  ) {
    return this.lifecycle.receiveTransfer(user, id, dto.lines ?? []);
  }

  @Post('inventory/transfers/:id/cancel')
  @Roles(...RoleGroup.catalogWrite)
  cancelTransfer(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lifecycle.cancelTransfer(user, id);
  }

  @Post('inventory/production/complete')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Atomic BOM consume + finished goods output' })
  completeProduction(
    @CurrentUser() user: AuthUser,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.lifecycle.completeProduction(user, dto as never);
  }

  @Get('inventory/reconcile')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'Ledger vs on-hand vs batch reconciliation' })
  reconcile(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.lifecycle.reconcile(user, locationId);
  }

  @Post('inventory/unit-conversions')
  @Roles(...RoleGroup.catalogWrite)
  upsertConversion(
    @CurrentUser() user: AuthUser,
    @Body() dto: { productId?: string; fromUnit: string; toUnit: string; factor: number },
  ) {
    return this.lifecycle.upsertConversion(user, dto);
  }
}
