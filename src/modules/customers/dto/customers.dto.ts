import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsInternationalPhone } from '../../../common/validators/is-international-phone';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Amit Kumar' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  fullName!: string;

  @ApiProperty({ example: '+919876543210' })
  @IsString()
  @IsInternationalPhone({
    message: 'phone must be a valid phone number (any country)',
  })
  phone!: string;

  @ApiPropertyOptional({ example: 'amit@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: '2026-12-15', description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    example: '1990-05-20',
    description: 'Birthday YYYY-MM-DD (optional reminders)',
  })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  marketingOptIn?: boolean;

  @ApiPropertyOptional({
    description: 'Max open dues; omit/null = unlimited',
    example: 5000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  creditLimit?: number | null;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  fullName?: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @IsString()
  @IsInternationalPhone({
    message: 'phone must be a valid phone number (any country)',
  })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  eventDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({ example: '1990-05-20' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  marketingOptIn?: boolean;

  @ApiPropertyOptional({
    description: 'Max open dues; null clears to unlimited',
    example: 5000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  creditLimit?: number | null;
}

export class ListCustomersQueryDto {
  @ApiPropertyOptional({ description: 'Search name / phone / email' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class CreateMeasurementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  heightCm?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  weightKg?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  chest?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  waist?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  inseam?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  sleeve?: number;

  @ApiPropertyOptional({ example: '9' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  shoeSize?: string;
}

export class PartyMemberInputDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional({ example: 'groom' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleLabel?: string;
}

export class CreatePartyDto {
  @ApiProperty({ example: 'Event group / crew name' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ example: '2026-12-15' })
  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @ApiPropertyOptional({ description: 'Primary / booking customer' })
  @IsOptional()
  @IsUUID()
  primaryCustomerId?: string;

  @ApiPropertyOptional({ type: [PartyMemberInputDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PartyMemberInputDto)
  members?: PartyMemberInputDto[];
}

export class AddPartyMemberDto {
  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional({ example: 'best_man' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  roleLabel?: string;
}

export class AdjustStoreCreditDto {
  @ApiProperty({ example: 500, description: 'Positive to credit wallet, negative to debit' })
  @Type(() => Number)
  @IsNumber()
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AddCustomerNoteDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class CrmListQueryDto {
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
