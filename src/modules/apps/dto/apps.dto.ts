import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { REGISTERED_COMMERCE_MODES } from '../../../common/commerce-schema';

export class EnableModuleDto {
  @ApiPropertyOptional({
    description: 'Module-specific config JSON',
    example: { lateFeePerDay: 100 },
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class SetFeatureFlagDto {
  @ApiProperty({ example: 'offline_pos' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'key must be lowercase snake_case',
  })
  key!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;
}

/**
 * Set enabled commerce modes for the tenant (multi-select from registry).
 * Valid codes come from COMMERCE_SCHEMAS (sale, rental, service, subscription, …).
 */
export class SetCommerceModesDto {
  @ApiPropertyOptional({
    enum: REGISTERED_COMMERCE_MODES,
    description: 'Single mode shorthand; prefer `modes` for multi-select',
  })
  @ValidateIf((o: SetCommerceModesDto) => !o.modes?.length)
  @IsIn(REGISTERED_COMMERCE_MODES)
  mode?: string;

  @ApiPropertyOptional({
    example: ['sale', 'service'],
    isArray: true,
    description: 'Enabled fulfillment modes for this shop',
  })
  @ValidateIf((o: SetCommerceModesDto) => !o.mode)
  @IsArray()
  @ArrayMinSize(1)
  @IsIn(REGISTERED_COMMERCE_MODES, { each: true })
  modes?: string[];

  @ApiPropertyOptional({ example: 'Pixel Electronics' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  shopTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  tagline?: string;
}

/**
 * Pick a business profile (retail, restaurant, salon, …).
 * New profiles live only in BUSINESS_CONFIG_REGISTRY — not new apps.
 */
export class SetBusinessConfigDto {
  @ApiProperty({
    example: 'retail',
    description:
      'business type id from GET /commerce/business-configs (setup template only)',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  businessType!: string;

  @ApiPropertyOptional({
    example: 'Swimming academy',
    description: 'Display label when the industry is not in the template list',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  businessLabel?: string;

  @ApiPropertyOptional({
    description:
      'When true (default), enable that profile’s defaultCommerceModes',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  applyDefaultModes?: boolean;

  @ApiPropertyOptional({
    description:
      'When true (default), apply recommended capabilities for the profile',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  applyDefaultCapabilities?: boolean;
}

export class SetBusinessCapabilitiesDto {
  @ApiProperty({
    example: ['INVENTORY', 'BARCODE', 'BOOKING'],
    isArray: true,
    description: 'Tenant capability codes — runtime gates use these, not businessType',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  capabilities!: string[];
}

export class RecommendBusinessSetupDto {
  @ApiPropertyOptional({ example: 'pet_grooming' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  businessType?: string;

  @ApiPropertyOptional({
    example: ['services', 'products'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sells?: string[];

  @ApiPropertyOptional({
    example: ['appointments', 'resources'],
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  needs?: string[];
}

/** Generic catalog create — mode must be a registered commerce mode */
export class CreateCatalogItemDto {
  @ApiProperty({ enum: REGISTERED_COMMERCE_MODES })
  @IsIn(REGISTERED_COMMERCE_MODES)
  mode!: string;

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

  @ApiProperty({ example: 'ACC-USBC-CABLE-01', minLength: 15, maxLength: 18 })
  @IsString()
  @MinLength(15)
  @MaxLength(18)
  sku!: string;

  @ApiPropertyOptional({ description: 'Location for stock (defaults MAIN)' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Sale / service / subscription price */
  @ApiPropertyOptional({ example: 299 })
  @ValidateIf((o: CreateCatalogItemDto) =>
    ['sale', 'service', 'subscription'].includes(o.mode),
  )
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ example: 50 })
  @ValidateIf((o: CreateCatalogItemDto) => o.mode === 'sale')
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  qty?: number;

  @ApiPropertyOptional({ example: 45, description: 'Service duration' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  durationMinutes?: number;

  @ApiPropertyOptional({ example: 30, description: 'Subscription period in days' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  billingPeriod?: number;

  /** Rental keys */
  @ApiPropertyOptional({ example: 4500 })
  @ValidateIf((o: CreateCatalogItemDto) => o.mode === 'rental')
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rentalPrice?: number;

  @ApiPropertyOptional({ example: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deposit?: number;

  @ApiPropertyOptional({ example: 'BIKE-001' })
  @ValidateIf((o: CreateCatalogItemDto) => o.mode === 'rental')
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  barcode?: string;

  @ApiPropertyOptional({ example: 'M', description: 'Variant / size / frame…' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  size?: string;

  @ApiPropertyOptional({ description: 'Alias for size/variant' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  variant?: string;
}
