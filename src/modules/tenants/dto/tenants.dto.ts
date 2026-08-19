import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { TaxMode } from '@prisma/client';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TenantTaxSettingsDto {
  @ApiPropertyOptional({
    example: 5,
    description: 'GST/VAT rate percent (0–40). Default by taxMode when omitted.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(40)
  ratePercent?: number;

  @ApiPropertyOptional({
    example: false,
    description: 'When true, catalog prices already include tax',
  })
  @IsOptional()
  @IsBoolean()
  inclusive?: boolean;

  @ApiPropertyOptional({ example: 'Thank you for shopping with us.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  receiptFooter?: string;
}

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
  @ValidateIf((_, v) => typeof v === 'string' && v.trim().length > 0)
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i, {
    message: 'gstin must be a valid GSTIN format',
  })
  @MaxLength(15)
  gstin?: string;

  @ApiPropertyOptional({ example: '29AABCU9603R1ZM' })
  @IsOptional()
  @IsString()
  @ValidateIf((_, v) => typeof v === 'string' && v.trim().length > 0)
  @MaxLength(32)
  taxId?: string;

  @ApiPropertyOptional({ enum: TaxMode })
  @IsOptional()
  @IsIn(Object.values(TaxMode))
  taxMode?: TaxMode;

  @ApiPropertyOptional({ type: TenantTaxSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TenantTaxSettingsDto)
  tax?: TenantTaxSettingsDto;

  @ApiPropertyOptional({
    example: 15,
    description: 'Max discount % a cashier may apply without manager role',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxCashierDiscountPercent?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Enable PIN staff-switch on shared POS counters (default true)',
  })
  @IsOptional()
  @IsBoolean()
  pinSwitchEnabled?: boolean;

  @ApiPropertyOptional({
    example: 'shop@okaxis',
    description: 'Shop UPI VPA used for counter QR payments (pa=)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  upiVpa?: string;

  @ApiPropertyOptional({
    example: 'My Shop',
    description: 'Payee name shown on UPI apps (pn=)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  upiPayeeName?: string;

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
    description: 'Arbitrary tenant settings JSON (merged). Prefer tax DTO for tax.',
    example: { taxInclusive: true },
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Acme Retail Pvt Ltd' })
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

  @ApiPropertyOptional({ example: '+91 98765 43210' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ example: 'indore@shop.com' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ description: 'Branch manager user id' })
  @IsOptional()
  @IsUUID()
  managerUserId?: string;

  @ApiPropertyOptional({ example: 'Mon–Sat 10:00–21:00' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  businessHours?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ example: 'INR' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currencyCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  defaultWarehouseId?: string;

  @ApiPropertyOptional({
    description: 'Parent location (HQ / branch hierarchy)',
  })
  @IsOptional()
  @IsUUID()
  parentLocationId?: string;
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  managerUserId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  businessHours?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currencyCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  defaultWarehouseId?: string | null;

  @ApiPropertyOptional({
    description: 'Parent location (HQ / branch hierarchy); null clears',
  })
  @IsOptional()
  @IsUUID()
  parentLocationId?: string | null;
}

/** @deprecated Use UpdateLocationDto */
export class UpdateStoreDto extends UpdateLocationDto {}
