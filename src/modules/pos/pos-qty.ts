import { Prisma } from '@prisma/client';
import type { LineCalcResult } from '../catalog/pricing-engine';
import { d } from '../catalog/pricing-engine';

/** Canonical inventory qty stored on a sale line (historical snapshot preferred). */
export function inventoryQtyOf(item: {
  baseQuantity?: Prisma.Decimal | string | number | null;
  quantity: Prisma.Decimal | string | number;
}): Prisma.Decimal {
  if (item.baseQuantity != null && item.baseQuantity !== '') {
    return d(item.baseQuantity);
  }
  return d(item.quantity);
}

export function orderLineSnapshotFields(calc: LineCalcResult): {
  quantity: Prisma.Decimal;
  unitPrice: string;
  orderedQuantity: Prisma.Decimal;
  orderedUnitId: string;
  orderedUnitSymbol: string;
  baseQuantity: Prisma.Decimal;
  baseUnitId: string;
  baseUnitSymbol: string;
  conversionFactor: Prisma.Decimal;
  priceSource: string;
} {
  return {
    quantity: calc.orderedQuantity,
    unitPrice: calc.unitPrice.toFixed(4),
    orderedQuantity: calc.orderedQuantity,
    orderedUnitId: calc.orderedUnitId,
    orderedUnitSymbol: calc.orderedUnitSymbol,
    baseQuantity: calc.baseQuantity,
    baseUnitId: calc.baseUnitId,
    baseUnitSymbol: calc.baseUnitSymbol,
    conversionFactor: calc.conversionFactor,
    priceSource: calc.priceSource,
  };
}

export function calcMeta(calc: LineCalcResult, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    conversionPath: calc.conversionPath,
    priceSource: calc.priceSource,
    orderedUnit: calc.orderedUnitSymbol,
    baseUnit: calc.baseUnitSymbol,
    baseQuantity: calc.baseQuantity.toString(),
    conversionFactor: calc.conversionFactor.toString(),
    // Flipkart pricing snapshot
    mrp: calc.mrp.toFixed(2),
    grossMrp: calc.grossMrp.toFixed(2),
    sellingPrice: calc.sellingPrice.toFixed(2),
    productDiscountPerUnit: calc.productDiscountPerUnit.toFixed(2),
    productDiscount: calc.productDiscount.toFixed(2),
    productDiscountPercent: calc.productDiscountPercent,
    productNet: calc.productNet.toFixed(2),
    hasProductDiscount: calc.hasProductDiscount,
  };
}
