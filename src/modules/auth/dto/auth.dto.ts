import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsInternationalPhone } from '../../../common/validators/is-international-phone';
import { IsStrongPassword } from '../password.policy';

const toLowerTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Empty string / null → undefined so @IsOptional works */
const optionalLowerTrim = ({ value }: { value: unknown }) => {
  if (value == null || value === '') return undefined;
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
};

export class RegisterTenantDto {
  @ApiProperty({ example: 'Demo Tuxedo Shop' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  tenantName!: string;

  @ApiPropertyOptional({
    example: 'demo-shop',
    description: 'Optional — auto-generated from shop name when omitted',
  })
  @Transform(optionalLowerTrim)
  @IsOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'tenantSlug must be lowercase kebab-case (a-z, 0-9, hyphens)',
  })
  @MinLength(2)
  @MaxLength(50)
  tenantSlug?: string;

  @ApiPropertyOptional({
    example: '27AAAAA0000A1Z5',
    description: 'Legacy GSTIN field — mapped to taxId',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i, {
    message: 'gstin must be a valid GSTIN format',
  })
  @MaxLength(15)
  gstin?: string;

  @ApiPropertyOptional({
    example: '29AABCU9603R1ZM',
    description: 'Universal tax id (GSTIN / VAT / EIN)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxId?: string;

  @ApiPropertyOptional({
    example: 'Main Store',
    description: 'Optional — defaults to shop name',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  storeName?: string;

  @ApiProperty({ example: 'Shop Admin' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  adminFullName!: string;

  @ApiProperty({ example: 'admin@demo-shop.com' })
  @Transform(toLowerTrim)
  @IsEmail()
  @MaxLength(255)
  adminEmail!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Upper + lower + number + special, 8–72 chars',
  })
  @IsString()
  @IsStrongPassword()
  adminPassword!: string;

  @ApiPropertyOptional({ example: '+12042347762' })
  @IsOptional()
  @IsString()
  @IsInternationalPhone({
    message: 'adminPhone must be a valid phone number (any country)',
  })
  adminPhone?: string;
}

export class RegisterUserDto {
  @ApiProperty({ example: 'demo-shop', description: 'Existing shop slug' })
  @Transform(toLowerTrim)
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'tenantSlug must be lowercase kebab-case (a-z, 0-9, hyphens)',
  })
  @MinLength(2)
  @MaxLength(50)
  tenantSlug!: string;

  @ApiProperty({ example: 'Jane Cashier' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  fullName!: string;

  @ApiProperty({ example: 'jane@demo-shop.com' })
  @Transform(toLowerTrim)
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Upper + lower + number + special, 8–72 chars',
  })
  @IsString()
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional({ example: '+12042347762' })
  @IsOptional()
  @IsString()
  @IsInternationalPhone({
    message: 'phone must be a valid phone number (any country)',
  })
  phone?: string;
}

export class LoginDto {
  @ApiPropertyOptional({
    example: 'demo-shop',
    description: 'Optional — if omitted, login resolves tenant from email',
  })
  @Transform(optionalLowerTrim)
  @IsOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  tenantSlug?: string;

  @ApiProperty({ example: 'admin@demo-shop.com' })
  @Transform(toLowerTrim)
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'JWT refresh token' })
  @IsString()
  @MinLength(20)
  refreshToken!: string;
}

export class GoogleAuthDto {
  @ApiProperty({ description: 'Google ID token from GIS' })
  @IsString()
  @MinLength(20)
  idToken!: string;

  @ApiProperty({ enum: ['login', 'register'] })
  @IsIn(['login', 'register'])
  mode!: 'login' | 'register';

  @ApiPropertyOptional({
    description: 'Required when mode=register — new shop name',
    example: 'City Furniture',
  })
  @ValidateIf((o: GoogleAuthDto) => o.mode === 'register')
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  tenantName?: string;
}

export class SetPinDto {
  @ApiProperty({
    example: '482915',
    description: '4–6 digit staff PIN (never logged)',
  })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4–6 digits' })
  pin!: string;
}

export class PinLoginDto {
  @ApiProperty({ description: 'Counter location id' })
  @IsUUID()
  locationId!: string;

  @ApiProperty({ description: 'Staff user to switch to' })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    example: '482915',
    description: 'Staff PIN (never logged)',
  })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4–6 digits' })
  pin!: string;
}
