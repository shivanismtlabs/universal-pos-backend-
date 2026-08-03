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
  inventoryUtilization(@CurrentUser() user: AuthUser) {
    return this.reportsService.inventoryUtilization(user);
  }

  @Get('balances')
  @ApiOperation({ summary: 'Orders with outstanding balance (top 50)' })
  balances(@CurrentUser() user: AuthUser) {
    return this.reportsService.balances(user);
  }
}
