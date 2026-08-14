export type AdapterAccount = { id: string; name: string; code?: string };
export type AdapterSyncResult = {
  ok: boolean;
  externalId?: string;
  externalName?: string;
  skipped?: boolean;
  error?: string;
  payload?: Record<string, unknown>;
};

export type AdapterContext = {
  tenantId: string;
  config: Record<string, unknown>;
};

export interface AccountingIntegrationAdapter {
  readonly provider: string;
  connect(ctx: AdapterContext): Promise<{ status: string; externalOrgId?: string }>;
  authenticate(ctx: AdapterContext): Promise<{ ok: boolean; message: string }>;
  testConnection(ctx: AdapterContext): Promise<{ ok: boolean; message: string }>;
  disconnect(ctx: AdapterContext): Promise<void>;
  syncAccounts?(ctx: AdapterContext): Promise<AdapterAccount[]>;
  syncCustomers?(ctx: AdapterContext): Promise<AdapterSyncResult>;
  syncSuppliers?(ctx: AdapterContext): Promise<AdapterSyncResult>;
  syncItems?(ctx: AdapterContext): Promise<AdapterSyncResult>;
  syncInvoices?(ctx: AdapterContext): Promise<AdapterSyncResult>;
  syncPayments?(ctx: AdapterContext): Promise<AdapterSyncResult>;
  syncExpenses?(ctx: AdapterContext): Promise<AdapterSyncResult>;
  syncJournalEntries?(
    ctx: AdapterContext,
    input: {
      localId: string;
      idempotencyKey: string;
      description: string;
      entryDate: string;
      lines: Array<{ accountCode?: string; debit: string; credit: string; description?: string }>;
    },
  ): Promise<AdapterSyncResult>;
  syncCreditNotes?(ctx: AdapterContext): Promise<AdapterSyncResult>;
  exportRange?(
    ctx: AdapterContext,
    input: { from: string; to: string; journals: unknown[] },
  ): Promise<AdapterSyncResult>;
  getSyncStatus?(ctx: AdapterContext): Promise<{ status: string }>;
}
