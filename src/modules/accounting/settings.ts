export type AccountingBasis = 'cash' | 'accrual';

export type AccountingSettings = {
  enabled: boolean;
  basis: AccountingBasis;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  taxCountry: string;
  inventoryAccountingEnabled: boolean;
  cogsEnabled: boolean;
};

export const DEFAULT_ACCOUNTING_SETTINGS: AccountingSettings = {
  enabled: false,
  basis: 'accrual',
  baseCurrency: 'INR',
  fiscalYearStartMonth: 4,
  taxCountry: 'IN',
  inventoryAccountingEnabled: false,
  cogsEnabled: false,
};

export function parseAccountingSettings(
  tenantSettings: unknown,
  fallbackCurrency = 'INR',
): AccountingSettings {
  const root =
    tenantSettings && typeof tenantSettings === 'object'
      ? (tenantSettings as Record<string, unknown>)
      : {};
  const a =
    root.accounting && typeof root.accounting === 'object'
      ? (root.accounting as Record<string, unknown>)
      : {};
  const monthRaw = a.fiscalYearStartMonth;
  const month =
    typeof monthRaw === 'number' && monthRaw >= 1 && monthRaw <= 12
      ? Math.floor(monthRaw)
      : DEFAULT_ACCOUNTING_SETTINGS.fiscalYearStartMonth;
  return {
    enabled: Boolean(a.enabled),
    basis: a.basis === 'cash' ? 'cash' : 'accrual',
    baseCurrency:
      typeof a.baseCurrency === 'string' && a.baseCurrency.trim()
        ? a.baseCurrency.trim().toUpperCase().slice(0, 3)
        : fallbackCurrency,
    fiscalYearStartMonth: month,
    taxCountry:
      typeof a.taxCountry === 'string' && a.taxCountry.trim()
        ? a.taxCountry.trim().toUpperCase().slice(0, 8)
        : DEFAULT_ACCOUNTING_SETTINGS.taxCountry,
    inventoryAccountingEnabled: Boolean(a.inventoryAccountingEnabled),
    cogsEnabled: Boolean(a.cogsEnabled),
  };
}

export function mergeAccountingSettings(
  tenantSettings: unknown,
  patch: Partial<AccountingSettings>,
): Record<string, unknown> {
  const root =
    tenantSettings && typeof tenantSettings === 'object'
      ? { ...(tenantSettings as Record<string, unknown>) }
      : {};
  const prev = parseAccountingSettings(root);
  root.accounting = { ...prev, ...patch };
  return root;
}

export function fiscalYearBounds(
  asOf: Date,
  startMonth: number,
): { start: Date; end: Date; name: string } {
  const y = asOf.getUTCFullYear();
  const m = asOf.getUTCMonth() + 1;
  const startYear = m >= startMonth ? y : y - 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(startYear + 1, startMonth - 1, 0));
  const startLabel = start.toISOString().slice(0, 10);
  const endLabel = end.toISOString().slice(0, 10);
  return { start, end, name: `${startLabel} → ${endLabel}` };
}
