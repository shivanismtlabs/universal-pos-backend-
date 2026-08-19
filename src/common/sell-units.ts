import { decimalQtyForUnit, isMeasureUnitCode } from './measure-units';

/**
 * Sell units for quantity-tracked products (grocery, retail, service hours, …).
 * Built-ins plus tenant Units from Settings; pcs/pack = whole counts; kg/L/hour = fractional.
 */

export const SELL_UNITS = ['pcs', 'pack', 'kg', 'g', 'L', 'ml'] as const;
export type SellUnit = string;

export const SELL_UNIT_OPTIONS: Array<{
  value: string;
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
    priceHint: 'Price per kilogram',
    qtyHint: 'Decimals allowed (for example 2.500)',
  },
  {
    value: 'g',
    label: 'Gram (g)',
    priceHint: 'Price per gram',
    qtyHint: 'Whole grams preferred',
  },
  {
    value: 'L',
    label: 'Litre (L)',
    priceHint: 'Price per litre',
    qtyHint: 'Decimals allowed (for example 1.500)',
  },
  {
    value: 'ml',
    label: 'Millilitre (ml)',
    priceHint: 'Price per ml',
    qtyHint: 'Whole ml preferred',
  },
];

export function isSellUnit(v: unknown): v is string {
  return isMeasureUnitCode(v);
}

export function normalizeSellUnit(v: unknown): SellUnit {
  return isMeasureUnitCode(v) ? String(v).trim() : 'pcs';
}

export function requiresWholeQty(
  unit: string,
  units?: import('./measure-units').MeasureUnit[],
): boolean {
  return !allowsDecimalQty(unit, units);
}

export function allowsDecimalQty(
  unit: string,
  units?: import('./measure-units').MeasureUnit[],
): boolean {
  return decimalQtyForUnit(normalizeSellUnit(unit), units);
}

/** Round qty to unit precision (3dp for kg/L, integer for pcs/pack/g/ml). */
export function normalizeQty(
  qty: number,
  unit: SellUnit,
  units?: import('./measure-units').MeasureUnit[],
): number {
  if (!Number.isFinite(qty) || qty < 0) return NaN;
  if (requiresWholeQty(unit, units)) return Math.round(qty);
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

export function validateSellQty(
  qty: number,
  unit: SellUnit,
  units?: import('./measure-units').MeasureUnit[],
): string | null {
  if (!Number.isFinite(qty)) return 'Enter a valid quantity';
  if (qty < 0) return 'Quantity cannot be negative';
  if (qty > 99_999_999) return 'Quantity is too large';

  if (requiresWholeQty(unit, units)) {
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
  if (s.length < 2) return 'SKU must be at least 2 characters';
  if (s.length > 18) return 'SKU must be at most 18 characters';
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
