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
import { Permissions, Roles } from '../auth/decorators/auth.decorators';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types';
import { AccountingService } from './accounting.service';
import { AccountsService } from './accounts.service';
import {
  CreateAccountDto,
  CreateJournalDto,
  CreatePeriodDto,
  LedgerQueryDto,
  ListAccountsQueryDto,
  ListJournalsQueryDto,
  ReportRangeQueryDto,
  ReverseJournalDto,
  TallyExportDto,
  UpdateAccountDto,
  UpdateAccountingSettingsDto,
  UpsertMappingDto,
  ConnectIntegrationDto,
  UpsertExternalMappingDto,
} from './dto/accounting.dto';
import { JournalService } from './journal.service';
import { AccountMappingsService } from './mappings.service';
import { AccountingPeriodsService } from './periods.service';
import { AccountingReportsService } from './reports.service';
import { AccountingSyncService } from './integrations/sync.service';

@ApiTags('accounting')
@ApiBearerAuth('access-token')
@Roles(...RoleGroup.accounting)
@Controller()
export class AccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly accounts: AccountsService,
    private readonly journals: JournalService,
    private readonly reports: AccountingReportsService,
    private readonly periods: AccountingPeriodsService,
    private readonly mappings: AccountMappingsService,
    private readonly sync: AccountingSyncService,
  ) {}

  @Get('accounting/settings')
  @Permissions('accounting.view')
  settings(@CurrentUser() user: AuthUser) {
    return this.accounting.getSettings(user);
  }

  @Patch('accounting/settings')
  @Permissions('accounting.edit')
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateAccountingSettingsDto,
  ) {
    return this.accounting.updateSettings(user, dto);
  }

  @Get('accounting/overview')
  @Permissions('accounting.view')
  overview(@CurrentUser() user: AuthUser) {
    return this.accounting.overview(user);
  }

  @Get('accounts')
  @Permissions('accounting.view')
  listAccounts(@CurrentUser() user: AuthUser, @Query() query: ListAccountsQueryDto) {
    return this.accounts.list(user, query);
  }

  @Get('accounts/tree')
  @Permissions('accounting.view')
  tree(@CurrentUser() user: AuthUser) {
    return this.accounts.tree(user);
  }

  @Get('accounts/:id')
  @Permissions('accounting.view')
  getAccount(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.get(user, id);
  }

  @Post('accounts')
  @Permissions('accounting.create')
  createAccount(@CurrentUser() user: AuthUser, @Body() dto: CreateAccountDto) {
    return this.accounts.create(user, dto);
  }

  @Patch('accounts/:id')
  @Permissions('accounting.edit')
  updateAccount(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
  ) {
    return this.accounts.update(user, id, dto);
  }

  @Delete('accounts/:id')
  @Permissions('accounting.edit')
  deleteAccount(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.accounts.remove(user, id);
  }

  @Get('journal-entries')
  @Permissions('accounting.view')
  listJournals(@CurrentUser() user: AuthUser, @Query() query: ListJournalsQueryDto) {
    return this.journals.list(user, query);
  }

  @Get('journal-entries/:id')
  @Permissions('accounting.view')
  getJournal(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.journals.get(user, id);
  }

  @Post('journal-entries')
  @Permissions('accounting.create')
  createJournal(@CurrentUser() user: AuthUser, @Body() dto: CreateJournalDto) {
    return this.journals.createDraft(user, dto);
  }

  @Post('journal-entries/:id/post')
  @Permissions('accounting.post')
  postJournal(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.journals.postDraft(user, id);
  }

  @Post('journal-entries/:id/reverse')
  @Permissions('accounting.reverse')
  reverseJournal(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReverseJournalDto,
  ) {
    return this.journals.reverse(user, id, dto.reason);
  }

  @Delete('journal-entries/:id')
  @Permissions('accounting.edit')
  deleteJournal(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.journals.deleteDraft(user, id);
  }

  @Get('ledger')
  @Permissions('accounting.view')
  ledger(@CurrentUser() user: AuthUser, @Query() query: LedgerQueryDto) {
    return this.reports.ledger(user, query);
  }

  @Get('trial-balance')
  @Permissions('accounting.view')
  trialBalance(@CurrentUser() user: AuthUser, @Query() query: ReportRangeQueryDto) {
    return this.reports.trialBalance(user, query);
  }

  @Get('profit-loss')
  @Permissions('accounting.view')
  profitLoss(@CurrentUser() user: AuthUser, @Query() query: ReportRangeQueryDto) {
    return this.reports.profitLoss(user, query);
  }

  @Get('balance-sheet')
  @Permissions('accounting.view')
  balanceSheet(@CurrentUser() user: AuthUser, @Query() query: ReportRangeQueryDto) {
    return this.reports.balanceSheet(user, query);
  }

  @Get('tax-reports')
  @Permissions('accounting.view')
  taxReports(@CurrentUser() user: AuthUser, @Query() query: ReportRangeQueryDto) {
    return this.reports.gstReport(user, query);
  }

  @Get('accounting-periods')
  @Permissions('accounting.view')
  periodsList(@CurrentUser() user: AuthUser) {
    return this.periods.list(user);
  }

  @Post('accounting-periods')
  @Permissions('accounting.edit')
  createPeriod(@CurrentUser() user: AuthUser, @Body() dto: CreatePeriodDto) {
    return this.periods.create(user, dto);
  }

  @Post('accounting-periods/:id/close')
  @Permissions('accounting.close_period')
  closePeriod(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.periods.close(user, id);
  }

  @Post('accounting-periods/:id/reopen')
  @Permissions('accounting.close_period')
  reopenPeriod(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.periods.reopen(user, id);
  }

  @Get('account-mappings')
  @Permissions('accounting.view')
  listMappings(
    @CurrentUser() user: AuthUser,
    @Query('locationId') locationId?: string,
  ) {
    return this.mappings.list(user, locationId);
  }

  @Post('account-mappings')
  @Permissions('accounting.edit')
  upsertMapping(@CurrentUser() user: AuthUser, @Body() dto: UpsertMappingDto) {
    return this.mappings.upsert(user, dto);
  }

  @Get('integrations')
  @Permissions('accounting.view')
  integrations(@CurrentUser() user: AuthUser) {
    return this.sync.listConnections(user);
  }

  @Post('integrations/:provider/connect')
  @Permissions('accounting.integrations.manage')
  connect(
    @CurrentUser() user: AuthUser,
    @Param('provider') provider: string,
    @Body() dto: ConnectIntegrationDto,
  ) {
    return this.sync.connect(user, provider, dto.config ?? {});
  }

  @Post('integrations/:provider/disconnect')
  @Permissions('accounting.integrations.manage')
  disconnect(@CurrentUser() user: AuthUser, @Param('provider') provider: string) {
    return this.sync.disconnect(user, provider);
  }

  @Post('integrations/:provider/test')
  @Permissions('accounting.integrations.manage')
  test(@CurrentUser() user: AuthUser, @Param('provider') provider: string) {
    return this.sync.test(user, provider);
  }

  @Post('integrations/:provider/sync')
  @Permissions('accounting.sync')
  triggerSync(@CurrentUser() user: AuthUser, @Param('provider') provider: string) {
    return this.sync.triggerSync(user, provider);
  }

  @Get('integrations/:provider/mappings')
  @Permissions('accounting.view')
  extMaps(@CurrentUser() user: AuthUser, @Param('provider') provider: string) {
    return this.sync.mappings(user, provider);
  }

  @Post('integrations/:provider/mappings')
  @Permissions('accounting.integrations.manage')
  upsertExtMap(
    @CurrentUser() user: AuthUser,
    @Param('provider') provider: string,
    @Body() dto: UpsertExternalMappingDto,
  ) {
    return this.sync.upsertMapping(user, provider, dto);
  }

  @Get('integrations/:provider/logs')
  @Permissions('accounting.view')
  logs(
    @CurrentUser() user: AuthUser,
    @Param('provider') provider: string,
    @Query() query: ListJournalsQueryDto,
  ) {
    return this.sync.logs(user, provider, query);
  }

  @Post('integrations/tally/export')
  @Permissions('accounting.export')
  @ApiOperation({ summary: 'Generate Tally XML export for a date range' })
  tallyExport(@CurrentUser() user: AuthUser, @Body() dto: TallyExportDto) {
    return this.sync.exportTally(user, dto);
  }
}
