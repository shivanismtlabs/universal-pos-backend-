import { ApiProperty } from '@nestjs/swagger';
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
