import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { CustomersService } from './customers.service';
import {
  AddPartyMemberDto,
  CreateCustomerDto,
  CreateMeasurementDto,
  CreatePartyDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customers.dto';

@ApiTags('customers')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.studio)
@Controller()
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post('customers')
  @ApiOperation({ summary: 'Create customer' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.customersService.create(user, dto);
  }

  @Get('customers')
  @ApiOperation({ summary: 'List / search customers' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListCustomersQueryDto) {
    return this.customersService.list(user, query);
  }

  @Get('customers/:id')
  @ApiOperation({ summary: 'Get customer by id' })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customersService.getById(user, id);
  }

  @Patch('customers/:id')
  @ApiOperation({ summary: 'Update customer' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(user, id, dto);
  }

  @Delete('customers/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-delete customer' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customersService.softDelete(user, id);
  }

  @Post('customers/:id/measurements')
  @ApiOperation({ summary: 'Add measurement history row' })
  addMeasurement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMeasurementDto,
  ) {
    return this.customersService.addMeasurement(user, id, dto);
  }

  @Get('customers/:id/measurements')
  @ApiOperation({ summary: 'List measurement history' })
  listMeasurements(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customersService.listMeasurements(user, id);
  }

  @Post('parties')
  @ApiOperation({ summary: 'Create customer group / party' })
  createParty(@CurrentUser() user: AuthUser, @Body() dto: CreatePartyDto) {
    return this.customersService.createParty(user, dto);
  }

  @Get('parties')
  @ApiOperation({ summary: 'List parties' })
  listParties(@CurrentUser() user: AuthUser) {
    return this.customersService.listParties(user);
  }

  @Get('parties/:id')
  @ApiOperation({ summary: 'Get party with members' })
  getParty(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customersService.getParty(user, id);
  }

  @Post('parties/:id/members')
  @ApiOperation({ summary: 'Add member to party' })
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddPartyMemberDto,
  ) {
    return this.customersService.addPartyMember(user, id, dto);
  }

  @Delete('parties/:id/members/:customerId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove member from party' })
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customersService.removePartyMember(user, id, customerId);
  }
}
