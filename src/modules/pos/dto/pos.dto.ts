import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PosPaymentInputDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ApiProperty({ example: 5000 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty({ description: 'Client-generated key for idempotent retries' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey!: string;

  @ApiPropertyOptional({ enum: PaymentType, default: PaymentType.payment })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;
}

export class CheckoutDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiProperty({ type: [PosPaymentInputDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PosPaymentInputDto)
  payments!: PosPaymentInputDto[];

  @ApiPropertyOptional({
    description: 'Move order to ready status if currently reserved/fitted',
  })
  @IsOptional()
  @IsBoolean()
  markReady?: boolean;
}
