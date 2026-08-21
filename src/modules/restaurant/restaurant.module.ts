import { Module } from '@nestjs/common';
import { CapabilityGuard } from '../../common/guards/capability.guard';
import { InventoryModule } from '../inventory/inventory.module';
import { RestaurantController } from './restaurant.controller';
import { RestaurantGuestService } from './restaurant-guest.service';
import { RestaurantKitchenService } from './restaurant-kitchen.service';
import { RestaurantPublicController } from './restaurant-public.controller';
import { RestaurantService } from './restaurant.service';

@Module({
  imports: [InventoryModule],
  controllers: [RestaurantController, RestaurantPublicController],
  providers: [
    RestaurantService,
    RestaurantKitchenService,
    RestaurantGuestService,
    CapabilityGuard,
  ],
  exports: [RestaurantService],
})
export class RestaurantModule {}
