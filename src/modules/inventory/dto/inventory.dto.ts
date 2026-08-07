import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OwnershipType, StockUnitCondition } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class CreateCategoryDto {
  @ApiProperty({ example: 'Tuxedo' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;
}

export class CreateProductStyleDto {
  @ApiProperty({ example: 'Classic Black Tux' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @ApiProperty({ example: 'TBX-BLK-01' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  styleCode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'Black' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  photoUrl?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isRental?: boolean;

  @ApiPropertyOptional({
    enum: ['sale', 'rental', 'service'],
    description: 'Preferred over isRental when set',
  })
  @IsOptional()
  @IsIn(['sale', 'rental', 'service'])
  fulfillmentMode?: 'sale' | 'rental' | 'service';

  @ApiPropertyOptional({ example: 499 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @ApiPropertyOptional({ example: '9988' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  hsnSac?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class CreateInventoryUnitDto {
  @ApiPropertyOptional({ description: 'Legacy alias for locationId' })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Legacy alias for productId' })
  @IsOptional()
  @IsUUID()
  productStyleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiProperty({ example: 'UNIT-0001' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  barcodeSku!: string;

  @ApiPropertyOptional({ example: '42', description: 'Legacy alias for variantLabel' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  size?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  variantLabel?: string;

  @ApiPropertyOptional({ enum: StockUnitCondition, default: StockUnitCondition.good })
  @IsOptional()
  @IsEnum(StockUnitCondition)
  condition?: StockUnitCondition;

  @ApiPropertyOptional({ enum: OwnershipType, default: OwnershipType.own })
  @IsOptional()
  @IsEnum(OwnershipType)
  ownership?: OwnershipType;

  @ApiPropertyOptional({ description: 'Legacy uppercase or new lowercase status' })
  @IsOptional()
  @IsString()
  availabilityStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiProperty({ example: 2500 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  rentalPrice!: number;

  @ApiPropertyOptional({ example: 5000, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  depositAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  purchaseCost?: number;
}

export class ListUnitsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Legacy alias for locationId' })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Legacy alias for productId' })
  @IsOptional()
  @IsUUID()
  productStyleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ description: 'Legacy alias for variantLabel' })
  @IsOptional()
  @IsString()
  size?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantLabel?: string;

  @ApiPropertyOptional({ description: 'Legacy uppercase or new lowercase status' })
  @IsOptional()
  @IsString()
  availabilityStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Exact barcode / SKU' })
  @IsOptional()
  @IsString()
  barcodeSku?: string;
}

export class AvailabilityQueryDto {
  @ApiProperty({ example: '2026-12-10' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-12-12' })
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productStyleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ example: '42' })
  @IsOptional()
  @IsString()
  size?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  variantLabel?: string;
}

export class ReserveUnitDto {
  @ApiPropertyOptional({ description: 'Legacy alias for stockUnitId' })
  @IsOptional()
  @IsUUID()
  inventoryUnitId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  stockUnitId?: string;

  @ApiProperty({ example: '2026-12-10' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-12-12' })
  @IsDateString()
  endDate!: string;
}

export class UpdateUnitStatusDto {
  @ApiProperty({ description: 'Legacy uppercase or new lowercase status' })
  @IsString()
  availabilityStatus!: string;

  @ApiPropertyOptional({ enum: StockUnitCondition })
  @IsOptional()
  @IsEnum(StockUnitCondition)
  condition?: StockUnitCondition;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class ReleaseReservationDto {
  @ApiPropertyOptional({ example: 'Customer cancelled' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

export class CreateRetailSkuDto {
  @ApiPropertyOptional({ description: 'Legacy alias for locationId' })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Legacy alias for productId' })
  @IsOptional()
  @IsUUID()
  productStyleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiProperty({ example: 'BOWTIE-BLK-01' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  sku!: string;

  @ApiProperty({ example: 799 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  sellPrice!: number;

  @ApiPropertyOptional({ example: 10, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  qtyOnHand?: number;
}

export class ListRetailSkusQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Legacy alias for locationId' })
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Legacy alias for productId' })
  @IsOptional()
  @IsUUID()
  productStyleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;
}
