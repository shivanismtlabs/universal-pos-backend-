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
  AddCustomerNoteDto,
  AddPartyMemberDto,
  AdjustStoreCreditDto,
  CreateCustomerDto,
  CreateMeasurementDto,
  CreatePartyDto,
  CrmListQueryDto,
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
  @ApiOperation({ summary: 'Get customer by id (CRM summary)' })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customersService.getById(user, id);
  }

  @Get('customers/:id/orders')
  @ApiOperation({ summary: 'Purchase history for customer' })
  listOrders(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CrmListQueryDto,
  ) {
    return this.customersService.listOrders(user, id, query.limit);
  }

  @Get('customers/:id/dues')
  @ApiOperation({ summary: 'Open balance / due payments for customer' })
  listDues(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CrmListQueryDto,
  ) {
    return this.customersService.listDues(user, id, query.limit);
  }

  @Get('customers/:id/payments')
  @ApiOperation({ summary: 'Payment history via orders for customer' })
  listPayments(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CrmListQueryDto,
  ) {
    return this.customersService.listPayments(user, id, query.limit);
  }

  @Get('customers/:id/memberships')
  @ApiOperation({ summary: 'CustomerSubscriptions for CRM profile' })
  listMemberships(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CrmListQueryDto,
  ) {
    return this.customersService.listMemberships(user, id, query.limit);
  }

  @Get('customers/:id/activity')
  @ApiOperation({
    summary:
      'Unified CRM activity feed (notes, loyalty, wallet, orders, payments)',
  })
  listActivity(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CrmListQueryDto,
  ) {
    return this.customersService.listActivity(user, id, query.limit);
  }

  @Get('customers/:id/loyalty-ledger')
  @ApiOperation({ summary: 'Loyalty points ledger for customer' })
  listLoyalty(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CrmListQueryDto,
  ) {
    return this.customersService.listLoyaltyLedger(user, id, query.limit);
  }

  @Get('customers/:id/store-credit')
  @ApiOperation({ summary: 'Store credit / wallet ledger' })
  listStoreCredit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CrmListQueryDto,
  ) {
    return this.customersService.listStoreCreditLedger(user, id, query.limit);
  }

  @Post('customers/:id/store-credit')
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Top-up or debit store credit wallet (manager+)' })
  adjustStoreCredit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustStoreCreditDto,
  ) {
    return this.customersService.adjustStoreCredit(
      user,
      id,
      dto.amount,
      dto.note,
    );
  }

  @Get('customers/:id/notes')
  @ApiOperation({ summary: 'Customer note timeline' })
  listNotes(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CrmListQueryDto,
  ) {
    return this.customersService.listNotes(user, id, query.limit);
  }

  @Post('customers/:id/notes')
  @ApiOperation({ summary: 'Add customer note' })
  addNote(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddCustomerNoteDto,
  ) {
    return this.customersService.addNote(user, id, dto.body);
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
  @Roles(...RoleGroup.lead)
  @ApiOperation({ summary: 'Soft-delete customer (manager+); frees phone' })
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
  @ApiOperation({ summary: 'Create customer group' })
  createParty(@CurrentUser() user: AuthUser, @Body() dto: CreatePartyDto) {
    return this.customersService.createParty(user, dto);
  }

  @Get('parties')
  @ApiOperation({ summary: 'List customer groups' })
  listParties(@CurrentUser() user: AuthUser) {
    return this.customersService.listParties(user);
  }

  @Get('parties/:id')
  @ApiOperation({ summary: 'Get customer group with members' })
  getParty(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customersService.getParty(user, id);
  }

  @Post('parties/:id/members')
  @ApiOperation({ summary: 'Add member to customer group' })
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddPartyMemberDto,
  ) {
    return this.customersService.addPartyMember(user, id, dto);
  }

  @Delete('parties/:id/members/:customerId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove member from customer group' })
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customersService.removePartyMember(user, id, customerId);
  }
}
