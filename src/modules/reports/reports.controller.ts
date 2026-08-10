import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { DateRangeQueryDto } from './dto/reports.dto';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.finance)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

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
