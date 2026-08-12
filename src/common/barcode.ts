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
