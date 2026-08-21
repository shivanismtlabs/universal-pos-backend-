import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CustomFieldEntity } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCustomFieldDefinitionDto {
  @ApiProperty({ enum: CustomFieldEntity })
  @IsEnum(CustomFieldEntity)
  entity!: CustomFieldEntity;

  @ApiProperty({ example: 'imei' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  fieldKey!: string;

  @ApiProperty({ example: 'IMEI' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @ApiPropertyOptional({
    description: 'text | number | boolean | date | select | multi_select | email | phone | currency',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  dataType!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({
    description: 'Select options: string[] or { options: string[] }',
  })
  @IsOptional()
  options?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  moduleCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpsertCustomFieldValueDto {
  @ApiProperty()
  @IsUUID()
  definitionId!: string;

  @ApiProperty()
  @IsUUID()
  entityId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  valueText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  valueNumber?: number;

  @ApiPropertyOptional()
  @IsOptional()
  valueJson?: unknown;
}

export class ListCustomFieldDefinitionsQueryDto {
  @ApiPropertyOptional({ enum: CustomFieldEntity })
  @IsOptional()
  @IsEnum(CustomFieldEntity)
  entity?: CustomFieldEntity;
}
