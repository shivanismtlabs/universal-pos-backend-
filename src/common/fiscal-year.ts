/** Fiscal year start month (1–12) from tenant settings. */

const MONTH_NAME_TO_NUMBER: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function fiscalMonthNameToNumber(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const mdy = t.match(/^(\d{1,2})/);
  if (mdy) {
    const m = Number(mdy[1]);
    if (m >= 1 && m <= 12) return m;
  }
  const key = t.toLowerCase().split(/[^a-z]/)[0];
  return MONTH_NAME_TO_NUMBER[key] ?? null;
}

function readMonthNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const m = Math.floor(value);
    if (m >= 1 && m <= 12) return m;
  }
  if (typeof value === 'string' && value.trim()) {
    return fiscalMonthNameToNumber(value);
  }
  return null;
}

/**
 * Resolve fiscal year start month from tenant.settings (1–12).
 * Checks top-level month, accounting block, organization profile, then month name strings.
 * Defaults to January (1) when unset.
 */
export function resolveFiscalStartMonth(settings: unknown): number {
  const root =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {};

  const top = readMonthNumber(root.fiscalYearStartMonth);
  if (top != null) return top;

  const accounting =
    root.accounting && typeof root.accounting === 'object'
      ? (root.accounting as Record<string, unknown>)
      : {};
  const acct = readMonthNumber(accounting.fiscalYearStartMonth);
  if (acct != null) return acct;

  const org =
    root.organizationProfile && typeof root.organizationProfile === 'object'
      ? (root.organizationProfile as Record<string, unknown>)
      : {};
  const orgMonth = readMonthNumber(org.fiscalYearStart);
  if (orgMonth != null) return orgMonth;

  const named = readMonthNumber(root.fiscalYearStart);
  if (named != null) return named;

  return 1;
}
