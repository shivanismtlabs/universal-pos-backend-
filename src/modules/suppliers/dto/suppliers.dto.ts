import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PoType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
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
