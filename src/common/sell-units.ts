/**
 * Sell units for quantity-tracked products (grocery, retail, etc.).
 * pcs/pack = whole counts; kg/g/L/ml = weight/volume (fractional stock OK).
 */

export const SELL_UNITS = ['pcs', 'pack', 'kg', 'g', 'L', 'ml'] as const;
export type SellUnit = (typeof SELL_UNITS)[number];

export const SELL_UNIT_OPTIONS: Array<{
  value: SellUnit;
  label: string;
  priceHint: string;
  qtyHint: string;
}> = [
  {
    value: 'pcs',
    label: 'Piece (pcs)',
    priceHint: 'Price per piece',
    qtyHint: 'Whole pieces only (0, 1, 2…)',
  },
  {
    value: 'pack',
    label: 'Pack / box',
    priceHint: 'Price per pack',
    qtyHint: 'Whole packs only',
  },
  {
    value: 'kg',
    label: 'Kilogram (kg)',
    priceHint: 'Price per kg',
    qtyHint: 'e.g. 2.5 kg — up to 3 decimals',
  },
  {
    value: 'g',
    label: 'Gram (g)',
    priceHint: 'Price per gram',
    qtyHint: 'Whole grams preferred (500, 1000…)',
  },
  {
    value: 'L',
    label: 'Litre (L)',
    priceHint: 'Price per litre',
    qtyHint: 'e.g. 1.5 L — up to 3 decimals',
  },
  {
    value: 'ml',
    label: 'Millilitre (ml)',
    priceHint: 'Price per ml',
    qtyHint: 'Whole ml preferred',
  },
];

const WHOLE_UNITS = new Set<SellUnit>(['pcs', 'pack', 'g', 'ml']);
const DECIMAL_UNITS = new Set<SellUnit>(['kg', 'L']);

export function isSellUnit(v: unknown): v is SellUnit {
  return typeof v === 'string' && (SELL_UNITS as readonly string[]).includes(v);
}

export function normalizeSellUnit(v: unknown): SellUnit {
  return isSellUnit(v) ? v : 'pcs';
}

export function requiresWholeQty(unit: SellUnit): boolean {
  return WHOLE_UNITS.has(unit);
}

export function allowsDecimalQty(unit: SellUnit): boolean {
  return DECIMAL_UNITS.has(unit);
}

/** Round qty to unit precision (3dp for kg/L, integer for pcs/pack/g/ml). */
export function normalizeQty(qty: number, unit: SellUnit): number {
  if (!Number.isFinite(qty) || qty < 0) return NaN;
  if (requiresWholeQty(unit)) return Math.round(qty);
  return Math.round(qty * 1000) / 1000;
}

export function validateSellPrice(price: number): string | null {
  if (!Number.isFinite(price)) return 'Enter a valid price';
  if (price <= 0) return 'Price must be greater than 0';
  if (price > 9_999_999.99) return 'Price is too large';
  // max 2 decimal places for money
  if (Math.round(price * 100) / 100 !== price) {
    return 'Price can have at most 2 decimal places';
  }
  return null;
}

export function validateSellQty(qty: number, unit: SellUnit): string | null {
  if (!Number.isFinite(qty)) return 'Enter a valid quantity';
  if (qty < 0) return 'Quantity cannot be negative';
  if (qty > 99_999_999) return 'Quantity is too large';

  if (requiresWholeQty(unit)) {
    if (!Number.isInteger(qty)) {
      return unit === 'pcs' || unit === 'pack'
        ? `Quantity for ${unit} must be a whole number (no decimals)`
        : `Quantity for ${unit} must be a whole number`;
    }
  } else {
    const rounded = Math.round(qty * 1000) / 1000;
    if (Math.abs(rounded - qty) > 1e-9) {
      return `Quantity for ${unit} can have at most 3 decimal places (e.g. 1.250)`;
    }
  }
  return null;
}

export function validateSku(sku: string): string | null {
  const s = sku.trim();
  if (s.length < 1) return 'SKU is required';
  if (s.length > 100) return 'SKU is too long';
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(s)) {
    return 'SKU: use letters, numbers, and . _ - / only';
  }
  return null;
}

export function validateProductTitle(title: string): string | null {
  const t = title.trim();
  if (t.length < 2) return 'Title needs at least 2 characters';
  if (t.length > 255) return 'Title is too long';
  return null;
}
