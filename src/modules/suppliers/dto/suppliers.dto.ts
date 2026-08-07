import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PoType } from '@prisma/client';
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
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateSupplierDto {
  @ApiProperty({ example: 'Metro Formal Wear Supply' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

export class CreatePoLineDto {
  @ApiProperty({ description: 'Sale stock level (SKU) to restock' })
  @IsUUID()
  stockLevelId!: string;

  @ApiProperty({ example: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qtyOrdered!: number;

  @ApiPropertyOptional({ example: 45.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitCost?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiPropertyOptional({ enum: PoType })
  @IsOptional()
  @IsEnum(PoType)
  poType?: PoType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  linkedOrderId?: string;

  @ApiPropertyOptional({ example: '2026-08-15' })
  @IsOptional()
  @IsDateString()
  expectedDelivery?: string;

  @ApiPropertyOptional({ type: [CreatePoLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePoLineDto)
  lines?: CreatePoLineDto[];
}

export class UpdatePurchaseOrderDto {
  @ApiPropertyOptional({
    enum: ['draft', 'ordered', 'partial', 'received', 'cancelled'],
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expectedDelivery?: string;
}

export class ReceivePoLineDto {
  @ApiProperty()
  @IsUUID()
  stockLevelId!: string;

  @ApiProperty({ example: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
}

export class ReceivePurchaseOrderDto {
  @ApiProperty({ type: [ReceivePoLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceivePoLineDto)
  lines!: ReceivePoLineDto[];
}
