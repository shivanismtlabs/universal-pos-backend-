import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreateResourceDto,
  ListResourcesQueryDto,
  UpdateResourceDto,
} from './dto/resources.dto';
import { ResourcesService } from './resources.service';

@ApiTags('resources')
@ApiBearerAuth('access-token')
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Post()
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Create generic resource (table/room/vehicle/…)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateResourceDto) {
    return this.resources.create(user, dto);
  }

  @Get()
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List resources for current tenant' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListResourcesQueryDto) {
    return this.resources.list(user, query);
  }

  @Get(':id')
  @Roles(...RoleGroup.all)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.resources.get(user, id);
  }

  @Patch(':id')
  @Roles(...RoleGroup.lead)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateResourceDto,
  ) {
    return this.resources.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(...RoleGroup.lead)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.resources.remove(user, id);
  }
}
