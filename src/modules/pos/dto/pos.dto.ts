import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  Allow,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PosPaymentInputDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiProperty({ example: 5000 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty({ description: 'Client-generated key for idempotent retries' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey!: string;

  @ApiPropertyOptional({ enum: PaymentType, default: PaymentType.payment })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @ApiPropertyOptional({
    description: 'Required when method is gift_card',
    example: 'GC-ABC123',
  })
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  giftCardCode?: string;

  @ApiPropertyOptional({
    description: 'Bank transfer reference / UTR',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bankReference?: string;

  @ApiPropertyOptional({ description: 'Payer bank account name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bankAccountName?: string;

  @ApiPropertyOptional({ description: 'Payer bank account number (masked OK)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  bankAccountNumber?: string;

  @ApiPropertyOptional({ description: 'IFSC / routing code' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  bankIfsc?: string;

  @ApiPropertyOptional({ description: 'Bank name' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  bankName?: string;

  @ApiPropertyOptional({
    description: 'EMI tenure in months (3–24)',
    example: 6,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  emiTenureMonths?: number;

  @ApiPropertyOptional({
    description: 'EMI provider / bank / NBFC',
    example: 'HDFC',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  emiProvider?: string;

  @ApiPropertyOptional({
    description: 'EMI approval / reference code',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  emiReference?: string;
}

export class CheckoutDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiProperty({ type: [PosPaymentInputDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PosPaymentInputDto)
  payments!: PosPaymentInputDto[];

  @ApiPropertyOptional({
    description: 'Move order to ready status if currently reserved/fitted',
  })
  @IsOptional()
  @IsBoolean()
  markReady?: boolean;
}

/** One sellable line on the retail cart */
export class SaleCheckoutItemDto {
  @ApiProperty({ description: 'Stock level / retail SKU id' })
  @IsUUID()
  stockLevelId!: string;

  @ApiProperty({
    example: 2,
    description: 'May be fractional for kg/L (e.g. 0.5)',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional({
    description: 'Override sell price (defaults to catalog/engine price for the transaction unit)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @ApiPropertyOptional({
    description:
      'Transaction unit id (Unit master). When set, quantity is in this unit; backend converts to base.',
  })
  @IsOptional()
  @IsUUID()
  sellingUnitId?: string;

  @ApiPropertyOptional({ description: 'Selected product variant id when variants are enabled' })
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @ApiPropertyOptional({ description: 'Selected batch/lot id when batch tracking is enabled' })
  @IsOptional()
  @IsUUID()
  batchId?: string;

  @ApiPropertyOptional({ description: 'Selected serial number / unit barcode when serial tracking is enabled' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  serialNumber?: string;
}

/**
 * Atomic retail sale: create order + decrement stock + take payment + close.
 * One round-trip for the counter.
 */
export class SaleCheckoutDto {
  @ApiProperty()
  @IsUUID()
  locationId!: string;

  @ApiPropertyOptional({ description: 'Omit for walk-in' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty({ type: [SaleCheckoutItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleCheckoutItemDto)
  items!: SaleCheckoutItemDto[];

  @ApiProperty({ type: [PosPaymentInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PosPaymentInputDto)
  payments!: PosPaymentInputDto[];

  @ApiPropertyOptional({
    description: 'Cash received (for change). Required when paying cash.',
    example: 1000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cashTendered?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    description: 'Cart-level discount amount (currency)',
    example: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({
    description:
      'Nearest-rupee half-up delta (rounded − exact). Positive adds Round off fee; negative writes off via discount.',
    example: 0.4,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-0.99)
  @Max(0.99)
  roundOffAmount?: number;

  @ApiPropertyOptional({
    description: 'Loyalty coupon code applied at counter (records redemption)',
    example: 'SAVE10',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  couponCode?: string;

  @ApiPropertyOptional({
    description: 'Loyalty points to redeem (needs customerId)',
    example: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  loyaltyPointsToRedeem?: number;

  @ApiPropertyOptional({
    description:
      'Allow payment less than balance due (order stays open with balance)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === 1)
  @IsBoolean()
  allowPartial?: boolean;

  @ApiPropertyOptional({
    description: 'Send sale receipt via email/SMS/WhatsApp after checkout',
  })
  @IsOptional()
  @IsBoolean()
  sendReceipt?: boolean;

  @ApiPropertyOptional({
    enum: ['email', 'sms', 'whatsapp'],
    isArray: true,
  })
  @IsOptional()
  @IsIn(['email', 'sms', 'whatsapp'], { each: true })
  sendReceiptChannels?: Array<'email' | 'sms' | 'whatsapp'>;

  /**
   * Capability-based order metadata (not industry columns).
   * Examples: tableId, orderType (dine_in|takeaway), covers, source, externalReference.
   * Merged into orders.meta alongside taxSnapshot / note.
   */
  @ApiPropertyOptional({
    description:
      'Structured order extras (BusinessConfig / commerce meta). Free-form JSON object.',
    example: { tableId: 'T12', orderType: 'dine_in', covers: 2 },
  })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}

/** Create unpaid sale ticket for Stripe (card/UPI) — stock held on verify */
export class PrepareSaleCheckoutDto {
  @ApiProperty()
  @IsUUID()
  locationId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty({ type: [SaleCheckoutItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleCheckoutItemDto)
  items!: SaleCheckoutItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({
    description:
      'Nearest-rupee half-up delta (rounded − exact). Positive adds Round off fee; negative writes off via discount.',
    example: 0.4,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-0.99)
  @Max(0.99)
  roundOffAmount?: number;

  @ApiPropertyOptional({
    description: 'Loyalty coupon code (same as cash sale checkout)',
    example: 'SAVE10',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  couponCode?: string;

  @ApiPropertyOptional({
    description:
      'Structured order extras (tableId, orderType, covers). Same as cash checkout meta.',
    example: { tableId: 'T12', orderType: 'dine_in', covers: 2 },
  })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}

/**
 * Universal Sale product keys — same for every Sale shop / industry.
 * title, description, categoryId, sku, price, qty
 */
export class AddSaleProductDto {
  @ApiProperty({ example: 'USB-C Cable' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'ACC-USBC-01', minLength: 2, maxLength: 18 })
  @IsString()
  @MinLength(2)
  @MaxLength(18)
  sku!: string;

  @ApiPropertyOptional({ example: 'pcs' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/)
  sellUnit?: string;

  @ApiProperty({ example: 299, description: 'Price per sell unit (> 0)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price!: number;

  @ApiProperty({
    example: 50,
    description:
      'Opening stock — must be ≥ 1 when Track Inventory is on (services may send 0)',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  qty!: number;

  @ApiPropertyOptional({
    description: 'Product image URL (or set via upload endpoint)',
    example: '/v1/uploads/products/…',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  image?: string;

  @ApiPropertyOptional({ description: 'Alias for image' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  photoUrl?: string;


  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Manufacturer / brand' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  manufacturer?: string;

  @ApiPropertyOptional({ description: 'Barcode / UPC / EAN' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  barcode?: string;

  @ApiPropertyOptional({ description: 'Cost / purchase price per unit' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPrice?: number;

  @ApiPropertyOptional({ description: 'Low-stock reorder threshold' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reorderPoint?: number;

  @ApiPropertyOptional({ description: 'HSN / SAC code (India tax)' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  hsnOrSac?: string;

  @ApiPropertyOptional({ description: 'When false, stock is not decremented on sale' })
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

  /** Goods vs service (Zoho Type) */
  @ApiPropertyOptional({ enum: ['goods', 'service'] })
  @IsOptional()
  @IsIn(['goods', 'service'])
  itemType?: 'goods' | 'service';

  @ApiPropertyOptional({
    example: 30,
    description: 'Service duration in minutes',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  durationMinutes?: number;

  /** Single item vs variants parent (matrix pack later) */
  @ApiPropertyOptional({ enum: ['single', 'variants'] })
  @IsOptional()
  @IsIn(['single', 'variants'])
  itemStructure?: 'single' | 'variants';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  brand?: string;

  @ApiPropertyOptional({ description: 'Separate from primary barcode' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  upc?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  ean?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  mpn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  isbn?: string;

  @ApiPropertyOptional({ enum: ['taxable', 'non_taxable'] })
  @IsOptional()
  @IsIn(['taxable', 'non_taxable'])
  taxPreference?: 'taxable' | 'non_taxable';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  taxRatePercent?: number;

  @ApiPropertyOptional({ description: 'Value of opening stock (currency)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  openingStockValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  returnable?: boolean;

  @ApiPropertyOptional({ description: 'Enable batch tracking intent (pack)' })
  @IsOptional()
  @IsBoolean()
  batchTracking?: boolean;

  @ApiPropertyOptional({ description: 'Enable serial tracking intent (pack)' })
  @IsOptional()
  @IsBoolean()
  serialTracking?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  dimLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  dimWidth?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  dimHeight?: number;

  @ApiPropertyOptional({ example: 'cm' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  dimUnit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  weight?: number;

  @ApiPropertyOptional({ example: 'kg' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  weightUnit?: string;

  @ApiPropertyOptional({ description: 'Composite / kit intent' })
  @IsOptional()
  @IsBoolean()
  isComposite?: boolean;

  /** When sell unit is pack/box: how many base units (e.g. 12 pcs) */
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  multiUnitBaseQty?: number;

  @ApiPropertyOptional({ example: 'pcs' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  multiUnitBaseUnit?: string;

  @ApiPropertyOptional({ description: 'Loyalty points weight for this item' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  loyaltyPoints?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  perishable?: boolean;

  @ApiPropertyOptional({
    description: 'Days before expiry to apply auto discount (rule intent)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  expiryAutoDiscountDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  expiryAutoDiscountPercent?: number;

  /** Modifier / add-on labels (restaurant coffee “extra cheese”) — full pack later */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  modifiers?: string[];

  /**
   * Dynamic vertical extras (ERD ITEM.extra_fields → products.meta).
   * Keys come from BusinessConfig.item_fields — not hardcode per industry.
   */
  @ApiPropertyOptional({
    description: 'BusinessConfig-driven item extras stored in product.meta',
    example: { size: 'M', color: 'red' },
  })
  @IsOptional()
  @IsObject()
  @Allow()
  extraFields?: Record<string, unknown>;
}

/** One row when bulk-importing sale items (Universal — any industry). */
export class ImportSaleProductRowDto {
  @ApiProperty({ example: 'USB-C Cable 1m' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title!: string;

  @ApiProperty({ example: 'USBC-1M' })
  @IsString()
  @MinLength(2)
  @MaxLength(18)
  sku!: string;

  @ApiPropertyOptional({
    description: 'Category name — created if missing when createCategories is true',
    example: 'Accessories',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  categoryName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'pcs' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/)
  sellUnit?: string;

  @ApiProperty({ example: 199 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price!: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  qty?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  manufacturer?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  barcode?: string;

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
  reorderPoint?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(16)
  hsnOrSac?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  trackInventory?: boolean;

<<<<<<< HEAD
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  itemType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  kind?: string;
=======
  @ApiPropertyOptional({ enum: ['goods', 'service'] })
  @IsOptional()
  @IsIn(['goods', 'service'])
  itemType?: 'goods' | 'service';

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  durationMinutes?: number;
>>>>>>> a91e49de027a7047554016472689f0e4be4081e0
}

export class ImportSaleProductsDto {
  @ApiProperty({ type: [ImportSaleProductRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportSaleProductRowDto)
  items!: ImportSaleProductRowDto[];

  @ApiPropertyOptional({ description: 'Target location for opening stock' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({
    description: 'Create category by name when categoryId missing',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  createCategories?: boolean;

  @ApiPropertyOptional({
    description: 'Default category when row has none',
  })
  @IsOptional()
  @IsUUID()
  defaultCategoryId?: string;
}

export class AddSaleCategoryDto {
  @ApiProperty({ example: 'Mobiles' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    description: 'Optional parent category for nesting (Zoho-style)',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

/** Update universal sale keys on an existing stock row */
export class UpdateSaleProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Product image URL' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  image?: string;

  @ApiPropertyOptional({ description: 'Alias for image' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  photoUrl?: string;

  @ApiPropertyOptional({ example: 'pcs' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/)
  sellUnit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price?: number;

  @ApiPropertyOptional({ description: 'Set absolute qty on hand' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  qty?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Upload product image as data URL / base64 */
export class UploadSaleImageDto {
  @ApiProperty({
    description: 'data:image/jpeg;base64,… or raw base64',
    example: 'data:image/jpeg;base64,/9j/4AAQ',
  })
  @IsString()
  @MinLength(32)
  imageBase64!: string;
}

export class RemoveSaleImageDto {
  @ApiProperty({ description: 'Image URL to remove from the gallery' })
  @IsString()
  @MinLength(4)
  @MaxLength(2000)
  imageUrl!: string;
}

/** Restock / reduce — delta can be negative */
export class AdjustSaleStockDto {
  @ApiProperty({ example: 10, description: 'Add (+) or remove (−) quantity' })
  @Type(() => Number)
  @IsNumber()
  delta!: number;

  @ApiPropertyOptional({
    example: 'Damaged units written off',
    description: 'Optional note for inventory audit trail',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    example: 'SN-987654',
    description: 'Serial number for serialized items',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serialNumber?: string;
}

export class RenameSaleCategoryDto {
  @ApiProperty({ example: 'Accessories' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

/** Add rental product + first serial unit (universal keys) */
export class AddRentalProductDto {
  @ApiProperty({ example: 'Trail Bike M' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'BIKE-TRAIL-RENT-01', minLength: 15, maxLength: 18 })
  @IsString()
  @MinLength(15)
  @MaxLength(18)
  sku!: string;

  @ApiProperty({ example: 800 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rentalPrice!: number;

  @ApiPropertyOptional({ example: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deposit?: number;

  @ApiPropertyOptional({
    example: 200,
    description: 'Late fee charged per day past return due (0 = disabled amount)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lateFeePerDay?: number;

  @ApiPropertyOptional({ example: true, description: 'When false, never auto-suggest late fees' })
  @IsOptional()
  @IsBoolean()
  lateFeeEnabled?: boolean;

  @ApiPropertyOptional({ example: 150, description: 'Default cleaning fee on return' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cleaningFee?: number;

  @ApiPropertyOptional({
    example: 1000,
    description: 'Default damage / replacement charge suggestion',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  damageFeeDefault?: number;

  @ApiProperty({ example: 'BC-001' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  barcode!: string;

  @ApiPropertyOptional({
    description: 'Variant (size, frame, length…) — alias: size',
    example: 'M',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  variant?: string;

  @ApiPropertyOptional({ description: 'Legacy alias for variant' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  size?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

/** Extra serial unit on an existing rental product */
export class AddRentalUnitDto {
  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiProperty({ example: 'BC-002' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  barcode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  variant?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  size?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rentalPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deposit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class UpdateRentalProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rentalPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateRentalUnitDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  variant?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rentalPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deposit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Swap unit on an open rental ticket */
export class RentalExchangeDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiProperty({ description: 'Unit currently on the order' })
  @IsUUID()
  fromStockUnitId!: string;

  @ApiProperty({ description: 'Available unit to swap in' })
  @IsUUID()
  toStockUnitId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Extend rental return-due date and optionally collect extension fee */
export class ExtendRentalDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiProperty({ example: '2026-08-20', description: 'New return due date (YYYY-MM-DD)' })
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  newReturnDueDate!: string;

  @ApiPropertyOptional({
    example: 200,
    description: 'Fee per extra day (default: average daily rent from order lines)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  ratePerDay?: number;

  @ApiPropertyOptional({
    description: 'Override total extension fee (skips ratePerDay math)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  extensionAmount?: number;

  @ApiPropertyOptional({ type: PosPaymentInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PosPaymentInputDto)
  payment?: PosPaymentInputDto;
}

/** Park / hold a sale cart without burning stock */
export class ParkSaleDto {
  @ApiProperty()
  @IsUUID()
  locationId!: string;

  @ApiPropertyOptional({ description: 'Omit for walk-in' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty({ type: [SaleCheckoutItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleCheckoutItemDto)
  items!: SaleCheckoutItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @ApiPropertyOptional({ description: 'Label on parked ticket' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class OpenRegisterDto {
  @ApiProperty()
  @IsUUID()
  locationId!: string;

  @ApiPropertyOptional({ example: 2000, description: 'Opening float' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  openingFloat?: number;
}

export class CloseRegisterDto {
  @ApiProperty({ example: 15420.5, description: 'Counted cash in drawer' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  closingCash!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RegisterCashMovementDto {
  @ApiProperty({ example: 500 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SaleReturnItemDto {
  @ApiProperty()
  @IsUUID()
  stockLevelId!: string;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional({
    enum: [
      'good',
      'damaged',
      'defective',
      'opened',
      'used',
      'quarantine',
      'scrap',
    ],
    default: 'good',
  })
  @IsOptional()
  @IsIn([
    'good',
    'damaged',
    'defective',
    'opened',
    'used',
    'quarantine',
    'scrap',
  ])
  condition?: string;
}

/** Qty return against a closed sale — restock + refund */
export class SaleReturnDto {
  @ApiProperty({ description: 'Original closed sale order' })
  @IsUUID()
  orderId!: string;

  @ApiProperty({ type: [SaleReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleReturnItemDto)
  items!: SaleReturnItemDto[];

  @ApiProperty({
    description:
      'Refund tender, or "original" to use the linked / primary payment method',
    example: PaymentMethod.cash,
  })
  @IsString()
  @IsIn([
    ...Object.values(PaymentMethod),
    'original',
  ])
  refundMethod!: PaymentMethod | 'original';

  @ApiPropertyOptional({
    description: 'Refund amount (defaults to returned line totals)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiProperty({ description: 'Catalog reason code', example: 'damaged' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  reasonCode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description: 'Original payment to link this refund to',
  })
  @IsOptional()
  @IsUUID()
  parentPaymentId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey!: string;
}

export class CreateRefundReasonDto {
  @ApiProperty({ example: 'damaged' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @ApiProperty({ example: 'Damaged / defective' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  sortOrder?: number;

  @ApiPropertyOptional({ enum: ['customer', 'supplier', 'both'] })
  @IsOptional()
  @IsIn(['customer', 'supplier', 'both'])
  appliesTo?: string;
}

export class ListSaleReturnsQueryDto {
  @ApiPropertyOptional({
    enum: [
      'requested',
      'pending',
      'approved',
      'processing',
      'completed',
      'rejected',
      'all',
    ],
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class RejectSaleReturnDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class SaleExchangeReplaceItemDto {
  @ApiProperty()
  @IsUUID()
  stockLevelId!: string;

  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;
}

/** Return selected lines + sell replacement items; settle net */
export class SaleExchangeDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiProperty({ type: [SaleReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleReturnItemDto)
  returnItems!: SaleReturnItemDto[];

  @ApiProperty({ type: [SaleExchangeReplaceItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SaleExchangeReplaceItemDto)
  replaceItems!: SaleExchangeReplaceItemDto[];

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.cash })
  @IsEnum(PaymentMethod)
  settleMethod!: PaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reasonCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey!: string;
}
