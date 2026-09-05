import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustomerSubscriptionStatus, PaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreatePlanDto {
  @ApiProperty({ example: 'Monthly Gym Access' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ example: 'PLAN-GYM-MONTH-01', minLength: 15, maxLength: 18 })
  @IsString()
  @MinLength(15)
  @MaxLength(18)
  sku!: string;

  @ApiProperty({ example: 999 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price!: number;

  @ApiPropertyOptional({ example: 30, description: 'Billing period in days' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3660)
  billingPeriodDays?: number;

  @ApiPropertyOptional({ example: 'month', description: 'Duration unit code/symbol' })
  @IsOptional()
  @IsString()
  durationUnit?: string;

  @ApiPropertyOptional({ example: 1, description: 'Duration quantity' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  durationQuantity?: number;
}

export class UpdatePlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3660)
  billingPeriodDays?: number;

  @ApiPropertyOptional({ example: 'month' })
  @IsOptional()
  @IsString()
  durationUnit?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  durationQuantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class EnrollSubscriptionDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional({ enum: PaymentMethod, default: PaymentMethod.cash })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ description: 'Idempotency key for the payment' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  idempotencyKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class RenewSubscriptionDto {
  @ApiPropertyOptional({ enum: PaymentMethod, default: PaymentMethod.cash })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  idempotencyKey?: string;
}

export class ListSubscriptionsQueryDto {
  @ApiPropertyOptional({ enum: CustomerSubscriptionStatus })
  @IsOptional()
  @IsEnum(CustomerSubscriptionStatus)
  status?: CustomerSubscriptionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CheckInSubscriptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  note?: string;
}

export class CreateServiceProductDto {
  @ApiProperty({ example: 'Haircut Classic' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({
    example: 'SVC-HAIR-30',
    description: '2–18 chars; letters, numbers, . _ - /',
    minLength: 2,
    maxLength: 18,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(18)
  sku!: string;

  @ApiProperty({ example: 350 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price!: number;

  @ApiPropertyOptional({ example: 45 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  durationMinutes?: number;

  @ApiPropertyOptional({ example: 'hour' })
  @IsOptional()
  @IsString()
  durationUnit?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  durationQuantity?: number;

  @ApiPropertyOptional({ example: 60, description: 'Optional session duration in minutes' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  sessionDurationMinutes?: number;
}

export class BillServiceDto {
  @ApiPropertyOptional({
    description: 'Omit for walk-in / anonymous counter charge',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiProperty()
  @IsUUID()
  productId!: string;

  @ApiPropertyOptional({ enum: ['cash', 'card', 'upi'] })
  @IsOptional()
  @IsIn(['cash', 'card', 'upi'])
  paymentMethod?: 'cash' | 'card' | 'upi';

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 99 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(99)
  quantity?: number;

  @ApiPropertyOptional({ example: 'hour' })
  @IsOptional()
  @IsString()
  orderedUnitSymbol?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  idempotencyKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Optional appointment to mark completed' })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;
}
