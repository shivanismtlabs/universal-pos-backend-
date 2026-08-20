import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class NotificationTypeSettingDto {
  @IsString()
  code!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recipientRoles?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  digestMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  reAlertHours?: number;
}

export class UpdateTenantNotificationSettingsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NotificationTypeSettingDto)
  types!: NotificationTypeSettingDto[];
}

export class UserPrefDto {
  @IsString()
  type!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  inApp?: boolean;

  @IsOptional()
  @IsBoolean()
  email?: boolean;

  @IsOptional()
  @IsBoolean()
  push?: boolean;

  @IsOptional()
  @IsBoolean()
  sms?: boolean;
}

export class UpdateUserNotificationPrefsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserPrefDto)
  prefs!: UserPrefDto[];
}

export class ListInboxQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}

export class RegisterPushTokenDto {
  @IsString()
  token!: string;

  @ApiPropertyOptional({ description: 'web | android | ios' })
  @IsOptional()
  @IsString()
  platform?: string;
}

export class UnregisterPushTokenDto {
  @IsString()
  token!: string;
}
