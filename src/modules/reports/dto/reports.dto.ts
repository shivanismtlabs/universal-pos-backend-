import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class DateRangeQueryDto {
  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-01-31' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Filter by location (multi-store)' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({
    description: 'Response format. csv returns a file download.',
    enum: ['json', 'csv'],
  })
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}

/** Single-day sales snapshot for owners / managers */
export class DailySalesQueryDto {
  @ApiProperty({ example: '2026-08-13', description: 'Business day (YYYY-MM-DD)' })
  @IsDateString()
  date!: string;

  @ApiPropertyOptional({ description: 'Branch / store' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Cashier / staff who created the order' })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    description: 'Payment method filter (cash, card, upi, wallet, store_credit, …)',
  })
  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @ApiPropertyOptional({ description: 'Register / cash-drawer session' })
  @IsOptional()
  @IsUUID()
  registerSessionId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @ApiPropertyOptional({
    description: 'Transaction table sort',
    enum: ['createdAt', 'orderNumber', 'net', 'status'],
  })
  @IsOptional()
  @IsIn(['createdAt', 'orderNumber', 'net', 'status'])
  sortBy?: 'createdAt' | 'orderNumber' | 'net' | 'status';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';
}

export class MonthlySalesQueryDto {
  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ example: 8, description: '1–12 (calendar or fiscal month index)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({
    description: 'When true, year/month are fiscal (using tenant fiscalYearStart)',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  useFiscal?: boolean;

  @ApiPropertyOptional({
    description: 'Comma-separated location UUIDs; omit for all branches',
  })
  @IsOptional()
  @IsString()
  locationIds?: string;

  @ApiPropertyOptional({ description: 'Filter by product category' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    enum: ['previous_month', 'same_month_last_year'],
    description: 'Primary comparison highlight (both always returned)',
  })
  @IsOptional()
  @IsIn(['previous_month', 'same_month_last_year'])
  compareTo?: 'previous_month' | 'same_month_last_year';
}

export class MonthlyEmailScheduleDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recipients?: string[];
}

export class UpsertMonthlyTargetDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiPropertyOptional({ description: 'Omit or null to clear period target' })
  @IsOptional()
  @Type(() => Number)
  amount?: number | null;

  @ApiPropertyOptional({
    description: 'Also store as default monthlyTargetAmount',
  })
  @IsOptional()
  @IsBoolean()
  setAsDefault?: boolean;
}

export class ProfitAndLossQueryDto {
  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    enum: [
      'this_month',
      'last_month',
      'this_quarter',
      'this_year',
      'custom',
    ],
  })
  @IsOptional()
  @IsIn([
    'this_month',
    'last_month',
    'this_quarter',
    'this_year',
    'custom',
  ])
  preset?:
    | 'this_month'
    | 'last_month'
    | 'this_quarter'
    | 'this_year'
    | 'custom';

  @ApiPropertyOptional({
    description: 'Comma-separated location UUIDs; omit for consolidated',
  })
  @IsOptional()
  @IsString()
  locationIds?: string;

  @ApiPropertyOptional({
    description: 'Include comparison vs previous equal-length period',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  compare?: boolean;

  @ApiPropertyOptional({
    enum: ['standard', 'weighted_average', 'fifo'],
    description: 'Override tenant inventory costing method for this run',
  })
  @IsOptional()
  @IsIn(['standard', 'weighted_average', 'fifo'])
  costingMethod?: 'standard' | 'weighted_average' | 'fifo';
}

/** Shared filters for Inventory Reports suite */
export class InventoryReportsQueryDto {
  @ApiPropertyOptional({ description: 'Branch / store; omit for consolidated' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Comma-separated location UUIDs' })
  @IsOptional()
  @IsString()
  locationIds?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description: 'Filter items last purchased from this supplier',
  })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ description: 'Item name / SKU search' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    enum: ['standard', 'weighted_average', 'fifo', 'lifo'],
  })
  @IsOptional()
  @IsIn(['standard', 'weighted_average', 'fifo', 'lifo'])
  costingMethod?: 'standard' | 'weighted_average' | 'fifo' | 'lifo';

  @ApiPropertyOptional({
    enum: [30, 60, 90],
    description: 'Expiry urgency window (days)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([30, 60, 90])
  expiryWindowDays?: 30 | 60 | 90;

  @ApiPropertyOptional({
    enum: ['all', 'ingredient', 'finished'],
    description:
      'Restaurant-style split: raw ingredients vs finished / menu items',
  })
  @IsOptional()
  @IsIn(['all', 'ingredient', 'finished'])
  inventoryClass?: 'all' | 'ingredient' | 'finished';

  @ApiPropertyOptional({
    description: 'When true, roll stock levels up by product across branches',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  consolidated?: boolean;

  @ApiPropertyOptional({ default: 30, description: 'Sales velocity lookback days' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(180)
  velocityDays?: number;

  @ApiPropertyOptional({ default: 7, description: 'Default supplier lead time days' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  leadTimeDays?: number;

  @ApiPropertyOptional({ default: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/** Top-selling / top-booked products report */
export class TopSellingProductsQueryDto {
  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-13' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Branch / store' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Product / menu / service category' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    enum: ['revenue', 'units', 'margin', 'orders'],
    description:
      'Primary sort for the returned pool (FE can re-rank live among metrics)',
  })
  @IsOptional()
  @IsIn(['revenue', 'units', 'margin', 'orders'])
  rankBy?: 'revenue' | 'units' | 'margin' | 'orders';

  @ApiPropertyOptional({
    enum: [10, 20, 50, 100],
    description: 'How many ranked rows to return (pool always includes metrics)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([10, 20, 50, 100])
  topN?: 10 | 20 | 50 | 100;

  @ApiPropertyOptional({
    enum: ['all', 'breakfast', 'lunch', 'dinner'],
    description: 'Restaurant meal period (hour-of-day in tenant timezone)',
  })
  @IsOptional()
  @IsIn(['all', 'breakfast', 'lunch', 'dinner'])
  mealPeriod?: 'all' | 'breakfast' | 'lunch' | 'dinner';

  @ApiPropertyOptional({
    description: 'Include basket “frequently bought together” (default true)',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === false || value === 'false' || value === '0') return false;
    return value === true || value === 'true' || value === '1';
  })
  @IsBoolean()
  includeCrossSell?: boolean;
}

/** Slow-moving / dead stock — capital tied up with no recent sales */
export class SlowMovingStockQueryDto {
  @ApiPropertyOptional({
    enum: [30, 60, 90],
    description: 'No-sale threshold in days (default 60)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([30, 60, 90])
  inactiveDays?: 30 | 60 | 90;

  @ApiPropertyOptional({ description: 'Branch / store' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Product category' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Last goods-receipt supplier' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({
    description: 'Minimum stock value to include (focus on high-value dead stock)',
    example: 500,
  })
  @IsOptional()
  @Type(() => Number)
  minStockValue?: number;

  @ApiPropertyOptional({
    description: 'Days used to compute average monthly sales velocity (default 90)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(365)
  velocityLookbackDays?: number;

  @ApiPropertyOptional({ default: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/** Shared filters for Customer Reports suite */
export class CustomerReportsQueryDto {
  @ApiPropertyOptional({ example: '2026-07-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-13' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Branch / store' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ description: 'Customer for purchase-history drill-down' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    enum: ['spend', 'visits', 'profit'],
    description: 'Top-customers ranking metric',
  })
  @IsOptional()
  @IsIn(['spend', 'visits', 'profit'])
  rankBy?: 'spend' | 'visits' | 'profit';

  @ApiPropertyOptional({
    description:
      'RFM segment (VIP|Loyal|At-Risk|Lost|New|Regular) or meta tag value',
  })
  @IsOptional()
  @IsString()
  segment?: string;

  @ApiPropertyOptional({ description: 'Minimum period spend filter' })
  @IsOptional()
  @Type(() => Number)
  minSpend?: number;

  @ApiPropertyOptional({ description: 'Minimum outstanding due filter' })
  @IsOptional()
  @Type(() => Number)
  minDue?: number;

  @ApiPropertyOptional({ description: 'Search name / phone / email' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** Employee / staff sales performance report */
export class EmployeeSalesQueryDto {
  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-13' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Branch / store' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated user UUIDs; omit for all staff',
  })
  @IsOptional()
  @IsString()
  employeeIds?: string;

  @ApiPropertyOptional({
    description: 'Filter by role code (cashier, manager, fitter, …)',
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({
    description: 'Drill-down: include transaction log for this user',
  })
  @IsOptional()
  @IsUUID()
  detailUserId?: string;

  @ApiPropertyOptional({
    description: 'When true, productivity uses only sales during clocked shifts',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    return value === true || value === 'true' || value === '1';
  })
  @IsBoolean()
  shiftSalesOnly?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class ReportScheduleItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  id?: string;

  @ApiProperty({
    enum: [
      'sales_summary',
      'daily_sales',
      'rental_ops',
      'subscriptions',
      'inventory_utilization',
    ],
  })
  @IsIn([
    'sales_summary',
    'daily_sales',
    'rental_ops',
    'subscriptions',
    'inventory_utilization',
  ])
  reportKey!:
    | 'sales_summary'
    | 'daily_sales'
    | 'rental_ops'
    | 'subscriptions'
    | 'inventory_utilization';

  @ApiProperty({ enum: ['daily', 'weekly', 'monthly'] })
  @IsIn(['daily', 'weekly', 'monthly'])
  cadence!: 'daily' | 'weekly' | 'monthly';

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  recipients!: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpsertReportSchedulesDto {
  @ApiProperty({ type: [ReportScheduleItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReportScheduleItemDto)
  items!: ReportScheduleItemDto[];
}
