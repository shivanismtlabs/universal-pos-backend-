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
  CreateStoreDto,
  UpdateStoreDto,
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

  @Patch('tenants/me')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({ summary: 'Update current tenant (admin only)' })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateTenantDto) {
    return this.tenantsService.updateMe(user, dto);
  }

  @Get('stores')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List stores for current tenant' })
  listStores(@CurrentUser() user: AuthUser) {
    return this.tenantsService.listStores(user);
  }

  @Post('stores')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({ summary: 'Create a store' })
  createStore(@CurrentUser() user: AuthUser, @Body() dto: CreateStoreDto) {
    return this.tenantsService.createStore(user, dto);
  }

  @Get('stores/:id')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'Get store by id' })
  getStore(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tenantsService.getStore(user, id);
  }

  @Patch('stores/:id')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Update store' })
  updateStore(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStoreDto,
  ) {
    return this.tenantsService.updateStore(user, id, dto);
  }
}
