import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  DailySalesQueryDto,
  DateRangeQueryDto,
  InventoryReportsQueryDto,
  MonthlyEmailScheduleDto,
  MonthlySalesQueryDto,
  ProfitAndLossQueryDto,
  SlowMovingStockQueryDto,
  TopSellingProductsQueryDto,
  CustomerReportsQueryDto,
  EmployeeSalesQueryDto,
  UpsertMonthlyTargetDto,
} from './dto/reports.dto';
import { ReportsCustomersService } from './reports-customers.service';
import { ReportsEmployeesService } from './reports-employees.service';
import { ReportsFinanceService } from './reports-finance.service';
import { ReportsInventoryService } from './reports-inventory.service';
import { ReportsMonthlyService } from './reports-monthly.service';
import { ReportsPnlService } from './reports-pnl.service';
import { ReportsService } from './reports.service';
import { ReportsTopProductsService } from './reports-top-products.service';

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.finance)
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly monthly: ReportsMonthlyService,
    private readonly pnl: ReportsPnlService,
    private readonly inventory: ReportsInventoryService,
    private readonly topProducts: ReportsTopProductsService,
    private readonly customers: ReportsCustomersService,
    private readonly employees: ReportsEmployeesService,
    private readonly finance: ReportsFinanceService,
  ) {}

  @Get('tax')
  @ApiOperation({
    summary:
      'Tax report — output/input tax, CGST/SGST/IGST, net payable, invoice lines',
  })
  taxReport(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.finance.taxReport(user, query);
  }

  @Get('suppliers')
  @ApiOperation({
    summary:
      'Supplier / AP report — billed, paid, outstanding, aging buckets, PO count',
  })
  supplierReport(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.finance.supplierReport(user, query);
  }

  @Get('cash-flow')
  @ApiOperation({
    summary:
      'Cash flow — receipts, expenses, supplier payments, refunds, daily series',
  })
  cashFlow(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.finance.cashFlow(user, query);
  }

  @Get('expenses')
  @ApiOperation({
    summary:
      'Expense report — by category, daily series, petty cash, line items',
  })
  expenseReport(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.finance.expenseReport(user, query);
  }

  @Get('dashboard-finance')
  @ApiOperation({
    summary:
      'Compact finance KPIs for dashboard charts (tax, cash flow, expenses, AP)',
  })
  dashboardFinance(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.finance.dashboardFinance(user, query);
  }

  @Get('employee-sales')
  @ApiOperation({
    summary:
      'Employee sales leaderboard — sales, ATV, upsell, commission, refunds/voids, hours, sales/hour; optional transaction drill-down',
  })
  employeeSales(
    @CurrentUser() user: AuthUser,
    @Query() query: EmployeeSalesQueryDto,
  ) {
    return this.employees.employeeSales(user, query);
  }

  @Get('customers/purchase-history')
  @ApiOperation({
    summary: 'Customer purchase history — orders, lines, payment methods, branch',
  })
  customerPurchaseHistory(
    @CurrentUser() user: AuthUser,
    @Query() query: CustomerReportsQueryDto,
  ) {
    return this.customers.purchaseHistory(user, query);
  }

  @Get('customers/top')
  @ApiOperation({
    summary: 'Top customers by spend, visits, or profit contribution',
  })
  customerTop(
    @CurrentUser() user: AuthUser,
    @Query() query: CustomerReportsQueryDto,
  ) {
    return this.customers.topCustomers(user, query);
  }

  @Get('customers/new-vs-returning')
  @ApiOperation({
    summary: 'New vs returning customers trend with retention rate',
  })
  customerNewVsReturning(
    @CurrentUser() user: AuthUser,
    @Query() query: CustomerReportsQueryDto,
  ) {
    return this.customers.newVsReturning(user, query);
  }

  @Get('customers/rfm')
  @ApiOperation({
    summary: 'RFM segmentation — VIP, Loyal, At-Risk, Lost, New, Regular',
  })
  customerRfm(
    @CurrentUser() user: AuthUser,
    @Query() query: CustomerReportsQueryDto,
  ) {
    return this.customers.rfm(user, query);
  }

  @Get('customers/outstanding')
  @ApiOperation({
    summary: 'Outstanding balance / credit aging (0-30 / 30-60 / 60-90 / 90+)',
  })
  customerOutstanding(
    @CurrentUser() user: AuthUser,
    @Query() query: CustomerReportsQueryDto,
  ) {
    return this.customers.outstanding(user, query);
  }

  @Get('customers/loyalty')
  @ApiOperation({
    summary: 'Loyalty points earned / redeemed / balance / expiring per customer',
  })
  customerLoyalty(
    @CurrentUser() user: AuthUser,
    @Query() query: CustomerReportsQueryDto,
  ) {
    return this.customers.loyalty(user, query);
  }

  @Get('top-selling-products')
  @ApiOperation({
    summary:
      'Top-selling products / menu items / booked services — rank by revenue, units, margin, or orders; prior-period trend; optional basket pairs',
  })
  topSellingProducts(
    @CurrentUser() user: AuthUser,
    @Query() query: TopSellingProductsQueryDto,
  ) {
    return this.topProducts.topSelling(user, query);
  }

  @Get('daily-sales')
  @ApiOperation({
    summary:
      'Daily sales snapshot — KPIs, hourly trend, payments, categories, top items, register reconcile, comparisons',
  })
  dailySales(
    @CurrentUser() user: AuthUser,
    @Query() query: DailySalesQueryDto,
  ) {
    return this.reportsService.dailySales(user, query);
  }

  @Get('monthly-sales')
  @ApiOperation({
    summary:
      'Monthly sales trends — daily series, weeks, targets, branch/category share, MoM/YoY',
  })
  monthlySales(
    @CurrentUser() user: AuthUser,
    @Query() query: MonthlySalesQueryDto,
  ) {
    return this.monthly.monthlySales(user, query);
  }

  @Get('profit-and-loss')
  @ApiOperation({
    summary:
      'Profit & Loss statement — net sales, COGS/service cost, opex, operating & net profit',
  })
  profitAndLoss(
    @CurrentUser() user: AuthUser,
    @Query() query: ProfitAndLossQueryDto,
  ) {
    return this.pnl.profitAndLoss(user, query);
  }

  @Get('inventory/current-stock')
  @ApiOperation({
    summary:
      'Current stock — qty, unit cost, value, reorder, status (per branch or consolidated)',
  })
  inventoryCurrentStock(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryReportsQueryDto,
  ) {
    return this.inventory.currentStock(user, query);
  }

  @Get('inventory/stock-movement')
  @ApiOperation({
    summary:
      'Stock movement / ledger — in/out/adjust events with running balance',
  })
  inventoryStockMovement(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryReportsQueryDto,
  ) {
    return this.inventory.stockMovement(user, query);
  }

  @Get('inventory/valuation')
  @ApiOperation({
    summary:
      'Stock valuation — FIFO / LIFO / weighted average / standard, by category & branch',
  })
  inventoryValuation(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryReportsQueryDto,
  ) {
    return this.inventory.valuation(user, query);
  }

  @Get('inventory/adjustments')
  @ApiOperation({
    summary:
      'Stock adjustment / wastage — damage, audit, write-off with reason & approver',
  })
  inventoryAdjustments(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryReportsQueryDto,
  ) {
    return this.inventory.adjustments(user, query);
  }

  @Get('inventory/reorder-suggestions')
  @ApiOperation({
    summary:
      'Reorder suggestions — below threshold with velocity-based suggested qty',
  })
  inventoryReorder(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryReportsQueryDto,
  ) {
    return this.inventory.reorderSuggestions(user, query);
  }

  @Get('inventory/expiry')
  @ApiOperation({
    summary:
      'Expiry report — batches nearing expiry within 30/60/90 day window',
  })
  inventoryExpiry(
    @CurrentUser() user: AuthUser,
    @Query() query: InventoryReportsQueryDto,
  ) {
    return this.inventory.expiry(user, query);
  }

  @Get('inventory/slow-moving')
  @ApiOperation({
    summary:
      'Slow-moving / dead stock — no sales for N days, capital locked, suggested actions, staleness histogram',
  })
  inventorySlowMoving(
    @CurrentUser() user: AuthUser,
    @Query() query: SlowMovingStockQueryDto,
  ) {
    return this.inventory.slowMoving(user, query);
  }

  @Get('monthly-sales/email-schedule')
  @ApiOperation({ summary: 'Get auto-email schedule for prior-month report' })
  getMonthlyEmailSchedule(@CurrentUser() user: AuthUser) {
    return this.monthly.getSchedule(user);
  }

  @Patch('monthly-sales/email-schedule')
  @ApiOperation({
    summary:
      'Enable/disable monthly email on the 1st (cron should hit send-scheduled daily)',
  })
  updateMonthlyEmailSchedule(
    @CurrentUser() user: AuthUser,
    @Body() dto: MonthlyEmailScheduleDto,
  ) {
    return this.monthly.updateSchedule(user, dto);
  }

  @Post('monthly-sales/send-scheduled')
  @ApiOperation({
    summary:
      'Send prior-month report emails (runs on 1st in tenant TZ unless force=true)',
  })
  sendMonthlyScheduled(
    @CurrentUser() user: AuthUser,
    @Query('force') force?: string,
  ) {
    return this.monthly.sendScheduledPriorMonth(
      user,
      force === '1' || force === 'true',
    );
  }

  @Patch('monthly-sales/target')
  @ApiOperation({ summary: 'Set or clear monthly sales target amount' })
  upsertMonthlyTarget(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertMonthlyTargetDto,
  ) {
    return this.monthly.upsertTarget(user, dto);
  }

  @Get('sales-summary')
  @ApiOperation({
    summary: 'Order counts by status + subtotal/tax/balance sums',
  })
  salesSummary(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.reportsService.salesSummary(user, query);
  }

  @Get('payments-summary')
  @ApiOperation({ summary: 'Succeeded payments summed by method' })
  paymentsSummary(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.reportsService.paymentsSummary(user, query);
  }

  @Get('inventory-utilization')
  @ApiOperation({ summary: 'Inventory unit counts by availability status' })
  inventoryUtilization(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.reportsService.inventoryUtilization(user, query);
  }

  @Get('balances')
  @ApiOperation({ summary: 'Orders with outstanding balance (top 50)' })
  balances(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.reportsService.balances(user, query);
  }

  @Get('product-velocity')
  @ApiOperation({ summary: 'Top and slow product movers by qty' })
  productVelocity(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.reportsService.productVelocity(user, query);
  }

  @Get('staff-sales')
  @ApiOperation({ summary: 'Sales attributed to staff who created orders' })
  staffSales(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.reportsService.staffSales(user, query);
  }

  @Get('tax-summary')
  @ApiOperation({ summary: 'Tax totals from orders + GST invoice lines' })
  taxSummary(
    @CurrentUser() user: AuthUser,
    @Query() query: DateRangeQueryDto,
  ) {
    return this.reportsService.taxSummary(user, query);
  }
}
