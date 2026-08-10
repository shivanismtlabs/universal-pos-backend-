import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreatePlanDto {
  @ApiProperty({ example: 'pro' })
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'code must be lowercase kebab-case (a-z, 0-9, hyphens)',
  })
  @MinLength(2)
  @MaxLength(50)
  code!: string;

  @ApiProperty({ example: 'Pro Plan' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 2999 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  priceMonthly!: number;
}

export class CreateSubscriptionDto {
  @ApiProperty()
  @IsUUID()
  planId!: string;
}

export class CreatePlanCheckoutDto {
  @ApiProperty({ description: 'SaaS plan to purchase / upgrade to' })
  @IsUUID()
  planId!: string;

  @ApiProperty({
    example: 'http://13.126.105.138:3000/plan?checkout=success',
    description: 'Browser return URL after paid Stripe Checkout',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  successUrl!: string;

  @ApiProperty({
    example: 'http://13.126.105.138:3000/plan?checkout=cancel',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  cancelUrl!: string;
}

export class ConfirmPlanCheckoutDto {
  @ApiProperty({ description: 'Stripe Checkout Session id (cs_…)' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  sessionId!: string;
}
