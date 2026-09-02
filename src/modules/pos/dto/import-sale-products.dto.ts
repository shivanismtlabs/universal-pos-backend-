import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

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
    description:
      'Category name — created if missing when createCategories is true',
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

  @ApiPropertyOptional({
    enum: ['goods', 'service', 'rental'],
    description: 'CSV column type / item_type / kind — service vs goods vs rental',
  })
  @IsOptional()
  @IsIn(['goods', 'service', 'rental'])
  itemType?: 'goods' | 'service' | 'rental';

  @ApiPropertyOptional({
    example: 30,
    description: 'Service duration in minutes (CSV: duration_minutes)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  durationMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Cover image: http(s) URL, /v1/uploads path, or data URL. CSV column image_url.',
    example: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002',
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
