import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateTenantDto {
  @ApiPropertyOptional({ example: 'Demo Shop' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: '27AAAAA0000A1Z5' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i, {
    message: 'gstin must be a valid GSTIN format',
  })
  @MaxLength(15)
  gstin?: string;

  @ApiPropertyOptional({ example: '29AABCU9603R1ZM' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxId?: string;

  @ApiPropertyOptional({ example: 'INR' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currencyCode?: string;

  @ApiPropertyOptional({ example: 'en-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  locale?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Arbitrary branding JSON (logo, colors, etc)',
    example: { logoUrl: 'https://...', primaryColor: '#111827' },
  })
  @IsOptional()
  @IsObject()
  branding?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Arbitrary tenant settings JSON',
    example: { taxInclusive: true },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Crown Retail Pvt Ltd' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'LEGAL1' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class CreateLocationDto {
  @ApiProperty({ example: 'Downtown Branch' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 'DT01' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional({
    enum: ['store', 'branch', 'warehouse', 'clinic', 'kitchen', 'office', 'other'],
    default: 'store',
  })
  @IsOptional()
  @IsIn(['store', 'branch', 'warehouse', 'clinic', 'kitchen', 'office', 'other'])
  type?: 'store' | 'branch' | 'warehouse' | 'clinic' | 'kitchen' | 'office' | 'other';

  @ApiPropertyOptional({ example: '123 MG Road, Bengaluru' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: '29' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  regionCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Defaults code to MAIN when no code is given',
  })
  @IsOptional()
  @IsBoolean()
  isMain?: boolean;
}

/** @deprecated Use CreateLocationDto */
export class CreateStoreDto extends CreateLocationDto {}

export class UpdateLocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  regionCode?: string;

  @ApiPropertyOptional({
    enum: ['store', 'branch', 'warehouse', 'clinic', 'kitchen', 'office', 'other'],
  })
  @IsOptional()
  @IsIn(['store', 'branch', 'warehouse', 'clinic', 'kitchen', 'office', 'other'])
  type?: 'store' | 'branch' | 'warehouse' | 'clinic' | 'kitchen' | 'office' | 'other';
}

/** @deprecated Use UpdateLocationDto */
export class UpdateStoreDto extends UpdateLocationDto {}
