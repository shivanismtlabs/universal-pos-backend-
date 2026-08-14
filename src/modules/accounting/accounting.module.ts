import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { AccountsService } from './accounts.service';
import { AccountingPostingService } from './posting.service';
import { JournalService } from './journal.service';
import { AccountMappingsService } from './mappings.service';
import { AccountingPeriodsService } from './periods.service';
import { AccountingReportsService } from './reports.service';
import { QuickBooksAdapter } from './integrations/quickbooks.adapter';
import { AccountingSyncService } from './integrations/sync.service';
import { TallyAdapter } from './integrations/tally.adapter';
import { IntegrationTokenService } from './integrations/tokens';
import { ZohoBooksAdapter } from './integrations/zoho-books.adapter';

@Module({
  controllers: [AccountingController],
  providers: [
    AccountingService,
    AccountsService,
    JournalService,
    AccountMappingsService,
    AccountingPeriodsService,
    AccountingReportsService,
    AccountingPostingService,
    AccountingSyncService,
    IntegrationTokenService,
    TallyAdapter,
    QuickBooksAdapter,
    ZohoBooksAdapter,
  ],
  exports: [AccountingPostingService, AccountingService, JournalService],
})
export class AccountingModule {}
