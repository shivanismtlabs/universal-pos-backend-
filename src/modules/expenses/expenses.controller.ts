import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RoleGroup } from '../../common/roles';
import { Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ListExpensesQueryDto,
} from './dto/expenses.dto';
import { ExpensesService } from './expenses.service';

@ApiTags('expenses')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.finance)
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get('categories')
  @ApiOperation({ summary: 'List expense categories' })
  listCategories(@CurrentUser() user: AuthUser) {
    return this.expenses.listCategories(user);
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create expense category' })
  createCategory(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateExpenseCategoryDto,
  ) {
    return this.expenses.createCategory(user, dto);
  }

  @Post('categories/seed')
  @ApiOperation({ summary: 'Seed default expense categories' })
  seed(@CurrentUser() user: AuthUser) {
    return this.expenses.seedDefaults(user);
  }

  @Get()
  @ApiOperation({ summary: 'List expenses' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListExpensesQueryDto) {
    return this.expenses.list(user, query);
  }

  @Post()
  @ApiOperation({ summary: 'Record an expense' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateExpenseDto) {
    return this.expenses.create(user, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete expense' })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expenses.remove(user, id);
  }
}
