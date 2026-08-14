import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryOpsService } from './inventory-ops.service';
import { InventoryService } from './inventory.service';
import { NotifyModule } from '../notify/notify.module';

@Module({
  imports: [NotifyModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryOpsService],
  exports: [InventoryService, InventoryOpsService],
})
export class InventoryModule {}
