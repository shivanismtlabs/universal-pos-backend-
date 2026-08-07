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
  BillServiceDto,
  CreateServiceProductDto,
} from './dto/subscriptions.dto';
import { ServicesCommerceService } from './services-commerce.service';

@ApiTags('services-commerce')
@ApiBearerAuth('access-token')
@Controller('services')
export class ServicesCommerceController {
  constructor(private readonly services: ServicesCommerceService) {}

  @Get('summary')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Service floor KPI counts' })
  summary(@CurrentUser() user: AuthUser) {
    return this.services.summary(user);
  }

  @Get()
  @Roles(...RoleGroup.catalogRead)
  @ApiOperation({ summary: 'List billable services' })
  list(@CurrentUser() user: AuthUser) {
    return this.services.listServices(user);
  }

  @Post()
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Create a service product' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateServiceProductDto) {
    return this.services.createService(user, dto);
  }

  @Patch(':id/active')
  @Roles(...RoleGroup.catalogWrite)
  @ApiOperation({ summary: 'Activate or deactivate a service' })
  setActive(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { isActive: boolean },
  ) {
    return this.services.setActive(user, id, Boolean(body?.isActive));
  }

  @Post('bill')
  @Roles(...RoleGroup.pos)
  @ApiOperation({ summary: 'Charge a customer for a service' })
  bill(@CurrentUser() user: AuthUser, @Body() dto: BillServiceDto) {
    return this.services.bill(user, dto);
  }
}
