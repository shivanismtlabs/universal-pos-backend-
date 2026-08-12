import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationChannel } from '@prisma/client';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

export class SendNotificationDto {
  @ApiPropertyOptional({ description: 'Customer to notify (uses their phone)' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description: 'Override destination phone (10-digit or E.164)',
    example: '9811111111',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    description: 'Email destination (email channel)',
    example: 'customer@example.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string;

  @ApiProperty({ enum: NotificationChannel })
  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;

  @ApiProperty({ example: 'order_ready_for_pickup' })
  @IsString()
  @MaxLength(150)
  templateKey!: string;

  @ApiPropertyOptional({
    description: 'Template variables / custom message',
    example: { orderNumber: 'ORD-0001', customerName: 'Arjun' },
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class ListNotifyLogsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;
}
