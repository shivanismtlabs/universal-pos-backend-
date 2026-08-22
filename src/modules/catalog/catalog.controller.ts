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
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { CatalogService } from './catalog.service';
import {
  CreateBatchDto,
  CreateBrandDto,
  CreateCatalogProductDto,
  CreateCategoryDto,
  CreateSerialDto,
  CreateVariantDto,
  GenerateSkuDto,
  ListCatalogQueryDto,
  SetBundleLinesDto,
  SetProductStatusDto,
  BulkDeleteProductsDto,
  UpdateBatchDto,
  UpdateBrandDto,
  UpdateCatalogProductDto,
  UpdateCategoryDto,
  UpdateVariantDto,
} from './dto/catalog.dto';

@ApiTags('catalog')
@ApiBearerAuth('access-token')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ── Brands ─────────────────────────────────────────────────────────────

  @Get('brands')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List brands' })
  listBrands(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.catalog.listBrands(user, q);
  }

  @Post('brands')
  @Roles(...RoleGroup.catalogWrite)
  createBrand(@CurrentUser() user: AuthUser, @Body() dto: CreateBrandDto) {
    return this.catalog.createBrand(user, dto);
  }

  @Patch('brands/:id')
  @Roles(...RoleGroup.catalogWrite)
  updateBrand(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.catalog.updateBrand(user, id, dto);
  }

  @Delete('brands/:id')
  @Roles(...RoleGroup.catalogWrite)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete brand (hard if unused; otherwise soft-deactivate)',
  })
  deleteBrand(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.deleteBrand(user, id);
  }

  // ── Categories ─────────────────────────────────────────────────────────

  @Get('categories')
  @Roles(...RoleGroup.catalogRead)
  listCategories(@CurrentUser() user: AuthUser) {
    return this.catalog.listCategories(user);
  }

  @Post('categories')
  @Roles(...RoleGroup.catalogWrite)
  createCategory(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCategoryDto,
  ) {
    return this.catalog.createCategory(user, dto);
  }

  @Patch('categories/:id')
  @Roles(...RoleGroup.catalogWrite)
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.catalog.updateCategory(user, id, dto);
  }

  @Delete('categories/:id')
  @Roles(...RoleGroup.catalogWrite)
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Delete category (hard if unused; otherwise soft-deactivate)',
  })
  deleteCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.deleteCategory(user, id);
  }

  // ── Products ───────────────────────────────────────────────────────────

  @Post('sku/generate')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Generate unique tenant SKU' })
  generateSku(@CurrentUser() user: AuthUser, @Body() dto: GenerateSkuDto) {
    return this.catalog.generateSku(user, dto);
  }

  @Post('barcode/generate')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Generate unique internal Code 128 barcode' })
  generateBarcode(@CurrentUser() user: AuthUser) {
    return this.catalog.generateBarcode(user);
  }

  @Get('barcode/check')
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'Check barcode uniqueness for tenant' })
  checkBarcode(
    @CurrentUser() user: AuthUser,
    @Query('code') code?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.catalog.checkBarcode(user, code ?? '', excludeId);
  }

  @Get('batches/expiring')
  @Roles(...RoleGroup.catalogRead)
  listExpiring(
    @CurrentUser() user: AuthUser,
    @Query('days') days?: string,
  ) {
    const n = days ? Number(days) : 30;
    return this.catalog.listExpiringBatches(
      user,
      Number.isFinite(n) ? n : 30,
    );
  }

  @Get('products')
  @Roles(...RoleGroup.catalogRead)
  listProducts(
    @CurrentUser() user: AuthUser,
    @Query() query: ListCatalogQueryDto,
  ) {
    return this.catalog.listProducts(user, query);
  }

  @Post('products')
  @Roles(...RoleGroup.catalogWrite)
  createProduct(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCatalogProductDto,
  ) {
    return this.catalog.createProduct(user, dto);
  }

  @Get('products/:id')
  @Roles(...RoleGroup.catalogRead)
  getProduct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.getProduct(user, id);
  }

  @Get('products/:id/qr')
  @Roles(...RoleGroup.catalogRead)
  productQr(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.qrForProduct(user, id);
  }

  @Patch('products/:id')
  @Roles(...RoleGroup.catalogWrite)
  updateProduct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCatalogProductDto,
  ) {
    return this.catalog.updateProduct(user, id, dto);
  }

  @Post('products/:id/status')
  @Roles(...RoleGroup.catalogWrite)
  setStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetProductStatusDto,
  ) {
    return this.catalog.setStatus(user, id, dto.status);
  }

  @Post('products/:id/duplicate')
  @Roles(...RoleGroup.catalogWrite)
  duplicate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.duplicateProduct(user, id);
  }

  @Delete('products/:id')
  @Roles(...RoleGroup.catalogWrite)
  @HttpCode(200)
  deleteProduct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.deleteProduct(user, id);
  }

  @Post('products/bulk-delete')
  @Roles(...RoleGroup.catalogWrite)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Bulk delete or clear catalog products (tenant-scoped)',
  })
  bulkDeleteProducts(
    @CurrentUser() user: AuthUser,
    @Body() dto: BulkDeleteProductsDto,
  ) {
    return this.catalog.bulkDeleteProducts(user, dto);
  }

  // ── Variants ───────────────────────────────────────────────────────────

  @Post('products/:id/variants')
  @Roles(...RoleGroup.catalogWrite)
  createVariant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.catalog.createVariant(user, id, dto);
  }

  @Patch('products/:id/variants/:variantId')
  @Roles(...RoleGroup.catalogWrite)
  updateVariant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.catalog.updateVariant(user, id, variantId, dto);
  }

  @Delete('products/:id/variants/:variantId')
  @Roles(...RoleGroup.catalogWrite)
  deleteVariant(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ) {
    return this.catalog.deleteVariant(user, id, variantId);
  }

  // ── Bundle ─────────────────────────────────────────────────────────────

  @Put('products/:id/bundle-lines')
  @Roles(...RoleGroup.catalogWrite)
  setBundle(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetBundleLinesDto,
  ) {
    return this.catalog.replaceBundleLines(user, id, dto);
  }

  // ── Batches ────────────────────────────────────────────────────────────

  @Post('products/:id/batches')
  @Roles(...RoleGroup.catalogWrite)
  createBatch(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBatchDto,
  ) {
    return this.catalog.createBatch(user, id, dto);
  }

  @Patch('products/:id/batches/:batchId')
  @Roles(...RoleGroup.catalogWrite)
  updateBatch(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('batchId', ParseUUIDPipe) batchId: string,
    @Body() dto: UpdateBatchDto,
  ) {
    return this.catalog.updateBatch(user, id, batchId, dto);
  }

  // ── Serials ────────────────────────────────────────────────────────────

  @Get('products/:id/serials')
  @Roles(...RoleGroup.catalogRead)
  listSerials(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.catalog.listSerials(user, id);
  }

  @Post('products/:id/serials')
  @Roles(...RoleGroup.catalogWrite)
  createSerial(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSerialDto,
  ) {
    return this.catalog.createSerial(user, id, dto);
  }
}
