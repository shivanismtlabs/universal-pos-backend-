import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GlAccountType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class ListAccountsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'])
  type?: GlAccountType;

  @IsOptional()
  @IsString()
  active?: string;
}

export class CreateAccountDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] })
  @IsIn(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'])
  type!: GlAccountType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  subtype?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  subtype?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class JournalLineDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  debit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  credit?: number;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  taxId?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class CreateJournalDto {
  @IsDateString()
  entryDate!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

export class ListJournalsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  q?: string;
}

export class LedgerQueryDto {
  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class ReportRangeQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  compare?: string;

  @IsOptional()
  @IsDateString()
  asOf?: string;
}

export class CreatePeriodDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;
}

export class UpsertMappingDto {
  @IsString()
  mappingKey!: string;

  @IsUUID()
  accountId!: string;

  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class UpdateAccountingSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(['cash', 'accrual'])
  basis?: 'cash' | 'accrual';

  @IsOptional()
  @IsString()
  @MaxLength(3)
  baseCurrency?: string;

  @IsOptional()
  @Type(() => Number)
  fiscalYearStartMonth?: number;

  @IsOptional()
  @IsString()
  taxCountry?: string;

  @IsOptional()
  @IsBoolean()
  inventoryAccountingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  cogsEnabled?: boolean;
}

export class ConnectIntegrationDto {
  @IsOptional()
  @Transform(({ value }) => (value && typeof value === 'object' ? value : {}))
  config?: Record<string, unknown>;
}

export class UpsertExternalMappingDto {
  @IsString()
  entityType!: string;

  @IsString()
  localId!: string;

  @IsString()
  externalId!: string;

  @IsOptional()
  @IsString()
  externalName?: string;

  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class TallyExportDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}

export class ReverseJournalDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
