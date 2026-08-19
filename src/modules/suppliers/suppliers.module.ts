import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/** Suppliers + purchase / sub-rental POs — FR-SUP */
@Module({
  imports: [AccountingModule, InventoryModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
