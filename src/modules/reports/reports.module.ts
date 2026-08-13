import { Module } from '@nestjs/common';
import { NotifyModule } from '../notify/notify.module';
import { ReportsController } from './reports.controller';
import { ReportsCustomersService } from './reports-customers.service';
import { ReportsEmployeesService } from './reports-employees.service';
import { ReportsFinanceService } from './reports-finance.service';
import { ReportsInventoryService } from './reports-inventory.service';
import { ReportsMonthlyService } from './reports-monthly.service';
import { ReportsPnlService } from './reports-pnl.service';
import { ReportsService } from './reports.service';
import { ReportsTopProductsService } from './reports-top-products.service';

/** Sales / inventory / customer / employee / finance reports — FR-RPT */
@Module({
  imports: [NotifyModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportsMonthlyService,
    ReportsPnlService,
    ReportsInventoryService,
    ReportsTopProductsService,
    ReportsCustomersService,
    ReportsEmployeesService,
    ReportsFinanceService,
  ],
})
export class ReportsModule {}
