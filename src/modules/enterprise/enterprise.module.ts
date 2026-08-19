import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotifyModule } from '../notify/notify.module';
import { EnterpriseAlertsService } from './enterprise-alerts.service';
import { EnterpriseApprovalsService } from './enterprise-approvals.service';
import { EnterpriseAuthGuard } from './enterprise-auth.guard';
import { EnterpriseController } from './enterprise.controller';
import { EnterpriseGroupService } from './enterprise-group.service';
import { EnterpriseInventoryService } from './enterprise-inventory.service';
import { EnterpriseMetricsService } from './enterprise-metrics.service';

@Module({
  imports: [AuthModule, NotifyModule],
  controllers: [EnterpriseController],
  providers: [
    EnterpriseAuthGuard,
    EnterpriseGroupService,
    EnterpriseMetricsService,
    EnterpriseInventoryService,
    EnterpriseApprovalsService,
    EnterpriseAlertsService,
  ],
  exports: [EnterpriseApprovalsService, EnterpriseAlertsService],
})
export class EnterpriseModule {}
