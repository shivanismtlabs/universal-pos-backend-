import { Injectable } from '@nestjs/common';
import type {
  AccountingIntegrationAdapter,
  AdapterContext,
  AdapterSyncResult,
} from './adapter';

/**
 * Tally is file-export, not a live API. Journals are serialized to XML;
 * records are marked synced only after export generation succeeds.
 */
@Injectable()
export class TallyAdapter implements AccountingIntegrationAdapter {
  readonly provider = 'TALLY';

  async connect(ctx: AdapterContext) {
    return {
      status: 'connected',
      externalOrgId: String(ctx.config.companyName ?? 'Tally'),
    };
  }

  async authenticate() {
    return { ok: true, message: 'Tally export does not require OAuth' };
  }

  async testConnection(ctx: AdapterContext) {
    return {
      ok: true,
      message: `Tally export ready for ${String(ctx.config.companyName ?? 'default company')}`,
    };
  }

  async disconnect() {
    return;
  }

  async syncJournalEntries(
    _ctx: AdapterContext,
    input: {
      localId: string;
      idempotencyKey: string;
      description: string;
      entryDate: string;
      lines: Array<{ accountCode?: string; debit: string; credit: string; description?: string }>;
    },
  ): Promise<AdapterSyncResult> {
    const xml = this.toXml(input);
    return {
      ok: true,
      externalId: input.idempotencyKey,
      payload: { format: 'xml', xml, idempotencyKey: input.idempotencyKey },
    };
  }

  async exportRange(
    ctx: AdapterContext,
    input: { from: string; to: string; journals: unknown[] },
  ): Promise<AdapterSyncResult> {
    const xml = [
      '<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>',
      ...(input.journals as Array<{ xml?: string }>).map((j) => j.xml ?? ''),
      '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>',
    ].join('');
    return {
      ok: true,
      externalId: `tally-export-${input.from}-${input.to}`,
      payload: {
        format: 'xml',
        xml,
        companyName: ctx.config.companyName ?? null,
        from: input.from,
        to: input.to,
        count: input.journals.length,
      },
    };
  }

  private toXml(input: {
    localId: string;
    idempotencyKey: string;
    description: string;
    entryDate: string;
    lines: Array<{ accountCode?: string; debit: string; credit: string; description?: string }>;
  }) {
    const vouchers = input.lines
      .map((l) => {
        const isDebit = Number(l.debit) > 0;
        return `<LEDGERENTRIES.LIST>
  <LEDGERNAME>${escapeXml(l.accountCode || l.description || 'Ledger')}</LEDGERNAME>
  <ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
  <AMOUNT>${isDebit ? l.debit : l.credit}</AMOUNT>
</LEDGERENTRIES.LIST>`;
      })
      .join('\n');
    return `<TALLYMESSAGE>
<VOUCHER VCHTYPE="Journal" ACTION="Create" DATE="${input.entryDate}" GUID="${input.idempotencyKey}">
  <NARRATION>${escapeXml(input.description)}</NARRATION>
  ${vouchers}
</VOUCHER>
</TALLYMESSAGE>`;
  }
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
