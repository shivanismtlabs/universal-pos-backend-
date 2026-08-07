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
