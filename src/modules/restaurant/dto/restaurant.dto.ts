import { DINING_MODES, GUEST_OCCASIONS, GUEST_REQUESTS } from '../restaurant-policy';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DiningMode,
  DiningTableStatus,
  KitchenTicketStatus,
  RestaurantOrderChannel,
} from '@prisma/client';

export class UpsertRestaurantConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ example: ['dine_in', 'takeaway'] })
  @IsOptional()
  @IsArray()
  @IsIn([...DINING_MODES], { each: true })
  enabledDiningModes?: string[];

  @IsOptional()
  @IsBoolean()
  tableManagement?: boolean;

  @IsOptional()
  @IsBoolean()
  kotEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  kdsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  captainOrdering?: boolean;

  @IsOptional()
  @IsBoolean()
  qrOrdering?: boolean;

  @IsOptional()
  @IsBoolean()
  onlineOrdering?: boolean;

  @IsOptional()
  @IsBoolean()
  recipesEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  reservationsEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  tokenManagement?: boolean;

  @ApiPropertyOptional({ enum: ['order_finalize', 'kot_confirm'] })
  @IsOptional()
  @IsIn(['order_finalize', 'kot_confirm'])
  consumptionPolicy?: 'order_finalize' | 'kot_confirm';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  serviceChargePercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  packagingCharge?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deliveryCharge?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(180)
  prepWarnMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  prepCriticalMinutes?: number;

  @IsOptional()
  @IsBoolean()
  otpOnQrOrder?: boolean;

  /** Named selling lists (POS / QR / outlet). Stored on config meta — not a restaurant-only catalog. */
  @IsOptional()
  @IsArray()
  sellingMenus?: unknown[];
}

export class CreateFloorDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpdateFloorDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @Transform(({ value }) =>
    value === null || value === '' ? null : value,
  )
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRatePercent?: number | null;

  @IsOptional()
  @Transform(({ value }) =>
    value === null || value === '' ? null : value,
  )
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  serviceChargePercent?: number | null;
}

export class CreateStationDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  code!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  printerName?: string;
}

export class UpdateStationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined)
  @IsString()
  @MaxLength(80)
  printerName?: string | null;
}

export class CreateDiningTableDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsUUID()
  floorId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  capacity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpdateDiningTableDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== undefined && v !== '')
  @IsUUID()
  floorId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  capacity?: number;

  @IsOptional()
  @IsIn(['available', 'occupied', 'reserved', 'cleaning', 'blocked'])
  status?: DiningTableStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  layoutX?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  layoutY?: number;
}

export class OpenTableDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  covers?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  guestName?: string;
}

export class MoveTableDto {
  @ApiProperty()
  @IsUUID()
  toTableId!: string;
}

export class MergeTablesDto {
  @ApiProperty()
  @IsUUID()
  sourceTableId!: string;

  @ApiProperty()
  @IsUUID()
  targetTableId!: string;
}

export class SplitItemsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  orderItemIds!: string[];

  @IsOptional()
  @IsUUID()
  toTableId?: string;
}

export class TransferItemsDto {
  @IsUUID()
  toOrderId!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  orderItemIds!: string[];
}

export class OpenDiningOrderDto {
  @IsUUID()
  locationId!: string;

  @IsIn(['dine_in', 'takeaway', 'delivery', 'pickup', 'online'])
  diningMode!: DiningMode;

  @IsOptional()
  @IsUUID()
  tableId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  covers?: number;

  @IsOptional()
  @IsIn(['pos', 'qr', 'website', 'aggregator', 'phone', 'manual'])
  channel?: RestaurantOrderChannel;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  guestName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  note?: string;

  /** Split bills may stay on the same table without occupying a second seat. */
  @IsOptional()
  @IsBoolean()
  skipTableRequirement?: boolean;
}

export class PatchGuestSpecialsDto {
  @IsOptional()
  @IsIn([...GUEST_OCCASIONS])
  occasion?: string;

  @IsOptional()
  @IsArray()
  @IsIn([...GUEST_REQUESTS], { each: true })
  requests?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}

export class SendKotDto {
  @IsOptional()
  @IsUUID()
  stationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  specialInstructions?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9)
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  idempotencyKey?: string;
}

export class UpdateKotStatusDto {
  @IsOptional()
  @IsIn(['new', 'accepted', 'preparing', 'ready', 'served', 'cancelled'])
  status?: KitchenTicketStatus;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  cancelReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  specialInstructions?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9)
  priority?: number;

  @IsOptional()
  @IsUUID()
  lineId?: string;
}

export class VoidDiningOrderDto {
  @IsString()
  @MinLength(3)
  @MaxLength(240)
  reason!: string;
}

export class ListKotQueryDto {
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @IsOptional()
  @IsIn(['new', 'accepted', 'preparing', 'ready', 'served', 'cancelled'])
  status?: KitchenTicketStatus;

  @IsOptional()
  @IsUUID()
  stationId?: string;
}

export class RecipeLineDto {
  @IsUUID()
  componentProductId!: string;

  @IsOptional()
  @IsUUID()
  componentVariantId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  unit?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  wastagePercent?: number;

  @IsOptional()
  @IsUUID()
  stageId?: string;

  @IsOptional()
  @IsIn(['recipe', 'production'])
  purpose?: string;
}

export class UpsertRecipeDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RecipeLineDto)
  lines!: RecipeLineDto[];
}

export class CreateRecipeStageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsUUID()
  outputProductId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  outputQty?: number;
}

export class CompleteProductionStageDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  productId!: string;

  @IsUUID()
  stageId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  qty!: number;
}

export class CreateModifierGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minSelect?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxSelect?: number;

  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

export class CreateModifierOptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  priceDelta?: number;

  @IsOptional()
  @IsUUID()
  linkedProductId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  consumeQty?: number;
}

export class AttachModifierGroupDto {
  @IsUUID()
  groupId!: string;
}

export class RecordWastageDto {
  @IsUUID()
  locationId!: string;

  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsUUID()
  stockLevelId?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  qty!: number;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  unit?: string;

  @IsString()
  @MaxLength(40)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  notes?: string;
}

export class QrOrderLineDto {
  @IsUUID()
  stockLevelId!: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modifiers?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(160)
  note?: string;
}

export class QrPlaceOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QrOrderLineDto)
  items!: QrOrderLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  guestName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  covers?: number;
}

export class CreateReservationDto {
  @IsUUID()
  locationId!: string;

  @IsOptional()
  @IsUUID()
  tableId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  guestName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  guestPhone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  covers?: number;

  @IsString()
  startAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  notes?: string;
}

export class UpdateReservationDto {
  @IsOptional()
  @IsIn(['booked', 'seated', 'cancelled', 'no_show', 'completed'])
  status?: string;
}
