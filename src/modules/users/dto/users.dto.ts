import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
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

  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @IsString()
  @Matches(/^[6-9]\d{9}$/, {
    message: 'phone must be a valid 10-digit Indian mobile',
  })
  phone?: string;

  @ApiProperty({
    example: 'Password123!',
    description: 'Upper + lower + number + special, 8–72 chars',
  })
  @IsString()
  @IsStrongPassword()
  password!: string;

  @ApiPropertyOptional({ example: 'staff', default: 'staff' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  roleCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  primaryStoreId?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  fullName?: string;

  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @IsString()
  @Matches(/^[6-9]\d{9}$/, {
    message: 'phone must be a valid 10-digit Indian mobile',
  })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  primaryStoreId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AssignRoleDto {
  @ApiProperty({ example: 'cashier' })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  roleCode!: string;
}
