import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsInternationalPhone } from '../../../common/validators/is-international-phone';
import { IsStrongPassword } from '../../auth/password.policy';

export class CreateUserDto {
  @ApiProperty({ example: 'cashier1@demo-shop.com' })
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @ApiProperty({ example: 'Priya Shah' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  fullName!: string;

  @ApiPropertyOptional({ example: '+12042347762' })
  @IsOptional()
  @IsString()
  @IsInternationalPhone({
    message: 'phone must be a valid phone number (any country)',
  })
  phone?: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Upper + lower + number + special, 8–72 chars',
  })
  @IsString()
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional({ example: 'cashier', default: 'staff' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  roleCode?: string;

  @ApiPropertyOptional({ description: 'Preferred field' })
  @IsOptional()
  @IsUUID()
  primaryLocationId?: string;

  /** @deprecated use primaryLocationId */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  primaryStoreId?: string;

  @ApiPropertyOptional({ example: 'Cashier' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  fullName?: string;

  @ApiPropertyOptional({ example: '+12042347762' })
  @IsOptional()
  @IsString()
  @IsInternationalPhone({
    message: 'phone must be a valid phone number (any country)',
  })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  primaryLocationId?: string;

  /** @deprecated use primaryLocationId */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  primaryStoreId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobTitle?: string;

  @ApiPropertyOptional({ example: 'cashier' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  roleCode?: string;
}

export class AssignRoleDto {
  @ApiProperty({ example: 'cashier' })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  roleCode!: string;

  @ApiPropertyOptional({ description: 'Scope role to a location' })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
