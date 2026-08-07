import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InspectStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class CreateReturnDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiPropertyOptional({
    description: 'Legacy alias — prefer stockUnitId',
  })
  @IsOptional()
  @IsUUID()
  inventoryUnitId?: string;

  @ApiPropertyOptional({ description: 'Serial unit being returned' })
  @IsOptional()
  @IsUUID()
  stockUnitId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  cleaningRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  inspectNotes?: string;
}

export class ListReturnsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

export class DamageInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ example: 1500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  feeAmount?: number;
}

export class SettleDepositDto {
  @ApiProperty({
    example: 500,
    description:
      'Amount of deposit to refund to the customer (0 = forfeit all remaining)',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  refundAmount!: number;

  @ApiProperty({ description: 'Idempotency key for the refund payment' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class InspectReturnDto {
  @ApiProperty({ enum: InspectStatus })
  @IsEnum(InspectStatus)
  inspectStatus!: InspectStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  inspectNotes?: string;

  @ApiPropertyOptional({ type: DamageInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DamageInputDto)
  damage?: DamageInputDto;
}
