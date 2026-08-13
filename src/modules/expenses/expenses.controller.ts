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
  ExpenseSummaryQueryDto,
  ListExpenseCategoriesQueryDto,
  ListExpensesQueryDto,
  PettyCashAdjustDto,
  PettyCashLedgerQueryDto,
  PettyCashOpeningDto,
  PettyCashQueryDto,
  PettyCashReplenishDto,
  RejectExpenseDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
  UploadExpenseReceiptDto,
} from './dto/expenses.dto';
import { ExpensesService } from './expenses.service';

@ApiTags('expenses')
@ApiBearerAuth('access-token')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  // ─── Categories (static) ──────────────────────────────────────────────────

  @Get('categories')
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'List expense categories' })
  listCategories(
    @CurrentUser() user: AuthUser,
    @Query() query: ListExpenseCategoriesQueryDto,
  ) {
    return this.expenses.listCategories(user, query);
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

  @Patch('categories/:id')
  @Roles(...RoleGroup.finance)
  @ApiOperation({ summary: 'Update expense category' })
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseCategoryDto,
  ) {
    return this.expenses.updateCategory(user, id, dto);
  }

  @Delete('categories/:id')
  @Roles(...RoleGroup.finance)
  @ApiOperation({
    summary: 'Delete category only if unused (prefer soft-deactivate)',
  })
  deleteCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expenses.deleteCategory(user, id);
  }

  // ─── Petty cash (static) ──────────────────────────────────────────────────

  @Get('petty-cash')
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'Get petty cash fund + balance (creates if missing)' })
  getPettyCash(
    @CurrentUser() user: AuthUser,
    @Query() query: PettyCashQueryDto,
  ) {
    return this.expenses.getPettyCash(user, query);
  }

  @Get('petty-cash/ledger')
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'Petty cash ledger entries' })
  getPettyCashLedger(
    @CurrentUser() user: AuthUser,
    @Query() query: PettyCashLedgerQueryDto,
  ) {
    return this.expenses.getPettyCashLedger(user, query);
  }

  @Post('petty-cash/opening')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({ summary: 'Set opening petty cash (only if empty fund)' })
  pettyCashOpening(
    @CurrentUser() user: AuthUser,
    @Body() dto: PettyCashOpeningDto,
  ) {
    return this.expenses.pettyCashOpening(user, dto);
  }

  @Post('petty-cash/replenish')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Replenish petty cash (credit fund — not an expense)',
  })
  pettyCashReplenish(
    @CurrentUser() user: AuthUser,
    @Body() dto: PettyCashReplenishDto,
  ) {
    return this.expenses.pettyCashReplenish(user, dto);
  }

  @Post('petty-cash/adjust')
  @Roles(...RoleGroup.finance)
  @HttpCode(200)
  @ApiOperation({ summary: 'Manual petty cash credit/debit adjustment' })
  pettyCashAdjust(
    @CurrentUser() user: AuthUser,
    @Body() dto: PettyCashAdjustDto,
  ) {
    return this.expenses.pettyCashAdjust(user, dto);
  }

  // ─── Summary (static) ─────────────────────────────────────────────────────

  @Get('summary')
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'Expense + petty cash summary dashboard' })
  summary(
    @CurrentUser() user: AuthUser,
    @Query() query: ExpenseSummaryQueryDto,
  ) {
    return this.expenses.summary(user, query);
  }

  // ─── Expenses collection ──────────────────────────────────────────────────

  @Get()
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'List expenses' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListExpensesQueryDto) {
    return this.expenses.list(user, query);
  }

  @Post()
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({
    summary:
      'Record an expense (tax snapshot, approval threshold, petty cash debit)',
  })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateExpenseDto) {
    return this.expenses.create(user, dto);
  }

  // ─── Expense by id (after static routes) ──────────────────────────────────

  @Get(':id')
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'Expense detail' })
  getById(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expenses.getById(user, id);
  }

  @Patch(':id')
  @Roles(...RoleGroup.finance, Role.cashier)
  @ApiOperation({ summary: 'Edit draft or pending expense' })
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
  @ApiOperation({ summary: 'Soft-void an expense (reverses petty debit)' })
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
