import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateStripeIntentDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiProperty({ example: 4130 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({ enum: PaymentType, default: PaymentType.payment })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @ApiPropertyOptional({
    enum: PaymentMethod,
    default: PaymentMethod.card,
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Stable key for this checkout attempt (retries reuse it)',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  idempotencyKey?: string;
}

export class VerifyStripePaymentDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiProperty({ description: 'Stripe PaymentIntent id (pi_…)' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  paymentIntentId!: string;

  @ApiProperty({ example: 4130 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({ enum: PaymentType, default: PaymentType.payment })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @ApiPropertyOptional({
    enum: PaymentMethod,
    default: PaymentMethod.card,
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;
}
