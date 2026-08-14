import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SyncStatus } from '@prisma/client';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class CreateSyncEventDto {
  @ApiProperty({ example: 'device-abc-123' })
  @IsString()
  @MaxLength(255)
  deviceId!: string;

  @ApiProperty()
  @IsUUID()
  storeId!: string;

  @ApiProperty({
    example: 'evt-9f1c...',
    description: 'Client-generated idempotency key, unique per tenant',
  })
  @IsString()
  @MaxLength(255)
  clientEventId!: string;

  @ApiProperty({ example: 'order.created' })
  @IsString()
  @MaxLength(150)
  eventType!: string;

  @ApiProperty({ description: 'Arbitrary event payload captured offline' })
  @IsObject()
  payload!: Record<string, unknown>;
}

export class ListSyncEventsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class ResolveSyncEventDto {
  @ApiProperty({ enum: SyncStatus })
  @IsEnum(SyncStatus)
  syncStatus!: SyncStatus;
}

export class OfflineSnapshotQueryDto {
  @ApiProperty({ description: 'Branch / location to seed stock for' })
  @IsUUID()
  locationId!: string;

  @ApiPropertyOptional({
    description:
      'ISO timestamp — only return entities updated after this (incremental)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  since?: string;
}
