import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

const APPOINTMENT_TYPES = [
  'fitting',
  'pickup',
  'return',
  'consultation',
  'other',
] as const;

export class CreateAppointmentDto {
  /** Preferred universal field */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** Legacy FE / smoke compat — maps to locationId */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  orderId?: string;

  /** Preferred universal field */
  @ApiPropertyOptional({ example: 'pickup' })
  @ValidateIf((o: CreateAppointmentDto) => !o.aptType)
  @IsString()
  @IsIn([...APPOINTMENT_TYPES])
  type?: string;

  /** Legacy FE / smoke compat — maps to type */
  @ApiPropertyOptional({ example: 'fitting' })
  @ValidateIf((o: CreateAppointmentDto) => !o.type)
  @IsString()
  @IsIn([...APPOINTMENT_TYPES])
  aptType?: string;

  @ApiProperty({ example: '2026-12-10T10:30:00.000Z' })
  @IsISO8601()
  startsAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** Legacy FE / smoke compat — maps to notes */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  fittingNotes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  alterationNeeds?: string;
}

export class ListAppointmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({ enum: AppointmentStatus })
  @IsOptional()
  @IsEnum(AppointmentStatus)
  status?: AppointmentStatus;

  @ApiPropertyOptional({ description: 'Range start (ISO), inclusive' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Range end (ISO), inclusive' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class UpdateAppointmentDto {
  @ApiPropertyOptional({ description: 'Updates notes' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignee?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional({ enum: AppointmentStatus })
  @IsOptional()
  @IsEnum(AppointmentStatus)
  status?: AppointmentStatus;
}
