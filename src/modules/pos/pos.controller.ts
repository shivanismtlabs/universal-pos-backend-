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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CommerceModeGuard,
  RequireCommerceModes,
} from '../../common/guards/commerce-mode.guard';
import { RegisterCashMovementKind } from '@prisma/client';
import { Role, RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  AddRentalProductDto,
  AddRentalUnitDto,
  AddSaleCategoryDto,
  AddSaleProductDto,
  AdjustSaleStockDto,
  CheckoutDto,
  CloseRegisterDto,
  RegisterCashMovementDto,
  OpenRegisterDto,
  ParkSaleDto,
  PrepareSaleCheckoutDto,
  RenameSaleCategoryDto,
  RentalExchangeDto,
  ExtendRentalDto,
  SaleCheckoutDto,
  SaleReturnDto,
  SaleExchangeDto,
  CreateRefundReasonDto,
  ListSaleReturnsQueryDto,
  RejectSaleReturnDto,
  UpdateRentalProductDto,
  UpdateRentalUnitDto,
  RemoveSaleImageDto,
  UpdateSaleProductDto,
  UploadSaleImageDto,
} from './dto/pos.dto';
import { ImportSaleProductsDto } from './dto/import-sale-products.dto';
import { PosService } from './pos.service';
import { RentalPosService } from './rental-pos.service';
import { SaleReturnsService } from './sale-returns.service';

@ApiTags('pos')
@ApiBearerAuth('access-token')
@Controller('pos')
export class PosController {
  constructor(
    private readonly posService: PosService,
    private readonly rentalPos: RentalPosService,
    private readonly saleReturns: SaleReturnsService,
  ) {}

  @Get('sale/schema')
  @UseGuards(CommerceModeGuard)
  @RequireCommerceModes('sale')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({
    summary:
      'Universal Sale product keys — same for every Sale shop (title, category, sku, price, qty…)',
  })
  saleSchema() {
    return this.posService.saleSchema();
  }

  @Get('sale/floor')
  @UseGuards(CommerceModeGuard)
  @RequireCommerceModes('sale')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({
    summary: 'Sale POS floor: schema + categories + in-stock items',
  })
  saleFloor(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.posService.saleFloor(user, locationId);
  }

  @Get('sale/categories')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({ summary: 'List sale categories with product counts' })
  listSaleCategories(@CurrentUser() user: AuthUser) {
    return this.posService.listSaleCategories(user);
  }

  @Post('sale/categories')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Add category from Sale POS (universal)' })
  addSaleCategory(
    @CurrentUser() user: AuthUser,
    @Body() dto: AddSaleCategoryDto,
  ) {
    return this.posService.addSaleCategory(user, dto);
  }

  @Patch('sale/categories/:id')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Rename a sale category' })
  renameSaleCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameSaleCategoryDto,
  ) {
    return this.posService.renameSaleCategory(user, id, dto);
  }

  @Get('sale/products')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({
    summary: 'List all sale products (incl. zero stock) for manage + sell',
  })
  listSaleProducts(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    return this.posService.listSaleProducts(user, {
      locationId,
      q,
      categoryId,
    });
  }

  @Get('sale/products/:id')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({ summary: 'Get one sale product by stock-level id' })
  getSaleProduct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.posService.getSaleProduct(user, id);
  }

  @Post('sale/products')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({
    summary:
      'Add sale product with universal keys (title, description, category, sku, price, qty)',
  })
  addSaleProduct(
    @CurrentUser() user: AuthUser,
    @Body() dto: AddSaleProductDto,
  ) {
    return this.posService.addSaleProduct(user, dto);
  }

  @Post('sale/products/import')
  @Roles(...RoleGroup.catalogWrite)
  @UseGuards(CommerceModeGuard)
  @RequireCommerceModes('sale')
  @ApiOperation({
    summary:
      'Bulk import sale items (CSV upload rows) — universal catalog, any industry',
  })
  importSaleProducts(
    @CurrentUser() user: AuthUser,
    @Body() dto: ImportSaleProductsDto,
  ) {
    return this.posService.importSaleProducts(user, dto);
  }

  @Patch('sale/products/:id')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({
    summary: 'Update sale product (title, desc, category, price, qty, active)',
  })
  updateSaleProduct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSaleProductDto,
  ) {
    return this.posService.updateSaleProduct(user, id, dto);
  }

  @Post('sale/products/:id/image')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({
    summary: 'Add product image to gallery (JPEG/PNG/WebP/GIF, max 4MB, up to 8)',
  })
  uploadSaleProductImage(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadSaleImageDto,
  ) {
    return this.posService.uploadSaleProductImage(user, id, dto);
  }

  @Post('sale/products/:id/image/remove')
  @Roles(...RoleGroup.catalogWrite)
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove one image from product gallery' })
  removeSaleProductImage(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoveSaleImageDto,
  ) {
    return this.posService.removeSaleProductImage(user, id, dto.imageUrl);
  }

  @Post('sale/products/:id/adjust-stock')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Restock or reduce qty (delta +/-)' })
  adjustSaleStock(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustSaleStockDto,
  ) {
    return this.posService.adjustSaleStock(user, id, dto);
  }

  @Get('sale/stock-adjustments')
  @Roles(...RoleGroup.catalogWrite, Role.inventory)
  @UseGuards(CommerceModeGuard)
  @RequireCommerceModes('sale')
  @ApiOperation({
    summary: 'List stock quantity adjustments (Zoho Adjustments history)',
  })
  listSaleStockAdjustments(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
  ) {
    return this.posService.listSaleStockAdjustments(
      user,
      limit ? Number(limit) : undefined,
    );
  }

  @Get('sale/recent')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Recent closed sale tickets' })
  listRecentSales(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
  ) {
    return this.posService.listRecentSales(
      user,
      limit ? Number(limit) : undefined,
    );
  }

  @Get('sale/catalog')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({
    summary: 'Sale POS catalog — in-stock retail SKUs at a location',
  })
  saleCatalog(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
    @Query('lowStock') lowStock?: string,
    @Query('maxQty') maxQty?: string,
    @Query('forPurchase') forPurchase?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    return this.posService.saleCatalog(user, {
      locationId,
      q,
      limit: limit ? Number(limit) : undefined,
      page: page ? Number(page) : undefined,
      lowStock: lowStock === '1' || lowStock === 'true',
      maxQty: maxQty ? Number(maxQty) : undefined,
      forPurchase: forPurchase === '1' || forPurchase === 'true',
      categoryId,
    });
  }

  @Get('sale/lookup')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({
    summary: 'Sale POS — exact SKU / barcode lookup for scan',
  })
  saleLookup(
    @CurrentUser() user: AuthUser,
    @Query('sku') sku: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.posService.saleLookup(user, { sku: sku ?? '', locationId });
  }

  @Post('sale/checkout')
  @Roles(...RoleGroup.pos)
  @ApiOperation({
    summary:
      'Atomic retail sale: create order + stock + payment + close (one call)',
  })
  @UseGuards(CommerceModeGuard)
  @RequireCommerceModes('sale')
  saleCheckout(@CurrentUser() user: AuthUser, @Body() dto: SaleCheckoutDto) {
    return this.posService.saleCheckout(user, dto);
  }

  @Post('sale/prepare')
  @UseGuards(CommerceModeGuard)
  @RequireCommerceModes('sale')
  @Roles(...RoleGroup.pos)
  @ApiOperation({
    summary:
      'Prepare unpaid sale ticket for Stripe card/UPI (stock commits on verify)',
  })
  prepareSale(
    @CurrentUser() user: AuthUser,
    @Body() dto: PrepareSaleCheckoutDto,
  ) {
    return this.posService.prepareSaleCheckout(user, dto);
  }

  @Post('sale/prepare/:id/cancel')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Cancel unpaid Stripe sale ticket' })
  cancelPreparedSale(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.posService.cancelPreparedSale(user, id);
  }

  @Post('sale/prepare/:id/finalize')
  @Roles(...RoleGroup.pos)
  @ApiOperation({
    summary: 'After Stripe verify — commit stock and close sale',
  })
  finalizePreparedSale(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.posService.finalizeStripeSale(user, id);
  }

  @Post('sale/park')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Park / hold sale cart (no stock decrement)' })
  parkSale(@CurrentUser() user: AuthUser, @Body() dto: ParkSaleDto) {
    return this.posService.parkSale(user, dto);
  }

  @Get('sale/parked')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'List parked sales' })
  listParked(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.posService.listParkedSales(user, locationId);
  }

  @Post('sale/parked/:id/resume')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Resume parked sale → cart payload' })
  resumeParked(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.posService.resumeParkedSale(user, id);
  }

  @Post('sale/parked/:id/discard')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Discard parked sale' })
  discardParked(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.posService.discardParkedSale(user, id);
  }

  @Post('sale/register/open')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Open register / cash drawer shift' })
  openRegister(@CurrentUser() user: AuthUser, @Body() dto: OpenRegisterDto) {
    return this.posService.openRegister(user, dto);
  }

  @Get('sale/register/current')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Current open register at location' })
  currentRegister(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.posService.currentRegister(user, locationId);
  }

  @Post('sale/register/:id/cash-in')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Record cash in (paid into drawer)' })
  cashIn(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegisterCashMovementDto,
  ) {
    return this.posService.addRegisterCashMovement(
      user,
      id,
      RegisterCashMovementKind.cash_in,
      dto.amount,
      dto.note,
    );
  }

  @Post('sale/register/:id/cash-drop')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Record cash drop (removed from drawer)' })
  cashDrop(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegisterCashMovementDto,
  ) {
    return this.posService.addRegisterCashMovement(
      user,
      id,
      RegisterCashMovementKind.cash_drop,
      dto.amount,
      dto.note,
    );
  }

  @Post('sale/register/:id/close')
  @Roles(...RoleGroup.pos, Role.manager, Role.admin)
  @ApiOperation({ summary: 'Close register with cash count' })
  closeRegister(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseRegisterDto,
  ) {
    return this.posService.closeRegister(user, id, dto);
  }

  @Post('sale/returns')
  @Roles(...RoleGroup.returns, Role.accountant)
  @ApiOperation({
    summary:
      'Request/complete sale return — cashiers may pending; leads auto-complete',
  })
  saleReturn(@CurrentUser() user: AuthUser, @Body() dto: SaleReturnDto) {
    return this.saleReturns.saleReturn(user, dto);
  }

  @Get('sale/returns')
  @Roles(...RoleGroup.returns, Role.accountant)
  @ApiOperation({ summary: 'List sale returns (pending / history)' })
  listSaleReturns(
    @CurrentUser() user: AuthUser,
    @Query() query: ListSaleReturnsQueryDto,
  ) {
    return this.saleReturns.listSaleReturns(
      user,
      query.status,
      query.limit ?? 50,
    );
  }

  @Get('sale/returns/returned-qty/:orderId')
  @Roles(...RoleGroup.returns, Role.accountant)
  @ApiOperation({ summary: 'Cumulative returned qty per stock level for order' })
  returnedQuantities(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.saleReturns.returnedQuantities(user, orderId);
  }

  @Post('sale/returns/:id/approve')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve pending sale return (restock + refund)' })
  approveSaleReturn(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.saleReturns.approveSaleReturn(user, id);
  }

  @Post('sale/returns/:id/reject')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject pending sale return' })
  rejectSaleReturn(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectSaleReturnDto,
  ) {
    return this.saleReturns.rejectSaleReturn(user, id, dto.reason);
  }

  @Get('refund-reasons')
  @Roles(...RoleGroup.returns, Role.accountant)
  @ApiOperation({ summary: 'List refund reason catalog' })
  listRefundReasons(
    @CurrentUser() user: AuthUser,
    @Query('appliesTo') appliesTo?: string,
  ) {
    return this.saleReturns.listRefundReasons(user, appliesTo);
  }

  @Post('refund-reasons')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Create refund reason' })
  createRefundReason(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateRefundReasonDto,
  ) {
    return this.saleReturns.createRefundReason(user, dto);
  }

  @Post('refund-reasons/seed')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({ summary: 'Seed default refund reasons if empty' })
  seedRefundReasons(@CurrentUser() user: AuthUser) {
    return this.saleReturns.seedRefundReasons(user);
  }

  @Post('sale/exchange')
  @Roles(...RoleGroup.finance)
  @ApiOperation({
    summary: 'Sale exchange — return lines + replacement sale, net settle',
  })
  saleExchange(@CurrentUser() user: AuthUser, @Body() dto: SaleExchangeDto) {
    return this.saleReturns.saleExchange(user, dto);
  }

  // ─── Universal Rental floor (any rentable item) ───────────────────────────

  @Get('rental/schema')
  @UseGuards(CommerceModeGuard)
  @RequireCommerceModes('rental')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({
    summary:
      'Universal Rental keys — title, category, sku, rentalPrice, deposit, barcode, variant',
  })
  rentalSchema() {
    return this.rentalPos.rentalSchema();
  }

  @Get(':mode/schema')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({
    summary:
      'Field schema for any registered commerce mode (sale|rental|service|subscription|…)',
  })
  modeSchema(@Param('mode') mode: string) {
    return this.posService.modeSchema(mode.trim().toLowerCase());
  }

  @Get('rental/floor')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({ summary: 'Rental floor bootstrap: schema + units + counts' })
  rentalFloor(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.rentalPos.rentalFloor(user, locationId);
  }

  @Get('rental/categories')
  @Roles(...RoleGroup.pos, Role.inventory)
  listRentalCategories(@CurrentUser() user: AuthUser) {
    return this.rentalPos.listRentalCategories(user);
  }

  @Post('rental/categories')
  @Roles(...RoleGroup.catalogWrite)
  addRentalCategory(
    @CurrentUser() user: AuthUser,
    @Body() dto: AddSaleCategoryDto,
  ) {
    return this.rentalPos.addRentalCategory(user, dto);
  }

  @Patch('rental/categories/:id')
  @Roles(...RoleGroup.catalogWrite)
  renameRentalCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameSaleCategoryDto,
  ) {
    return this.rentalPos.renameRentalCategory(user, id, dto);
  }

  @Get('rental/products')
  @Roles(...RoleGroup.pos, Role.inventory)
  listRentalProducts(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    return this.rentalPos.listRentalProducts(user, { q, categoryId });
  }

  @Post('rental/products')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({
    summary: 'Add rental product + first serial unit (universal keys)',
  })
  addRentalProduct(
    @CurrentUser() user: AuthUser,
    @Body() dto: AddRentalProductDto,
  ) {
    return this.rentalPos.addRentalProduct(user, dto);
  }

  @Patch('rental/products/:id')
  @Roles(...RoleGroup.catalogWrite)
  updateRentalProduct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRentalProductDto,
  ) {
    return this.rentalPos.updateRentalProduct(user, id, dto);
  }

  @Post('rental/products/:id/image')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({
    summary: 'Upload rental product image (any category)',
  })
  uploadRentalProductImage(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadSaleImageDto,
  ) {
    return this.rentalPos.uploadRentalProductImage(user, id, dto);
  }

  @Get('rental/availability')
  @Roles(...RoleGroup.pos, Role.inventory)
  @ApiOperation({
    summary: 'Units available in a date range (blocks overlapping holds)',
  })
  rentalAvailability(
    @CurrentUser() user: AuthUser,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('productId') productId?: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.rentalPos.rentalAvailability(user, {
      from,
      to,
      productId,
      locationId,
    });
  }

  @Get('rental/units')
  @Roles(...RoleGroup.pos, Role.inventory)
  listRentalUnits(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('productId') productId?: string,
    @Query('status') status?: string,
  ) {
    return this.rentalPos.listRentalUnits(user, {
      locationId,
      q,
      categoryId,
      productId,
      status,
    });
  }

  @Post('rental/units')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Add another serial unit to a rental product' })
  addRentalUnit(@CurrentUser() user: AuthUser, @Body() dto: AddRentalUnitDto) {
    return this.rentalPos.addRentalUnit(user, dto);
  }

  @Patch('rental/units/:id')
  @Roles(...RoleGroup.catalogWrite)
  updateRentalUnit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRentalUnitDto,
  ) {
    return this.rentalPos.updateRentalUnit(user, id, dto);
  }

  @Get('rental/catalog')
  @Roles(...RoleGroup.pos, Role.inventory)
  rentalCatalog(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rentalPos.rentalCatalog(user, {
      locationId,
      q,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('rental/lookup')
  @Roles(...RoleGroup.pos, Role.inventory)
  rentalLookup(
    @CurrentUser() user: AuthUser,
    @Query('barcode') barcode: string,
    @Query('locationId') locationId?: string,
  ) {
    return this.rentalPos.rentalLookup(user, {
      barcode: barcode ?? '',
      locationId,
    });
  }

  @Get('rental/recent')
  @Roles(...RoleGroup.pos)
  listRecentRentals(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
  ) {
    return this.rentalPos.listRecentRentals(
      user,
      limit ? Number(limit) : undefined,
    );
  }

  @Post('rental/exchange')
  @Roles(...RoleGroup.pos)
  @ApiOperation({
    summary:
      'Exchange unit on open rental ticket (any category — bikes, cameras, clothes…)',
  })
  rentalExchange(
    @CurrentUser() user: AuthUser,
    @Body() dto: RentalExchangeDto,
  ) {
    return this.rentalPos.exchange(user, dto);
  }

  @Post('rental/extend')
  @Roles(...RoleGroup.pos)
  @ApiOperation({
    summary: 'Extend rental return-due date and post extension fee',
  })
  rentalExtend(
    @CurrentUser() user: AuthUser,
    @Body() dto: ExtendRentalDto,
  ) {
    return this.rentalPos.extend(user, dto);
  }

  @Post('checkout')
  @Roles(...RoleGroup.pos)
  @ApiOperation({
    summary: 'Apply payments to an existing order (rental or sale)',
  })
  checkout(@CurrentUser() user: AuthUser, @Body() dto: CheckoutDto) {
    return this.posService.checkout(user, dto);
  }

  @Get('orders/:id/receipt')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Printable order receipt' })
  receipt(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.posService.getReceipt(user, id);
  }
}
