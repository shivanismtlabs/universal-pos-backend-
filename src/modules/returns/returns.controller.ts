import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  CreateReturnDto,
  InspectReturnDto,
  ListReturnsQueryDto,
  SettleDepositDto,
} from './dto/returns.dto';
import { ReturnsService } from './returns.service';

@ApiTags('returns')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.returns)
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Post()
  @ApiOperation({ summary: 'Record a rental unit return' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReturnDto) {
    return this.returnsService.create(user, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List returns, optionally filtered by order' })
  list(@CurrentUser() user: AuthUser, @Query() query: ListReturnsQueryDto) {
    return this.returnsService.list(user, query);
  }

  @Get('candidates')
  @ApiOperation({
    summary:
      'Orders with units still out — for Returns / Exchange (lifecycle-based)',
  })
  candidates(@CurrentUser() user: AuthUser) {
    return this.returnsService.listCandidates(user);
  }

  @Post('orders/:orderId/settle-deposit')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Settle rental deposit: refundAmount returned; remainder forfeited',
  })
  settleDeposit(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: SettleDepositDto,
  ) {
    return this.returnsService.settleDeposit(user, orderId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get return with damage records / cleaning jobs' })
  getOne(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.returnsService.getById(user, id);
  }

  @Post(':id/inspect')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Inspect a return: clean_ready / needs_cleaning / damaged',
  })
  inspect(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InspectReturnDto,
  ) {
    return this.returnsService.inspect(user, id, dto);
  }

  @Post(':id/cleaning/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark cleaning job completed, unit back to available',
  })
  completeCleaning(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.returnsService.completeCleaning(user, id);
  }
}
