import { randomBytes } from 'crypto';

export const BARCODE_TYPE_CODE128 = 'code128';

/** Normalize for storage / uniqueness (trim + upper for Code 128 payloads). */
export function normalizeBarcode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Detect label symbology for rendering.
 * Internally generated codes are always Code 128 — never fake EAN/UPC.
 * Manual entry may still be an existing EAN/UPC from packaging.
 */
export function detectBarcodeType(value: string): string {
  const v = value.trim();
  if (/^\d{13}$/.test(v)) return 'ean13';
  if (/^\d{12}$/.test(v)) return 'upca';
  if (/^\d{8}$/.test(v)) return 'ean8';
  return BARCODE_TYPE_CODE128;
}

/**
 * Next internal Code 128 payload (subset B: A–Z / 0–9).
 * Prefix `UP` = Universal POS internal — not a GS1 EAN/UPC number.
 * Caller must verify uniqueness and retry.
 */
export function nextInternalCode128Candidate(): string {
  const body = randomBytes(6)
    .toString('hex')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .padEnd(10, '0')
    .slice(0, 10);
  return `UP${body}`;
}

/** @deprecated Use nextInternalCode128Candidate — kept for any leftover imports */
export function nextInStoreEan13Candidate(): string {
  return nextInternalCode128Candidate();
}

export function ean13CheckDigit(d12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = Number(d12[i] ?? 0);
    sum += i % 2 === 0 ? n : n * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

export type ScaleBarcodeParse = {
  itemCode: string;
  quantity: string;
  /** Implied unit when encoded by GS1 AI (kg / lb). */
  unitHint?: 'kg' | 'lb' | 'g';
};

/**
 * Resolve quantity encoded in a scan payload — GS1 AI 310x/320x, in-store
 * EAN-13 (prefix 2), or `code*qty` / `code|qty`. Returns null when the scan
 * is a plain product/unit barcode with no embedded quantity.
 */
export function parseScaleBarcode(raw: string): ScaleBarcodeParse | null {
  const v = raw.trim();
  if (!v) return null;

  const gs1 = v.match(
    /(?:\(|FNC1)?01\)?(\d{14}).*?(?:\(?(?:310|320)(\d)\)?)(\d{6})/i,
  );
  if (gs1) {
    const gtin = gs1[1]!;
    const decimals = Number(gs1[2]);
    const mag = gs1[3]!;
    const ai = v.match(/320\d/i) ? 'lb' : 'kg';
    const qty = (Number(mag) / 10 ** decimals).toString();
    return { itemCode: gtin.replace(/^0/, ''), quantity: qty, unitHint: ai };
  }

  const split = v.match(/^(.+?)(?:\*+|\/+|\|)(\d+(?:\.\d+)?)$/);
  if (split && split[1] && split[2]) {
    return { itemCode: split[1].trim(), quantity: split[2] };
  }

  // In-store EAN-13: 2 + 6-digit item + 5-digit qty (typically grams) + check
  if (/^2\d{12}$/.test(v) && ean13CheckDigit(v.slice(0, 12)) === v[12]) {
    const itemCode = v.slice(1, 7);
    const grams = v.slice(7, 12);
    const g = Number(grams);
    if (Number.isFinite(g) && g > 0) {
      return { itemCode, quantity: String(g), unitHint: 'g' };
    }
  }

  return null;
}
