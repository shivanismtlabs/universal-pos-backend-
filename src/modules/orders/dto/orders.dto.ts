import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderKind, OrderStatus, RentalOrderLifecycle } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto';

/** Accepts new kinds + legacy rental_unit/retail/special */
const ITEM_KINDS = [
  'product',
  'service',
  'stock_unit',
  'fee',
  'discount',
  'custom',
  'rental_unit',
  'retail',
  'special',
] as const;

export class CreateOrderItemDto {
  @ApiPropertyOptional({
    enum: ITEM_KINDS,
    description: 'Use product/stock_unit; rental_unit/retail still accepted',
  })
  @IsOptional()
  @IsIn(ITEM_KINDS)
  itemType?: (typeof ITEM_KINDS)[number];

  @ApiPropertyOptional({ description: 'Alias for itemType' })
  @IsOptional()
  @IsIn(ITEM_KINDS)
  itemKind?: (typeof ITEM_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  inventoryUnitId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  stockUnitId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  retailSkuId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  stockLevelId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  wearerCustomerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  quantity?: number;

  @ApiPropertyOptional({ example: 2500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  taxAmount?: number;
}

export class CreateOrderDto {
  @ApiPropertyOptional({ description: 'Preferred' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  /** @deprecated use locationId */
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ enum: OrderKind, default: OrderKind.sale })
  @IsOptional()
  @IsEnum(OrderKind)
  kind?: OrderKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ example: '2026-12-15' })
  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @ApiPropertyOptional({ example: '2026-12-14' })
  @IsOptional()
  @IsDateString()
  pickupDate?: string;

  @ApiPropertyOptional({ example: '2026-12-16' })
  @IsOptional()
  @IsDateString()
  returnDueDate?: string;

  @ApiPropertyOptional({ type: [CreateOrderItemDto] })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items?: CreateOrderItemDto[];
}

export class ListOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ enum: OrderKind })
  @IsOptional()
  @IsEnum(OrderKind)
  kind?: OrderKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

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
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class UpdateOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  eventDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  pickupDate?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  returnDueDate?: string | null;

  @ApiPropertyOptional({
    description:
      'Capability-driven order metadata patch. Examples: tableId, orderType, covers, kitchenStatus, course.',
  })
  @IsOptional()
  @IsObject()
  meta?: Record<string, unknown>;
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}

export class UpdateRentalLifecycleDto {
  @ApiProperty({
    enum: RentalOrderLifecycle,
    description:
      'Rental module lifecycle (quote → reserved → checked_out → returned → …)',
  })
  @IsEnum(RentalOrderLifecycle)
  lifecycle!: RentalOrderLifecycle;
}
