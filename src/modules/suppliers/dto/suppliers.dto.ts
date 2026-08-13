import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PoType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateSupplierDto {
  @ApiProperty({ example: 'Metro Formal Wear Supply' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

export class UpdateSupplierDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contact?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

export class CreatePoLineDto {
  @ApiProperty({ description: 'Sale stock level (SKU) to restock' })
  @IsUUID()
  stockLevelId!: string;

  @ApiProperty({ example: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qtyOrdered!: number;

  @ApiPropertyOptional({ example: 45.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  unitCost?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiPropertyOptional({ enum: PoType })
  @IsOptional()
  @IsEnum(PoType)
  poType?: PoType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  linkedOrderId?: string;

  @ApiPropertyOptional({ example: '2026-08-15' })
  @IsOptional()
  @IsDateString()
  expectedDelivery?: string;

  @ApiPropertyOptional({ example: 'Tax 18% · Coupon SUMMER10' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ type: [CreatePoLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePoLineDto)
  lines?: CreatePoLineDto[];
}

export class UpdatePurchaseOrderDto {
  @ApiPropertyOptional({
    enum: ['draft', 'ordered', 'partial', 'received', 'cancelled'],
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  expectedDelivery?: string;
}

export class ReceivePoLineDto {
  @ApiProperty()
  @IsUUID()
  stockLevelId!: string;

  @ApiProperty({ example: 10 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty!: number;
}

export class ReceivePurchaseOrderDto {
  @ApiProperty({ type: [ReceivePoLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceivePoLineDto)
  lines!: ReceivePoLineDto[];
}

export class ReturnPurchaseOrderDto {
  @ApiProperty({ type: [ReceivePoLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReceivePoLineDto)
  lines!: ReceivePoLineDto[];

  @ApiPropertyOptional({ example: 'Damaged on arrive' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CreateSupplierInvoiceDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  purchaseOrderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  goodsReceiptId?: string;

  @ApiPropertyOptional({ example: 'SUP-INV-1001' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invoiceNumber?: string;

  @ApiPropertyOptional({ example: '2026-08-12' })
  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @ApiPropertyOptional({ example: '2026-09-12' })
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @ApiProperty({ example: 5000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  subtotal!: number;

  @ApiPropertyOptional({ example: 900 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  taxTotal?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** When true, bill is a credit note (reduces AP). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCredit?: boolean;
}

export class PaySupplierInvoiceDto {
  @ApiProperty({ example: 1000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({
    example: 'bank_transfer',
    description: 'cash | card | upi | bank_transfer | wallet | other',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreateSupplierPaymentDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supplierInvoiceId?: string;

  @ApiProperty({ example: 1000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({ example: 'bank_transfer' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
