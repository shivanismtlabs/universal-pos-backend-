import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderItemType, OrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
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

export class CreateOrderItemDto {
  @ApiProperty({ enum: OrderItemType })
  @IsEnum(OrderItemType)
  itemType!: OrderItemType;

  @ApiPropertyOptional({ description: 'Required when itemType = rental_unit' })
  @IsOptional()
  @IsUUID()
  inventoryUnitId?: string;

  @ApiPropertyOptional({ description: 'Required when itemType = retail' })
  @IsOptional()
  @IsUUID()
  retailSkuId?: string;

  @ApiPropertyOptional({ description: 'Party member wearing this item' })
  @IsOptional()
  @IsUUID()
  wearerCustomerId?: string;

  @ApiPropertyOptional({ example: '42' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  size?: string;

  @ApiPropertyOptional({
    example: 2500,
    description: 'Defaults to unit rentalPrice / SKU sellPrice when omitted',
  })
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
  discount?: number;

  @ApiPropertyOptional({ example: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  @ApiPropertyOptional({ type: Object, example: { cgst: 6, sgst: 6 } })
  @IsOptional()
  @IsObject()
  taxSplit?: Record<string, unknown>;
}

export class CreateOrderDto {
  @ApiProperty()
  @IsUUID()
  storeId!: string;

  @ApiProperty()
  @IsUUID()
  customerId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ example: '2026-12-15', description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @ApiPropertyOptional({ example: '2026-12-14', description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  pickupDate?: string;

  @ApiPropertyOptional({ example: '2026-12-16', description: 'YYYY-MM-DD' })
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  storeId?: string;

  @ApiPropertyOptional({ description: 'Search by order number' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class UpdateOrderDto {
  @ApiPropertyOptional({
    description: 'Only while status is quote/reserved/fitted',
  })
  @IsOptional()
  @IsUUID()
  partyId?: string;

  @ApiPropertyOptional({ example: '2026-12-15' })
  @IsOptional()
  @IsDateString()
  eventDate?: string | null;

  @ApiPropertyOptional({ example: '2026-12-14' })
  @IsOptional()
  @IsDateString()
  pickupDate?: string | null;

  @ApiPropertyOptional({ example: '2026-12-16' })
  @IsOptional()
  @IsDateString()
  returnDueDate?: string | null;
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  status!: OrderStatus;
}
