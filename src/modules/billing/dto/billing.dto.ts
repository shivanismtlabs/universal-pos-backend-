import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FeeType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export enum LayawayStatus {
  pending = 'pending',
  paid = 'paid',
  waived = 'waived',
}

export class CreateOrderFeeDto {
  @ApiProperty({ enum: FeeType })
  @IsEnum(FeeType)
  feeType!: FeeType;

  @ApiProperty({ example: 500 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({ example: 'Returned 2 days late' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  inventoryUnitId?: string;
}

export class LayawayInstallmentInputDto {
  @ApiProperty({ example: '2026-12-01', description: 'YYYY-MM-DD' })
  @IsDateString()
  dueBy!: string;

  @ApiProperty({ example: 2500 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  installmentAmount!: number;
}

export class CreateLayawayDto {
  @ApiProperty({ type: [LayawayInstallmentInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => LayawayInstallmentInputDto)
  installments!: LayawayInstallmentInputDto[];
}

export class UpdateLayawayDto {
  @ApiProperty({ enum: LayawayStatus })
  @IsEnum(LayawayStatus)
  status!: LayawayStatus;
}

export class CreateInvoiceDto {
  @ApiPropertyOptional({ example: '27AAAAA0000A1Z5' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  gstin?: string;

  @ApiPropertyOptional({ example: 'Maharashtra' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  placeOfSupply?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Inter-state supply: charge IGST instead of CGST+SGST',
  })
  @IsOptional()
  @IsBoolean()
  useIgst?: boolean;
}

export class ApplyLateFeeDto {
  @ApiPropertyOptional({
    example: 200,
    description: 'INR per day overdue (default 200)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  dailyRate?: number;
}
