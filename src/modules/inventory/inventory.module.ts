import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryOpsService } from './inventory-ops.service';
import { InventoryService } from './inventory.service';
import { InventoryLifecycleService } from './inventory-lifecycle.service';
import { StockMutationEngine } from './stock-mutation.engine';
import { NotifyModule } from '../notify/notify.module';
import { EnterpriseModule } from '../enterprise/enterprise.module';

import { StockAdjustmentService } from './stock-adjustment.service';

@Module({
  imports: [NotifyModule, EnterpriseModule],
  controllers: [InventoryController],
  providers: [
    InventoryService,
    InventoryOpsService,
    InventoryLifecycleService,
    StockMutationEngine,
    StockAdjustmentService,
  ],
  exports: [
    InventoryService,
    InventoryOpsService,
    InventoryLifecycleService,
    StockMutationEngine,
    StockAdjustmentService,
  ],
})
export class InventoryModule {}
