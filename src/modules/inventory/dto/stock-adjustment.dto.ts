import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
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
  currentQty!: number;

  @IsNumber()
  adjustmentQty!: number;

  @IsNumber()
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

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  limit?: number;
}
