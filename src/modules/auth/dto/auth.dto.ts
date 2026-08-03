import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsStrongPassword } from '../password.policy';

const toLowerTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterTenantDto {
  @ApiProperty({ example: 'Demo Tuxedo Shop' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  tenantName!: string;

  @ApiProperty({ example: 'demo-shop', description: 'lowercase slug' })
  @Transform(toLowerTrim)
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'tenantSlug must be lowercase kebab-case (a-z, 0-9, hyphens)',
  })
  @MinLength(2)
  @MaxLength(50)
  tenantSlug!: string;

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

  @ApiProperty({ example: 'Main Store', description: 'Primary location name' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  storeName!: string;

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

  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @IsString()
  @Matches(/^[6-9]\d{9}$/, {
    message: 'adminPhone must be a valid 10-digit Indian mobile number',
  })
  adminPhone?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'demo-shop' })
  @Transform(toLowerTrim)
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  tenantSlug!: string;

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
