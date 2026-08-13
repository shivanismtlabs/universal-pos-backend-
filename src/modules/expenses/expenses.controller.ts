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
import { Role, RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ListExpensesQueryDto,
  RejectExpenseDto,
  UpdateExpenseDto,
  UploadExpenseReceiptDto,
} from './dto/expenses.dto';
import { ExpensesService } from './expenses.service';

@ApiTags('expenses')
@ApiBearerAuth('access-token')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get('categories')
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'List expense categories' })
  listCategories(@CurrentUser() user: AuthUser) {
    return this.expenses.listCategories(user);
  }

  @Post('categories')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Create expense category' })
  createCategory(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateExpenseCategoryDto,
  ) {
    return this.expenses.createCategory(user, dto);
  }

  @Post('categories/seed')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Seed default expense categories' })
  seed(@CurrentUser() user: AuthUser) {
    return this.expenses.seedDefaults(user);
  }

  @Get()
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'List expenses' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListExpensesQueryDto) {
    return this.expenses.list(user, query);
  }

  @Post()
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'Record an expense (pending for cashiers)' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateExpenseDto) {
    return this.expenses.create(user, dto);
  }

  @Patch(':id')
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'Edit pending expense' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.expenses.update(user, id, dto);
  }

  @Post(':id/receipt')
  @Roles(...RoleGroup.finance, Role.cashier)
  @HttpCode(200)
  @ApiOperation({ summary: 'Attach receipt image' })
  uploadReceipt(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadExpenseReceiptDto,
  ) {
    return this.expenses.uploadReceipt(user, id, dto.imageBase64);
  }

  @Post(':id/approve')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve pending expense' })
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expenses.approve(user, id);
  }

  @Post(':id/reject')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject pending expense' })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectExpenseDto,
  ) {
    return this.expenses.reject(user, id, dto.reason);
  }

  @Post(':id/void')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({ summary: 'Soft-void an expense' })
  voidExpense(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expenses.void(user, id);
  }

  @Delete(':id')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Delete non-approved expense' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expenses.remove(user, id);
  }
}
