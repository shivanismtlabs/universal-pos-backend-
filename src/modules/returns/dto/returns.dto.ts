import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InspectStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class CreateReturnDto {
  @ApiProperty()
  @IsUUID()
  orderId!: string;

  @ApiProperty()
  @IsUUID()
  inventoryUnitId!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  cleaningRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  inspectNotes?: string;
}

export class ListReturnsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  orderId?: string;
}

export class DamageInputDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ example: 1500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  feeAmount?: number;
}

export class InspectReturnDto {
  @ApiProperty({ enum: InspectStatus })
  @IsEnum(InspectStatus)
  inspectStatus!: InspectStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  inspectNotes?: string;

  @ApiPropertyOptional({ type: DamageInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DamageInputDto)
  damage?: DamageInputDto;
}
