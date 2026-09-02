import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export enum StockAdjustmentStatusDto {
  draft = 'draft',
  pending = 'pending',
  adjusted = 'adjusted',
  cancelled = 'cancelled',
}

export enum StockAdjustmentTypeDto {
  quantity = 'quantity',
  value = 'value',
}

export class StockAdjustmentLineInputDto {
  @IsString()
  @MinLength(1)
  productId!: string;

  @IsOptional()
  @IsString()
  stockLevelId?: string;

  @IsNumber()
  @Type(() => Number)
  currentQty!: number;

  @IsNumber()
  @Type(() => Number)
  adjustmentQty!: number;

  @IsNumber()
  @Type(() => Number)
  newQty!: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsNumber()
  currentUnitCost?: number;

  @IsOptional()
  @IsNumber()
  adjustmentValue?: number;

  @IsOptional()
  @IsString()
  serialNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreateStockAdjustmentDto {
  @IsString()
  @MinLength(1)
  locationId!: string;

  @IsDateString()
  adjustmentDate!: string;

  @IsEnum(StockAdjustmentTypeDto)
  type!: StockAdjustmentTypeDto;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  attachments?: string[];

  @IsOptional()
  @IsEnum(StockAdjustmentStatusDto)
  status?: StockAdjustmentStatusDto;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => StockAdjustmentLineInputDto)
  lines!: StockAdjustmentLineInputDto[];
}

export class UpdateStockAdjustmentDto {
  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsDateString()
  adjustmentDate?: string;

  @IsOptional()
  @IsEnum(StockAdjustmentTypeDto)
  type?: StockAdjustmentTypeDto;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsArray()
  attachments?: string[];

  @IsOptional()
  @IsEnum(StockAdjustmentStatusDto)
  status?: StockAdjustmentStatusDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StockAdjustmentLineInputDto)
  lines?: StockAdjustmentLineInputDto[];
}

export class ListStockAdjustmentsQueryDto {
  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsEnum(StockAdjustmentStatusDto)
  status?: StockAdjustmentStatusDto;

  @IsOptional()
  @IsEnum(StockAdjustmentTypeDto)
  type?: StockAdjustmentTypeDto;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  /** Query strings must use @IsInt + @Type — @IsNumber() rejects "20". */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
