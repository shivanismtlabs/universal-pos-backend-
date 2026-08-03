import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AvailabilityStatus, Ownership, UnitCondition } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
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
  @ApiProperty()
  @IsUUID()
  storeId!: string;

  @ApiProperty()
  @IsUUID()
  productStyleId!: string;

  @ApiProperty({ example: 'UNIT-0001' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  barcodeSku!: string;

  @ApiProperty({ example: '42' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  size!: string;

  @ApiPropertyOptional({ enum: UnitCondition, default: UnitCondition.GOOD })
  @IsOptional()
  @IsEnum(UnitCondition)
  condition?: UnitCondition;

  @ApiPropertyOptional({ enum: Ownership, default: Ownership.own })
  @IsOptional()
  @IsEnum(Ownership)
  ownership?: Ownership;

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
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productStyleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  size?: string;

  @ApiPropertyOptional({ enum: AvailabilityStatus })
  @IsOptional()
  @IsEnum(AvailabilityStatus)
  availabilityStatus?: AvailabilityStatus;

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
  storeId?: string;

  @ApiPropertyOptional({ example: '42' })
  @IsOptional()
  @IsString()
  size?: string;
}

export class ReserveUnitDto {
  @ApiProperty()
  @IsUUID()
  inventoryUnitId!: string;

  @ApiProperty({ example: '2026-12-10' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({ example: '2026-12-12' })
  @IsDateString()
  endDate!: string;
}

export class UpdateUnitStatusDto {
  @ApiProperty({ enum: AvailabilityStatus })
  @IsEnum(AvailabilityStatus)
  availabilityStatus!: AvailabilityStatus;

  @ApiPropertyOptional({ enum: UnitCondition })
  @IsOptional()
  @IsEnum(UnitCondition)
  condition?: UnitCondition;

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
  @ApiProperty()
  @IsUUID()
  storeId!: string;

  @ApiProperty()
  @IsUUID()
  productStyleId!: string;

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
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productStyleId?: string;
}
