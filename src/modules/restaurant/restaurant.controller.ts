import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CapabilityGuard,
  RequireCapabilities,
} from '../../common/guards/capability.guard';
import {
  CreateDiningTableDto,
  CreateFloorDto,
  CreateModifierGroupDto,
  CreateModifierOptionDto,
  CreateRecipeStageDto,
  CreateStationDto,
  CompleteProductionStageDto,
  ListKotQueryDto,
  MergeTablesDto,
  MoveTableDto,
  OpenDiningOrderDto,
  OpenTableDto,
  RecordWastageDto,
  SendKotDto,
  SplitItemsDto,
  UpdateDiningTableDto,
  UpdateFloorDto,
  UpdateKotStatusDto,
  UpsertRecipeDto,
  UpsertRestaurantConfigDto,
  CreateReservationDto,
  UpdateReservationDto,
} from './dto/restaurant.dto';
import { RestaurantService } from './restaurant.service';
import { RestaurantKitchenService } from './restaurant-kitchen.service';

@ApiTags('restaurant')
@ApiBearerAuth('access-token')
@UseGuards(CapabilityGuard)
@RequireCapabilities('TABLE', 'KOT', 'KITCHEN', 'CAPTAIN', 'RECIPE', 'WASTAGE', 'MODIFIERS', 'KDS', 'QR_ORDER', 'TOKEN', 'DINING_RESERVATION')
@Controller('restaurant')
export class RestaurantController {
  constructor(
    private readonly restaurant: RestaurantService,
    private readonly kitchen: RestaurantKitchenService,
  ) {}

  @Get('config')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.kitchenOps)
  @ApiOperation({ summary: 'Restaurant pack configuration' })
  getConfig(@CurrentUser() user: AuthUser) {
    return this.restaurant.getConfig(user);
  }

  @Patch('config')
  @Roles(...RoleGroup.lead)
  upsertConfig(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertRestaurantConfigDto,
  ) {
    return this.restaurant.upsertConfig(user, dto);
  }

  @Get('floors')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.kitchenOps)
  listFloors(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.restaurant.listFloors(user, locationId);
  }

  @Post('floors')
  @Roles(...RoleGroup.lead)
  createFloor(@CurrentUser() user: AuthUser, @Body() dto: CreateFloorDto) {
    return this.restaurant.createFloor(user, dto);
  }

  @Patch('floors/:id')
  @Roles(...RoleGroup.lead)
  updateFloor(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFloorDto,
  ) {
    return this.restaurant.updateFloor(user, id, dto);
  }

  @Get('stations')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.kitchenOps)
  listStations(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.restaurant.listStations(user, locationId);
  }

  @Post('stations')
  @Roles(...RoleGroup.lead)
  createStation(@CurrentUser() user: AuthUser, @Body() dto: CreateStationDto) {
    return this.restaurant.createStation(user, dto);
  }

  @Get('tables')
  @Roles(...RoleGroup.diningFloor)
  listTables(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.restaurant.listTables(user, locationId);
  }

  @Post('tables')
  @Roles(...RoleGroup.lead)
  createTable(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateDiningTableDto,
  ) {
    return this.restaurant.createTable(user, dto);
  }

  @Patch('tables/:id')
  @Roles(...RoleGroup.lead, ...RoleGroup.diningFloor)
  updateTable(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDiningTableDto,
  ) {
    return this.restaurant.updateTable(user, id, dto);
  }

  @Post('tables/:id/open')
  @Roles(...RoleGroup.diningFloor)
  openTable(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OpenTableDto,
  ) {
    return this.restaurant.openTable(user, id, dto);
  }

  @Post('tables/:id/move')
  @Roles(...RoleGroup.diningFloor)
  moveTable(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveTableDto,
  ) {
    return this.restaurant.moveTable(user, id, dto);
  }

  @Post('tables/merge')
  @Roles(...RoleGroup.diningFloor)
  mergeTables(@CurrentUser() user: AuthUser, @Body() dto: MergeTablesDto) {
    return this.restaurant.mergeTables(user, dto);
  }

  @Post('orders')
  @Roles(...RoleGroup.diningFloor)
  @ApiOperation({ summary: 'Open dine-in / takeaway / delivery draft (no stock)' })
  openOrder(@CurrentUser() user: AuthUser, @Body() dto: OpenDiningOrderDto) {
    return this.restaurant.openDiningOrder(user, dto);
  }

  @Get('orders/:id')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.kitchenOps)
  getOrder(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.restaurant.getDiningOrder(user, id);
  }

  @Post('orders/:id/split')
  @Roles(...RoleGroup.diningFloor)
  split(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SplitItemsDto,
  ) {
    return this.restaurant.splitItems(user, id, dto);
  }

  @Post('orders/:id/kot')
  @Roles(...RoleGroup.diningFloor)
  @ApiOperation({ summary: 'Send KOT — does not deduct inventory' })
  sendKot(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendKotDto,
  ) {
    return this.restaurant.sendKot(user, id, dto);
  }

  @Get('kots')
  @Roles(...RoleGroup.kitchenOps, ...RoleGroup.diningFloor)
  listKots(@CurrentUser() user: AuthUser, @Query() query: ListKotQueryDto) {
    return this.restaurant.listKots(user, query);
  }

  @Patch('kots/:id')
  @Roles(...RoleGroup.kitchenOps)
  updateKot(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKotStatusDto,
  ) {
    return this.restaurant.updateKotStatus(user, id, dto);
  }

  @Get('recipes')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.kitchenOps, ...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Menu items with ingredient recipes' })
  listRecipes(@CurrentUser() user: AuthUser) {
    return this.kitchen.listRecipes(user);
  }

  @Get('recipes/:productId')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.kitchenOps, ...RoleGroup.catalogWrite)
  getRecipe(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.kitchen.getRecipe(user, productId, false);
  }

  @Put('recipes/:productId')
  @Roles(...RoleGroup.catalogWrite)
  upsertRecipe(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: UpsertRecipeDto,
  ) {
    return this.kitchen.upsertRecipe(user, productId, dto);
  }

  @Post('recipes/:productId/stages')
  @Roles(...RoleGroup.catalogWrite)
  createStage(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateRecipeStageDto,
  ) {
    return this.kitchen.createStage(user, productId, dto);
  }

  @Post('production/complete-stage')
  @Roles(...RoleGroup.catalogWrite, ...RoleGroup.kitchenOps)
  completeStage(
    @CurrentUser() user: AuthUser,
    @Body() dto: CompleteProductionStageDto,
  ) {
    return this.kitchen.completeStage(user, dto);
  }

  @Get('food-cost')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Recipe food cost % and margin (cost permission)' })
  foodCost(
    @CurrentUser() user: AuthUser,
    @Query('productId') productId?: string,
  ) {
    return this.kitchen.foodCost(user, productId);
  }

  @Get('modifiers')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.catalogWrite)
  listModifiers(@CurrentUser() user: AuthUser) {
    return this.kitchen.listModifierGroups(user);
  }

  @Post('modifiers')
  @Roles(...RoleGroup.catalogWrite)
  createModifierGroup(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateModifierGroupDto,
  ) {
    return this.kitchen.createModifierGroup(user, dto);
  }

  @Post('modifiers/:groupId/options')
  @Roles(...RoleGroup.catalogWrite)
  addModifierOption(
    @CurrentUser() user: AuthUser,
    @Param('groupId', ParseUUIDPipe) groupId: string,
    @Body() dto: CreateModifierOptionDto,
  ) {
    return this.kitchen.addModifierOption(user, groupId, dto);
  }

  @Get('items/:productId/modifiers')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.catalogWrite)
  productModifiers(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.kitchen.productModifiers(user, productId);
  }

  @Post('items/:productId/modifiers')
  @Roles(...RoleGroup.catalogWrite)
  attachModifier(
    @CurrentUser() user: AuthUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: { groupId: string },
  ) {
    return this.kitchen.attachModifierGroup(user, productId, dto.groupId);
  }

  @Get('wastage')
  @Roles(...RoleGroup.lead, Role.inventory)
  listWastage(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.kitchen.listWastage(user, { locationId });
  }

  @Post('wastage')
  @Roles(...RoleGroup.lead, Role.inventory)
  recordWastage(
    @CurrentUser() user: AuthUser,
    @Body() dto: RecordWastageDto,
  ) {
    return this.kitchen.recordWastage(user, dto);
  }

  @Get('tokens')
  @Roles(...RoleGroup.diningFloor, ...RoleGroup.kitchenOps)
  listTokens(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.restaurant.listTokens(user, locationId);
  }

  @Get('reservations')
  @Roles(...RoleGroup.diningFloor)
  listReservations(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.restaurant.listReservations(user, locationId);
  }

  @Post('reservations')
  @Roles(...RoleGroup.diningFloor)
  createReservation(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReservationDto,
  ) {
    return this.restaurant.createReservation(user, dto);
  }

  @Patch('reservations/:id')
  @Roles(...RoleGroup.diningFloor)
  updateReservation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReservationDto,
  ) {
    return this.restaurant.updateReservation(user, id, dto);
  }
}
