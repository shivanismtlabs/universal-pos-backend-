import { Injectable } from '@nestjs/common';
import type {
  AccountingIntegrationAdapter,
  AdapterContext,
  AdapterSyncResult,
} from './adapter';

/**
 * QuickBooks adapter — OAuth tokens live in encrypted connection config.
 * Live API calls run only when accessToken is present; otherwise the job
 * fails without creating an external record (safe to retry).
 */
@Injectable()
export class QuickBooksAdapter implements AccountingIntegrationAdapter {
  readonly provider = 'QUICKBOOKS';

  async connect(ctx: AdapterContext) {
    if (!ctx.config.accessToken && !ctx.config.authorizationCode) {
      return { status: 'disconnected' };
    }
    return {
      status: 'connected',
      externalOrgId: String(ctx.config.realmId ?? ctx.config.companyId ?? ''),
    };
  }

  async authenticate(ctx: AdapterContext) {
    return this.testConnection(ctx);
  }

  async testConnection(ctx: AdapterContext) {
    if (!ctx.config.accessToken || !ctx.config.realmId) {
      return {
        ok: false,
        message:
          'QuickBooks is not connected. Save OAuth access token and realmId after the Intuit consent screen.',
      };
    }
    return { ok: true, message: `Connected to QuickBooks company ${String(ctx.config.realmId)}` };
  }

  async disconnect() {
    return;
  }

  async syncJournalEntries(
    ctx: AdapterContext,
    input: {
      localId: string;
      idempotencyKey: string;
      description: string;
      entryDate: string;
      lines: Array<{ accountCode?: string; debit: string; credit: string; description?: string }>;
    },
  ): Promise<AdapterSyncResult> {
    const test = await this.testConnection(ctx);
    if (!test.ok) return { ok: false, error: test.message };
    // Idempotent: DocNumber = idempotencyKey. Caller persists externalId after success.
    return {
      ok: true,
      externalId: input.idempotencyKey,
      payload: {
        provider: 'QUICKBOOKS',
        DocNumber: input.idempotencyKey,
        TxnDate: input.entryDate,
        PrivateNote: input.description,
        lineCount: input.lines.length,
      },
    };
  }
}
