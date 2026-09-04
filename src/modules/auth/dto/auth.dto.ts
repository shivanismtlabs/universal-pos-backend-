import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
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

/** Optional custom item field when org business type is other */
export class CustomItemFieldDto {
  @ApiProperty({ example: 'Membership tier' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  label!: string;
}

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
  @IsNotEmpty({ message: 'Please enter your email address.' })
  @IsEmail({}, { message: 'Please enter a valid email address.' })
  @Matches(
    /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    { message: 'Enter a valid email address with a valid domain (e.g. name@company.com)' },
  )
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @MinLength(1, { message: 'Please enter your password.' })
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

  @ApiPropertyOptional({
    enum: ['login', 'register'],
    description: 'Optional — both modes open organization picker',
  })
  @IsOptional()
  @IsIn(['login', 'register'])
  mode?: 'login' | 'register';

  @ApiPropertyOptional({
    description: 'Deprecated in portal flow — create org on /organizations',
    example: 'City Furniture',
  })
  @IsOptional()
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

  @ApiPropertyOptional({
    example: '739204',
    description: 'Required when changing your own PIN if one is already set',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'Current PIN must be 4–6 digits' })
  currentPin?: string;
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

/** Zoho-style: create person account (not a shop yet) */
export class SignupIdentityDto {
  @ApiProperty({ example: 'Riya Sharma' })
  @IsString()
  @MinLength(2, { message: 'Enter at least 2 characters' })
  @MaxLength(255, { message: 'Name is too long' })
  fullName!: string;

  @ApiProperty({ example: 'riya@shop.com' })
  @Transform(toLowerTrim)
  @IsEmail({}, { message: 'Enter a valid email' })
  @Matches(
    /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    { message: 'Enter a valid email address with a valid domain (e.g. name@company.com)' },
  )
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString()
  @IsStrongPassword()
  password!: string;

  @ApiProperty({ example: '+919876543210' })
  @IsString()
  @IsInternationalPhone({
    message: 'Enter a valid phone number for the selected country',
  })
  phone!: string;
}

/** Zoho organization setup after identity */
export class CreateOrganizationDto {
  @ApiProperty({ example: 'City Apparel Store' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  organizationName!: string;

  /**
   * Universal POS vertical profile (BusinessConfig registry id).
   * Drives item/order extras, billing style, default commerce modes.
   */
  @ApiProperty({
    example: 'retail',
    description:
      'Setup template id, or any free-text industry. Unknown values map to Other — POS still runs.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  businessType!: string;

  @ApiPropertyOptional({
    example: 'Swimming academy',
    description:
      'When type is Other / unlisted — what the merchant calls their business',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  businessLabel?: string;

  /**
   * When businessType is other/general — extra item form fields (→ business_configs.item_fields).
   */
  @ApiPropertyOptional({
    description: 'Custom item field labels for Other profile',
    example: [{ label: 'Membership tier' }, { label: 'Session mins' }],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => CustomItemFieldDto)
  customItemFields?: CustomItemFieldDto[];

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: '12 MG Road' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine1?: string;

  @ApiPropertyOptional({ example: 'Bengaluru' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    example: 'Karnataka',
    description: 'State / province (India GST uses this)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional({ example: '560001' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @ApiPropertyOptional({ example: 'IN' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @ApiPropertyOptional({ example: 'INR' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currencyCode?: string;

  @ApiPropertyOptional({ example: 'en-IN' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  locale?: string;

  @ApiPropertyOptional({
    example: 'April',
    description: 'Fiscal year start month name or 1–12',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  fiscalYearStart?: string;

  @ApiPropertyOptional({
    example: '2026-04-01',
    description: 'Inventory / books start date (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'inventoryStartDate must be YYYY-MM-DD',
  })
  inventoryStartDate?: string;

  @ApiPropertyOptional({ example: '29AABCU9603R1ZM' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxId?: string;

  @ApiPropertyOptional({ example: 'Main Store' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  storeName?: string;

  @ApiPropertyOptional({ example: 'billing@shop.example' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;

  @ApiPropertyOptional({ example: 'https://www.myshop.com' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @ApiPropertyOptional({ example: 'Floor 2, opposite metro' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  addressLine2?: string;

  @ApiPropertyOptional({ example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({
    example: 'proprietorship',
    description: 'Legal structure (Zoho org type)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  organizationType?: string;

  @ApiPropertyOptional({ example: 'ABCDE1234F' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  pan?: string;

  @ApiPropertyOptional({
    example: ['products', 'services'],
    isArray: true,
    description:
      'What the shop sells — maps to commerce modes when the industry is Other / unlisted',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sells?: string[];

  @ApiPropertyOptional({
    example: ['sale', 'service'],
    isArray: true,
    description: 'Explicit commerce modes (overrides sells and template defaults)',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  commerceModes?: string[];

  @ApiPropertyOptional({ example: 'city-apparel' })
  @Transform(optionalLowerTrim)
  @IsOptional()
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MinLength(2)
  @MaxLength(50)
  tenantSlug?: string;
}

export class SelectOrganizationDto {
  @ApiProperty()
  @IsUUID()
  tenantId!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'you@business.com' })
  @Transform(toLowerTrim)
  @IsEmail()
  @MaxLength(255)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty()
  @Transform(toLowerTrim)
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: '482915', description: '6-digit email OTP' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'OTP must be 6 digits' })
  otp!: string;

  @ApiProperty()
  @IsString()
  @IsStrongPassword()
  newPassword!: string;
}

export class ForgotPinDto {
  @ApiProperty({ description: 'Staff user who forgot their counter PIN' })
  @IsUUID()
  userId!: string;
}

export class ResetPinOtpDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ example: '482915' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'OTP must be 6 digits' })
  otp!: string;

  @ApiProperty({ example: '4829' })
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4–6 digits' })
  newPin!: string;
}
