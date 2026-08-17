import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CustomFieldEntity } from '@prisma/client';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreateCustomFieldDefinitionDto,
  ListCustomFieldDefinitionsQueryDto,
  UpsertCustomFieldValueDto,
} from './dto/custom-fields.dto';
import { CustomFieldsService } from './custom-fields.service';

@ApiTags('custom-fields')
@ApiBearerAuth('access-token')
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  @Get('definitions')
  @Roles(...RoleGroup.all)
  @ApiOperation({ summary: 'List tenant custom field definitions' })
  listDefinitions(
    @CurrentUser() user: AuthUser,
    @Query() query: ListCustomFieldDefinitionsQueryDto,
  ) {
    return this.fields.listDefinitions(user, query);
  }

  @Post('definitions')
  @Roles(...RoleGroup.ownerOnly)
  @ApiOperation({ summary: 'Create a custom field definition' })
  createDefinition(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCustomFieldDefinitionDto,
  ) {
    return this.fields.createDefinition(user, dto);
  }

  @Post('values')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Upsert a custom field value for an entity row' })
  upsertValue(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpsertCustomFieldValueDto,
  ) {
    return this.fields.upsertValue(user, dto);
  }

  @Get('values/:entity/:entityId')
  @Roles(...RoleGroup.all)
  listValues(
    @CurrentUser() user: AuthUser,
    @Param('entity') entity: CustomFieldEntity,
    @Param('entityId') entityId: string,
  ) {
    return this.fields.listValuesForEntity(user, entity, entityId);
  }
}
