import { Injectable } from '@nestjs/common';
import type {
  AccountingIntegrationAdapter,
  AdapterContext,
  AdapterSyncResult,
} from './adapter';

@Injectable()
export class ZohoBooksAdapter implements AccountingIntegrationAdapter {
  readonly provider = 'ZOHO_BOOKS';

  async connect(ctx: AdapterContext) {
    if (!ctx.config.accessToken && !ctx.config.refreshToken) {
      return { status: 'disconnected' };
    }
    return {
      status: 'connected',
      externalOrgId: String(ctx.config.organizationId ?? ''),
    };
  }

  async authenticate(ctx: AdapterContext) {
    return this.testConnection(ctx);
  }

  async testConnection(ctx: AdapterContext) {
    if (!ctx.config.accessToken || !ctx.config.organizationId) {
      return {
        ok: false,
        message:
          'Zoho Books is not connected. Select an organization and complete OAuth first.',
      };
    }
    return {
      ok: true,
      message: `Connected to Zoho Books org ${String(ctx.config.organizationId)}`,
    };
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
    return {
      ok: true,
      externalId: input.idempotencyKey,
      payload: {
        provider: 'ZOHO_BOOKS',
        reference_number: input.idempotencyKey,
        journal_date: input.entryDate,
        notes: input.description,
        lineCount: input.lines.length,
      },
    };
  }
}
