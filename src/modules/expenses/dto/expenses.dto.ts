import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateExpenseCategoryDto {
  @ApiProperty({ example: 'Rent' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}

export class CreateExpenseDto {
  @ApiProperty({ example: 500 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ example: '2026-08-10' })
  @IsDateString()
  spentAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({
    example: 'cash',
    enum: ['cash', 'upi', 'card', 'bank_transfer'],
  })
  @IsOptional()
  @IsIn(['cash', 'upi', 'card', 'bank_transfer'])
  paymentMethod?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPettyCash?: boolean;

  @ApiPropertyOptional({ description: 'Receipt image as data URL or base64' })
  @IsOptional()
  @IsString()
  receiptBase64?: string;
}

export class UpdateExpenseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  spentAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['cash', 'upi', 'card', 'bank_transfer'])
  paymentMethod?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPettyCash?: boolean;
}

export class UploadExpenseReceiptDto {
  @ApiProperty({ description: 'Image as data URL or raw base64' })
  @IsString()
  @MinLength(8)
  imageBase64!: string;
}

export class RejectExpenseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListExpensesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected', 'voided', 'all'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  pettyCash?: boolean;
}
