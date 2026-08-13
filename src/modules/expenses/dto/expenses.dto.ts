import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const EXPENSE_PAYMENT_METHODS = [
  'cash',
  'upi',
  'card',
  'bank_transfer',
  'petty_cash',
  'other',
] as const;

export type ExpensePaymentMethod = (typeof EXPENSE_PAYMENT_METHODS)[number];

export class CreateExpenseCategoryDto {
  @ApiProperty({ example: 'Rent' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  receiptRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  accountCode?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class UpdateExpenseCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  receiptRequired?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  accountCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;
}

export class ListExpenseCategoriesQueryDto {
  @ApiPropertyOptional({ description: 'When true, only active categories' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  activeOnly?: boolean;
}

export class CreateExpenseDto {
  @ApiProperty({ example: 500 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ example: '2026-08-10' })
  @IsDateString()
  spentAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({
    example: 'cash',
    enum: EXPENSE_PAYMENT_METHODS,
  })
  @IsOptional()
  @IsIn([...EXPENSE_PAYMENT_METHODS])
  paymentMethod?: ExpensePaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  payee?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPettyCash?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isReimbursement?: boolean;

  @ApiPropertyOptional({
    description: 'Apply tenant tax profile (default true unless taxMode none)',
  })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional({
    description:
      'Finance approver may skip receipt when category.receiptRequired',
  })
  @IsOptional()
  @IsBoolean()
  receiptOverride?: boolean;

  @ApiPropertyOptional({ description: 'Save as draft without approval flow' })
  @IsOptional()
  @IsBoolean()
  saveAsDraft?: boolean;

  @ApiPropertyOptional({
    description: 'Client idempotency key (unique per tenant)',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(120)
  idempotencyKey?: string;

  @ApiPropertyOptional({ description: 'Receipt image as data URL or base64' })
  @IsOptional()
  @IsString()
  receiptBase64?: string;
}

export class UpdateExpenseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  spentAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ enum: EXPENSE_PAYMENT_METHODS })
  @IsOptional()
  @IsIn([...EXPENSE_PAYMENT_METHODS])
  paymentMethod?: ExpensePaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  payee?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPettyCash?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isReimbursement?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  receiptOverride?: boolean;

  @ApiPropertyOptional({
    description: 'When true on a draft, submit into approval flow',
  })
  @IsOptional()
  @IsBoolean()
  submitDraft?: boolean;

  @ApiPropertyOptional({ description: 'Receipt image as data URL or base64' })
  @IsOptional()
  @IsString()
  receiptBase64?: string;
}

export class UploadExpenseReceiptDto {
  @ApiProperty({ description: 'Image as data URL or raw base64' })
  @IsString()
  @MinLength(8)
  imageBase64!: string;
}

export class RejectExpenseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListExpensesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    enum: ['draft', 'pending', 'approved', 'rejected', 'voided', 'all'],
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  pettyCash?: boolean;
}

export class ExpenseSummaryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class PettyCashQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class PettyCashLedgerQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class PettyCashOpeningDto {
  @ApiProperty({ example: 5000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class PettyCashReplenishDto {
  @ApiProperty({ example: 2000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    enum: ['cash', 'upi', 'card', 'bank_transfer', 'other'],
  })
  @IsOptional()
  @IsIn(['cash', 'upi', 'card', 'bank_transfer', 'other'])
  paymentMethod?: string;
}

export class PettyCashAdjustDto {
  @ApiProperty({ example: 100 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ enum: ['credit', 'debit'] })
  @IsIn(['credit', 'debit'])
  direction!: 'credit' | 'debit';

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  notes!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  locationId?: string;
}
