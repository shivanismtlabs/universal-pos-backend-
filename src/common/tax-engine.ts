import { Prisma, TaxMode } from '@prisma/client';

/**
 * Shared tax engine for Sale POS + Billing invoices.
 * Reads Tenant.taxMode + Tenant.settings.tax — never hardcode rates at call sites.
 */

export type TenantTaxSettings = {
  /** Percent e.g. 5 or 18. Defaults by taxMode when omitted. */
  ratePercent?: number;
  /** When true, unit prices already include tax. */
  inclusive?: boolean;
  receiptFooter?: string;
};

export type TaxProfile = {
  taxMode: TaxMode;
  taxId: string | null;
  rate: number;
  inclusive: boolean;
  receiptFooter: string;
};

export type LineTaxInput = {
  /** Pre-tax or tax-inclusive unit × qty depending on profile.inclusive */
  lineGross: Prisma.Decimal | number | string;
};

export type LineTaxResult = {
  /** Amount stored as OrderItem.lineTotal (net of tax when exclusive or extracted when inclusive) */
  lineTotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
};

const money = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

function defaultRateForMode(mode: TaxMode): number {
  switch (mode) {
    case TaxMode.none:
      return 0;
    case TaxMode.in_gst:
      return 0.05;
    case TaxMode.vat:
      return 0.2;
    case TaxMode.simple:
      return 0.05;
    default:
      return 0;
  }
}

/** Default percent (e.g. 5) for a tax mode — used when settings.tax is unset. */
export function defaultRatePercentForMode(mode: TaxMode): number {
  return Math.round(defaultRateForMode(mode) * 10000) / 100;
}

function coerceRatePercent(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/%/g, '').trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function parseTaxSettings(raw: unknown): TenantTaxSettings {
  if (!raw || typeof raw !== 'object') return {};
  const root = raw as Record<string, unknown>;
  const tax =
    root.tax && typeof root.tax === 'object'
      ? (root.tax as Record<string, unknown>)
      : (root as Record<string, unknown>);
  const out: TenantTaxSettings = {};
  const rate = coerceRatePercent(tax.ratePercent);
  if (rate !== undefined) out.ratePercent = rate;
  if (typeof tax.inclusive === 'boolean') out.inclusive = tax.inclusive;
  else if (typeof root.taxInclusive === 'boolean')
    out.inclusive = root.taxInclusive;
  if (typeof tax.receiptFooter === 'string') out.receiptFooter = tax.receiptFooter;
  return out;
}

/** Ensure tenant.settings.tax has ratePercent + inclusive (exclusive by default). */
export function ensureTenantTaxSettings(
  settings: unknown,
  taxMode: TaxMode,
): Record<string, unknown> {
  const root =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? { ...(settings as Record<string, unknown>) }
      : {};
  const prev =
    root.tax && typeof root.tax === 'object'
      ? { ...(root.tax as Record<string, unknown>) }
      : {};
  const parsed = parseTaxSettings(root);
  const ratePercent =
    parsed.ratePercent !== undefined
      ? parsed.ratePercent
      : defaultRatePercentForMode(taxMode);
  root.tax = {
    ...prev,
    ratePercent: taxMode === TaxMode.none ? 0 : ratePercent,
    inclusive: parsed.inclusive === true,
    ...(typeof prev.receiptFooter === 'string'
      ? { receiptFooter: prev.receiptFooter }
      : typeof parsed.receiptFooter === 'string'
        ? { receiptFooter: parsed.receiptFooter }
        : {}),
  };
  return root;
}

export function buildTaxProfile(input: {
  taxMode: TaxMode;
  taxId?: string | null;
  settings?: unknown;
}): TaxProfile {
  const parsed = parseTaxSettings(input.settings);
  const settingsObj =
    input.settings && typeof input.settings === 'object'
      ? (input.settings as Record<string, unknown>)
      : {};
  const taxBag =
    settingsObj.tax && typeof settingsObj.tax === 'object'
      ? (settingsObj.tax as Record<string, unknown>)
      : {};

  let rate =
    parsed.ratePercent !== undefined
      ? Number(parsed.ratePercent) / 100
      : defaultRateForMode(input.taxMode);

  if (input.taxMode === TaxMode.none) rate = 0;
  if (!Number.isFinite(rate) || rate < 0) rate = 0;
  if (rate > 0.4) rate = 0.4; // hard cap

  return {
    taxMode: input.taxMode,
    taxId: input.taxId ?? null,
    rate,
    inclusive: parsed.inclusive === true,
    receiptFooter:
      typeof taxBag.receiptFooter === 'string'
        ? taxBag.receiptFooter
        : typeof parsed.receiptFooter === 'string'
          ? parsed.receiptFooter
          : '',
  };
}

/** Compute net lineTotal + taxAmount for one cart line.
 * Optional `rate` overrides the tenant profile rate (product-level GST %).
 */
export function computeLineTax(
  profile: TaxProfile,
  input: LineTaxInput & { rate?: number },
): LineTaxResult {
  const gross = money(input.lineGross);
  const rate =
    input.rate !== undefined && Number.isFinite(input.rate)
      ? Math.min(0.4, Math.max(0, input.rate))
      : profile.rate;

  if (rate <= 0 || profile.taxMode === TaxMode.none) {
    return { lineTotal: gross, taxAmount: money(0) };
  }

  if (profile.inclusive) {
    // gross includes tax: net = gross / (1+r), tax = gross - net
    const divisor = money(1).add(rate);
    const net = gross.div(divisor).toDecimalPlaces(2);
    const tax = gross.sub(net).toDecimalPlaces(2);
    return { lineTotal: net, taxAmount: tax };
  }

  // exclusive: tax on net; lineTotal stays net
  const tax = gross.mul(rate).toDecimalPlaces(2);
  return { lineTotal: gross.toDecimalPlaces(2), taxAmount: tax };
}

/** Resolve product tax % from meta.taxRatePercent or taxCode (GST5 / 18 / VAT20). */
export function resolveProductTaxRatePercent(input: {
  taxCode?: string | null;
  meta?: unknown;
}): number | null {
  const meta =
    input.meta && typeof input.meta === 'object' && !Array.isArray(input.meta)
      ? (input.meta as Record<string, unknown>)
      : {};
  if (meta.taxPreference === 'non_taxable') return 0;
  if (
    typeof meta.taxRatePercent === 'number' &&
    Number.isFinite(meta.taxRatePercent)
  ) {
    return Math.min(40, Math.max(0, meta.taxRatePercent));
  }
  if (
    typeof meta.taxRatePercent === 'string' &&
    meta.taxRatePercent.trim() !== ''
  ) {
    const n = Number(meta.taxRatePercent.replace(/%/g, '').trim());
    if (Number.isFinite(n)) return Math.min(40, Math.max(0, n));
  }
  const code = input.taxCode?.trim();
  if (!code) return null;

  // Explicit rate tags only — never treat HSN/SAC (e.g. 1905, 9987) as a %.
  const tagged = code.match(/^(?:GST|VAT|TAX)\s*(\d+(?:\.\d+)?)\s*%?$/i);
  if (tagged) {
    const n = Number(tagged[1]);
    if (!Number.isFinite(n)) return null;
    return Math.min(40, Math.max(0, n));
  }

  // Bare percent like "5" / "18%" — 1–2 digit rates only (HSN is 4+ digits).
  const bare = code.match(/^(\d{1,2}(?:\.\d+)?)\s*%?$/);
  if (bare) {
    const n = Number(bare[1]);
    if (!Number.isFinite(n) || n > 40) return null;
    return Math.max(0, n);
  }

  return null;
}

/** Invoice breakdown from order subtotal (net) using profile rate. */
export function computeInvoiceTax(profile: TaxProfile, subtotalNet: number) {
  const rate = profile.rate;
  const totalTax = Number((subtotalNet * rate).toFixed(2));
  return { totalTax, rate };
}
