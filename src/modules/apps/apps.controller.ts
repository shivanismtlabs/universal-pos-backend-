import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { AppsService } from './apps.service';
import { SearchService } from './search.service';
import {
  CreateCatalogItemDto,
  EnableModuleDto,
  SetBusinessConfigDto,
  SetCommerceModesDto,
  SetFeatureFlagDto,
} from './dto/apps.dto';

@ApiTags('apps')
@ApiBearerAuth('access-token')
@Controller()
export class AppsController {
  constructor(
    private readonly apps: AppsService,
    private readonly search: SearchService,
  ) {}

  @Get('search')
  @Roles(...RoleGroup.all)
  @ApiOperation({
    summary: 'Unified product + customer search (shell / quick find)',
  })
  globalSearch(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    return this.search.search(
      user,
      q ?? '',
      limit ? Number(limit) : undefined,
    );
  }

  @Get('modules')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'Platform module catalog' })
  listCatalog() {
    return this.apps.listCatalog();
  }

  @Get('tenants/me/modules')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'Modules for current tenant (status per app)' })
  listTenantModules(@CurrentUser() user: AuthUser) {
    return this.apps.listTenantModules(user);
  }

  @Post('tenants/me/modules/:code/enable')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({
    summary: 'Enable module (+ auto-enable dependsOn closure)',
  })
  enable(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() dto: EnableModuleDto,
  ) {
    return this.apps.enable(user, code.trim().toLowerCase(), dto.config);
  }

  @Post('tenants/me/modules/:code/disable')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({ summary: 'Disable module (blocked if dependents enabled)' })
  disable(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.apps.disable(user, code.trim().toLowerCase());
  }

  @Get('tenants/me/feature-flags')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List feature flags' })
  listFlags(@CurrentUser() user: AuthUser) {
    return this.apps.listFeatureFlags(user);
  }

  @Post('tenants/me/feature-flags')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({ summary: 'Set a feature flag on/off' })
  setFlag(@CurrentUser() user: AuthUser, @Body() dto: SetFeatureFlagDto) {
    return this.apps.setFeatureFlag(user, dto);
  }

  @Get('commerce/schema')
  @Roles(...RoleGroup.all)
  @ApiOperation({
    summary:
      'Registered commerce modes + field schemas (sale/rental/service/subscription)',
  })
  commerceSchema() {
    return this.apps.commerceSchema();
  }

  @Get('commerce/business-configs')
  @Roles(...RoleGroup.all)
  @ApiOperation({
    summary:
      'BusinessConfig registry — vertical profiles (add type = new JSON only)',
  })
  listBusinessConfigs() {
    return this.apps.listBusinessConfigs();
  }

  @Post('tenants/me/business-config')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({
    summary:
      'Set shop business type profile (config-driven; no industry forks)',
  })
  setBusinessConfig(
    @CurrentUser() user: AuthUser,
    @Body() dto: SetBusinessConfigDto,
  ) {
    return this.apps.setBusinessConfig(user, dto);
  }

  @Get('tenants/me/business-form-schema')
  @Roles(...RoleGroup.all)
  @ApiOperation({
    summary:
      'Dynamic form schema from BUSINESS_CONFIG (item_fields + order_fields + ui_flow)',
  })
  businessFormSchema(@CurrentUser() user: AuthUser) {
    return this.apps.businessFormSchema(user);
  }

  @Post('tenants/me/commerce-modes')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({
    summary:
      'Enable commerce modes for this shop (multi-select from registry)',
  })
  setCommerceModes(
    @CurrentUser() user: AuthUser,
    @Body() dto: SetCommerceModesDto,
  ) {
    return this.apps.setCommerceModes(user, dto);
  }

  @Post('catalog/items')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({
    summary:
      'Add catalog item with generic Sale/Rental keys (any industry)',
  })
  createCatalogItem(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCatalogItemDto,
  ) {
    return this.apps.createCatalogItem(user, dto);
  }

  @Get('tenants/me/dashboard-catalog')
  @Roles(...RoleGroup.all)
  @ApiOperation({
    summary:
      'Dashboard floor: catalog + open orders/returns/fit keys',
  })
  dashboardCatalog(@CurrentUser() user: AuthUser) {
    return this.apps.dashboardCatalog(user);
  }

  @Get('tenants/me/bootstrap')
  @Roles(...RoleGroup.all)
  @ApiOperation({
    summary: 'FE bootstrap: tenant, plan, modules, flags, nav, commerce',
  })
  bootstrap(@CurrentUser() user: AuthUser) {
    return this.apps.bootstrap(user);
  }
}
