import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { UnitPricingService } from './unit-pricing.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [CatalogController],
  providers: [CatalogService, UnitPricingService],
  exports: [CatalogService, UnitPricingService],
})
export class CatalogModule {}
