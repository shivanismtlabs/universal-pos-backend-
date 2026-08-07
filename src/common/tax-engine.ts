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

export function parseTaxSettings(raw: unknown): TenantTaxSettings {
  if (!raw || typeof raw !== 'object') return {};
  const root = raw as Record<string, unknown>;
  const tax = (root.tax ?? root) as Record<string, unknown>;
  const out: TenantTaxSettings = {};
  if (typeof tax.ratePercent === 'number' && Number.isFinite(tax.ratePercent)) {
    out.ratePercent = tax.ratePercent;
  }
  if (typeof tax.inclusive === 'boolean') out.inclusive = tax.inclusive;
  if (typeof tax.receiptFooter === 'string') out.receiptFooter = tax.receiptFooter;
  return out;
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

/** Compute net lineTotal + taxAmount for one cart line. */
export function computeLineTax(
  profile: TaxProfile,
  input: LineTaxInput,
): LineTaxResult {
  const gross = money(input.lineGross);
  if (profile.rate <= 0 || profile.taxMode === TaxMode.none) {
    return { lineTotal: gross, taxAmount: money(0) };
  }

  if (profile.inclusive) {
    // gross includes tax: net = gross / (1+r), tax = gross - net
    const divisor = money(1).add(profile.rate);
    const net = gross.div(divisor).toDecimalPlaces(2);
    const tax = gross.sub(net).toDecimalPlaces(2);
    return { lineTotal: net, taxAmount: tax };
  }

  // exclusive: tax on net; lineTotal stays net
  const tax = gross.mul(profile.rate).toDecimalPlaces(2);
  return { lineTotal: gross.toDecimalPlaces(2), taxAmount: tax };
}

/** Invoice breakdown from order subtotal (net) using profile rate. */
export function computeInvoiceTax(profile: TaxProfile, subtotalNet: number) {
  const rate = profile.rate;
  const totalTax = Number((subtotalNet * rate).toFixed(2));
  return { totalTax, rate };
}
