import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  Allow,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductKind, ProductStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class CreateBrandDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;
}

export class UpdateBrandDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateCategoryDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  sortOrder?: number;
}

export class GenerateSkuDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: ProductKind })
  @IsOptional()
  @IsEnum(ProductKind)
  kind?: ProductKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(6)
  prefix?: string;
}

export class CreateCatalogProductDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  shortName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(18)
  skuCode?: string;

  @ApiPropertyOptional({ enum: ProductKind })
  @IsOptional()
  @IsEnum(ProductKind)
  kind?: ProductKind;

  @ApiPropertyOptional({ enum: ProductStatus })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @ApiPropertyOptional({
    description: 'code128 | ean13 | upca | ean8 — defaults to code128',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  barcodeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  qrCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  internalCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shortDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  photoUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(12)
  images?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  taxCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  mrp?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  unitOfMeasure?: string;

  @ApiPropertyOptional({ description: 'Unit master id (base / inventory unit)' })
  @IsOptional()
  @IsUUID()
  baseUnitId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  pricingUnitId?: string | null;

  @ApiPropertyOptional({ enum: ['converted', 'fixed_tier'] })
  @IsOptional()
  @IsIn(['converted', 'fixed_tier'])
  pricingStrategy?: 'converted' | 'fixed_tier';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  pricePerPricingUnit?: number;

  @ApiPropertyOptional({
    description: 'Selling/purchase unit rows (product_units)',
  })
  @IsOptional()
  @IsArray()
  productUnits?: Array<{
    unitId: string;
    conversionToBase: number;
    fixedPrice?: number | null;
    isDefaultSellingUnit?: boolean;
    isPurchaseUnit?: boolean;
  }>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackSerial?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackBatch?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  canSell?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  canPurchase?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  availableInPos?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Opening stock at default location (qty-tracked only)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  openingQty?: number;

  @ApiPropertyOptional({
    description: 'Low-stock alert qty at the opening location (qty-tracked only)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reorderPoint?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  @Allow()
  extraFields?: Record<string, unknown>;
}

export class UpdateCatalogProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shortName?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(18)
  skuCode?: string;

  @ApiPropertyOptional({ enum: ProductKind })
  @IsOptional()
  @IsEnum(ProductKind)
  kind?: ProductKind;

  @ApiPropertyOptional({ enum: ProductStatus })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  brandId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  barcode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  barcodeType?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  qrCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internalCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  shortDescription?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  photoUrl?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  taxCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  mrp?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  unitOfMeasure?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  baseUnitId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  pricingUnitId?: string | null;

  @ApiPropertyOptional({ enum: ['converted', 'fixed_tier'] })
  @IsOptional()
  @IsIn(['converted', 'fixed_tier'])
  pricingStrategy?: 'converted' | 'fixed_tier';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  pricePerPricingUnit?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackSerial?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackBatch?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  canSell?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  canPurchase?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  availableInPos?: boolean;

  @ApiPropertyOptional({
    description: 'Low-stock alert qty — updates product meta + stock levels',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reorderPoint?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  @Allow()
  extraFields?: Record<string, unknown>;
}

export class ListCatalogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional({ enum: ProductKind })
  @IsOptional()
  @IsEnum(ProductKind)
  kind?: ProductKind;

  @ApiPropertyOptional({ enum: ProductStatus })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['true', 'false'])
  availableInPos?: string;

  @ApiPropertyOptional({
    description: 'When set, list includes stockOnHand for this branch',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({
    description:
      'Filter items at or below default reorder (5), including zero stock',
  })
  @IsOptional()
  @IsIn(['true', 'false', '1', '0'])
  lowStock?: string;
}

export class CreateVariantDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(18)
  skuCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  barcode?: string;

  @ApiPropertyOptional({ example: { size: 'M', color: 'Black', weight: '0.4' } })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string | number | boolean | null>;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number;
}

export class UpdateVariantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  barcode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string | number | boolean | null>;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  basePrice?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class BundleLineDto {
  @ApiProperty()
  @IsUUID()
  componentProductId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  componentVariantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity?: number;

  @ApiPropertyOptional({
    description: 'Consume this component when the parent is sold or completed',
  })
  @IsOptional()
  @IsBoolean()
  consumeOnSale?: boolean;

  @ApiPropertyOptional({ enum: ['bundle', 'recipe', 'production'] })
  @IsOptional()
  @IsString()
  purpose?: string;

  @ApiPropertyOptional({ description: 'Consumption unit (g, ml) if different from stock UOM' })
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional({ description: 'Extra % consumed on top of BOM qty' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  wastagePercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  stageId?: string;
}

export class SetBundleLinesDto {
  @ApiProperty({ type: [BundleLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BundleLineDto)
  lines!: BundleLineDto[];
}

export class CreateBatchDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  batchCode!: string;

  @ApiProperty()
  @IsUUID()
  locationId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  manufacturedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  qtyOnHand?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateBatchDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  manufacturedAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  qtyOnHand?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateSerialDto {
  @ApiProperty({ description: 'Serial / barcode for the unit' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  serial!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  label?: string;
}

export class SetProductStatusDto {
  @ApiProperty({ enum: ProductStatus })
  @IsEnum(ProductStatus)
  status!: ProductStatus;
}
