import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreateLocationDto,
  CreateOrganizationDto,
  UpdateLocationDto,
  UpdateTenantDto,
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

  @Get('tenants/me/bootstrap')
  @Roles(...RoleGroup.all)
  @ApiOperation({
    summary: 'Bootstrap payload: tenant, orgs, locations, modules, nav',
  })
  bootstrap(@CurrentUser() user: AuthUser) {
    return this.tenantsService.bootstrap(user);
  }

  @Patch('tenants/me')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({ summary: 'Update current tenant (admin only)' })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.updateMe(user, dto);
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
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({ summary: 'Create location' })
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
}
