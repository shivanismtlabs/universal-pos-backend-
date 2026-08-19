import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup, Role } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreateLocationDto,
  CreateOrganizationDto,
  CreateMeasureUnitDto,
  UpdateLocationDto,
  UpdateMeasureUnitDto,
  UpdateTenantDto,
  UploadTenantLogoDto,
} from './dto/tenants.dto';
import { TenantsService } from './tenants.service';

@ApiTags('tenants')
@ApiBearerAuth('access-token')
@Controller()
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get('tenants/me')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'Get current tenant' })
  getMe(@CurrentUser() user: AuthUser) {
    return this.tenantsService.getMe(user);
  }

  @Patch('tenants/me')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Update current tenant (admin / manager)' })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.updateMe(user, dto);
  }

  @Post('tenants/me/logo')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Upload shop logo (JPEG/PNG/WebP/GIF/SVG, max 4MB)' })
  uploadLogo(
    @CurrentUser() user: AuthUser,
    @Body() dto: UploadTenantLogoDto,
  ) {
    return this.tenantsService.uploadLogo(user, dto.imageBase64);
  }

  @Post('tenants/me/logo/remove')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Clear shop logo' })
  removeLogo(@CurrentUser() user: AuthUser) {
    return this.tenantsService.removeLogo(user);
  }

  @Get('organizations')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List organizations' })
  listOrganizations(@CurrentUser() user: AuthUser) {
    return this.tenantsService.listOrganizations(user);
  }

  @Post('organizations')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({ summary: 'Create organization' })
  createOrganization(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.tenantsService.createOrganization(user, dto);
  }

  @Get('locations')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List locations (stores/warehouses/…)' })
  listLocations(@CurrentUser() user: AuthUser) {
    return this.tenantsService.listLocations(user);
  }

  @Post('locations')
  @Roles(...RoleGroup.lead, Role.inventory)
  @ApiOperation({ summary: 'Create location (store / warehouse / …)' })
  createLocation(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateLocationDto,
  ) {
    return this.tenantsService.createLocation(user, dto);
  }

  @Get('locations/:id')
  @Roles(...RoleGroup.all)
  getLocation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tenantsService.getLocation(user, id);
  }

  @Get('locations/:id/dashboard')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'Branch dashboard KPIs for one location' })
  branchDashboard(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tenantsService.branchDashboard(user, id);
  }

  @Get('multi-store/dashboard')
  @Roles(...RoleGroup.lead, Role.accountant)
  @ApiOperation({ summary: 'HQ multi-store dashboard rollup' })
  multiStoreDashboard(@CurrentUser() user: AuthUser) {
    return this.tenantsService.multiStoreDashboard(user);
  }

  @Patch('locations/:id')
  @Roles(...RoleGroup.lead)
  updateLocation(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.tenantsService.updateLocation(user, id, dto);
  }

  /** Compat aliases — same as locations */
  @Get('stores')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List stores (alias of locations)' })
  listStores(@CurrentUser() user: AuthUser) {
    return this.tenantsService.listStores(user);
  }

  @Post('stores')
  @Roles(...RoleGroup.ownerOnly)
  createStore(@CurrentUser() user: AuthUser, @Body() dto: CreateLocationDto) {
    return this.tenantsService.createStore(user, dto);
  }

  @Get('stores/:id')
  @Roles(...RoleGroup.all)
  getStore(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tenantsService.getStore(user, id);
  }

  @Patch('stores/:id')
  @Roles(...RoleGroup.lead)
  updateStore(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.tenantsService.updateStore(user, id, dto);
  }

  @Get('tenants/me/units')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List units of measure for this shop' })
  listUnitsMe(@CurrentUser() user: AuthUser) {
    return this.tenantsService.listUnits(user);
  }

  @Post('tenants/me/units')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Add a unit of measure' })
  createUnitMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateMeasureUnitDto,
  ) {
    return this.tenantsService.createUnit(user, dto);
  }

  @Patch('tenants/me/units/:code')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Update a unit (name, decimal qty, active)' })
  updateUnitMe(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() dto: UpdateMeasureUnitDto,
  ) {
    return this.tenantsService.updateUnit(user, code, dto);
  }

  @Delete('tenants/me/units/:code')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Remove a custom unit' })
  deleteUnitMe(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.tenantsService.deleteUnit(user, code);
  }

  @Get('units')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List units of measure for this shop' })
  listUnits(@CurrentUser() user: AuthUser) {
    return this.tenantsService.listUnits(user);
  }

  @Post('units')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Add a unit of measure' })
  createUnit(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateMeasureUnitDto,
  ) {
    return this.tenantsService.createUnit(user, dto);
  }

  @Patch('units/:code')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Update a unit (name, decimal qty, active)' })
  updateUnit(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() dto: UpdateMeasureUnitDto,
  ) {
    return this.tenantsService.updateUnit(user, code, dto);
  }

  @Delete('units/:code')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Remove a custom unit (system units cannot be deleted)' })
  deleteUnit(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.tenantsService.deleteUnit(user, code);
  }
}
