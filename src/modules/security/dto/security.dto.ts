import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ListAuditQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class UpdateSecuritySettingsDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ipAllowlist?: string[];

  @ApiPropertyOptional({ description: '0 = disabled; max 480 minutes' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(480)
  idleTimeoutMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  encryptBackups?: boolean;
}

export class Enable2faDto {
  @ApiProperty()
  @IsString()
  @MaxLength(12)
  code!: string;
}

export class Disable2faDto {
  @ApiProperty()
  @IsString()
  @MaxLength(128)
  password!: string;
}

export class Login2faDto {
  @ApiProperty()
  @IsString()
  totpToken!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(16)
  code!: string;
}

export class RestoreBackupDto {
  @ApiProperty({ description: 'upos-backup-v1 JSON object' })
  @IsObject()
  backup!: Record<string, unknown>;
}
