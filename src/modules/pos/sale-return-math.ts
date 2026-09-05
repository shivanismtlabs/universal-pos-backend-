import { Prisma } from '@prisma/client';
import {
  convertQuantity,
  reverseHistoricalBaseQty,
  type UnitRef,
  type ProductPricingRef,
  type ConversionEdge,
} from '../catalog/pricing-engine';

const money = (n: Prisma.Decimal | string | number) => new Prisma.Decimal(n);

export type SoldLineForReturn = {
  stockLevelId: string | null;
  quantity: Prisma.Decimal | string | number;
  unitPrice: Prisma.Decimal | string | number;
  lineTotal: Prisma.Decimal | string | number;
  taxAmount?: Prisma.Decimal | string | number | null;
  orderedQuantity?: Prisma.Decimal | string | number | null;
  orderedUnitSymbol?: string | null;
  orderedUnitId?: string | null;
  baseQuantity?: Prisma.Decimal | string | number | null;
  baseUnitSymbol?: string | null;
  baseUnitId?: string | null;
  priceQuantity?: Prisma.Decimal | string | number | null;
  priceUnitSymbol?: string | null;
  conversionFactor?: Prisma.Decimal | string | number | null;
  meta?: any;
};

export type ReturnQtyLine = {
  stockLevelId: string;
  quantity: number;
  condition?: string;
  unitSymbol?: string;
  returnUnitSymbol?: string;
  unitId?: string;
  returnUnitId?: string;
  unit?: UnitRef;
  baseUnit?: UnitRef;
  product?: ProductPricingRef;
  unitsById?: Map<string, UnitRef>;
  extraEdges?: ConversionEdge[];
};

export type ComputedReturnLine = {
  stockLevelId: string;
  quantity: number;
  unitPrice: number;
  condition: string;
  /** Net merchandise share (excl. tax) for returned qty */
  netShare: number;
  /** Tax share for returned qty (from original lines) */
  taxShare: number;
  /** Allocated order-level discount share */
  discountShare: number;
  /** Refundable for this line after discount */
  refundShare: number;
  /** UOM snapshot & base quantity */
  returnBaseQty: number;
  orderedQuantity?: number;
  orderedUnitSymbol?: string;
  baseQuantity?: number;
  baseUnitSymbol?: string;
  priceQuantity?: number;
  priceUnitSymbol?: string;
};

const STANDARD_UNIT_SYMBOLS: Record<
  string,
  { group: string; factorToGroupBase: number }
> = {
  // WEIGHT (base: g)
  g: { group: 'WEIGHT', factorToGroupBase: 1 },
  gram: { group: 'WEIGHT', factorToGroupBase: 1 },
  grams: { group: 'WEIGHT', factorToGroupBase: 1 },
  kg: { group: 'WEIGHT', factorToGroupBase: 1000 },
  kilogram: { group: 'WEIGHT', factorToGroupBase: 1000 },
  kilograms: { group: 'WEIGHT', factorToGroupBase: 1000 },
  mg: { group: 'WEIGHT', factorToGroupBase: 0.001 },
  milligram: { group: 'WEIGHT', factorToGroupBase: 0.001 },
  t: { group: 'WEIGHT', factorToGroupBase: 1000000 },
  ton: { group: 'WEIGHT', factorToGroupBase: 1000000 },
  tonne: { group: 'WEIGHT', factorToGroupBase: 1000000 },
  lb: { group: 'WEIGHT', factorToGroupBase: 453.59237 },
  oz: { group: 'WEIGHT', factorToGroupBase: 28.349523125 },

  // VOLUME (base: ml)
  ml: { group: 'VOLUME', factorToGroupBase: 1 },
  milliliter: { group: 'VOLUME', factorToGroupBase: 1 },
  millilitre: { group: 'VOLUME', factorToGroupBase: 1 },
  l: { group: 'VOLUME', factorToGroupBase: 1000 },
  liter: { group: 'VOLUME', factorToGroupBase: 1000 },
  litre: { group: 'VOLUME', factorToGroupBase: 1000 },
  cl: { group: 'VOLUME', factorToGroupBase: 10 },
  dl: { group: 'VOLUME', factorToGroupBase: 100 },

  // LENGTH (base: cm)
  cm: { group: 'LENGTH', factorToGroupBase: 1 },
  centimeter: { group: 'LENGTH', factorToGroupBase: 1 },
  centimetre: { group: 'LENGTH', factorToGroupBase: 1 },
  m: { group: 'LENGTH', factorToGroupBase: 100 },
  meter: { group: 'LENGTH', factorToGroupBase: 100 },
  metre: { group: 'LENGTH', factorToGroupBase: 100 },
  mm: { group: 'LENGTH', factorToGroupBase: 0.1 },
  millimeter: { group: 'LENGTH', factorToGroupBase: 0.1 },
  km: { group: 'LENGTH', factorToGroupBase: 100000 },
  in: { group: 'LENGTH', factorToGroupBase: 2.54 },
  ft: { group: 'LENGTH', factorToGroupBase: 30.48 },

  // COUNT (base: pcs)
  pcs: { group: 'COUNT', factorToGroupBase: 1 },
  piece: { group: 'COUNT', factorToGroupBase: 1 },
  pieces: { group: 'COUNT', factorToGroupBase: 1 },
  item: { group: 'COUNT', factorToGroupBase: 1 },
  items: { group: 'COUNT', factorToGroupBase: 1 },
  unit: { group: 'COUNT', factorToGroupBase: 1 },
  units: { group: 'COUNT', factorToGroupBase: 1 },
  dozen: { group: 'COUNT', factorToGroupBase: 12 },
  doz: { group: 'COUNT', factorToGroupBase: 12 },
  pair: { group: 'COUNT', factorToGroupBase: 2 },
};

export function resolveReturnBaseQty(opts: {
  returnQty: number;
  returnUnitSymbol?: string;
  returnUnit?: UnitRef;
  baseUnit?: UnitRef;
  soldOrderedQty: number;
  soldOrderedUnitSymbol?: string;
  soldBaseQty: number;
  soldBaseUnitSymbol?: string;
  conversionFactor?: number | string | Prisma.Decimal | null;
  product?: ProductPricingRef;
  unitsById?: Map<string, UnitRef>;
  extraEdges?: ConversionEdge[];
}): number {
  const {
    returnQty,
    returnUnitSymbol,
    returnUnit,
    baseUnit,
    soldOrderedQty,
    soldOrderedUnitSymbol,
    soldBaseQty,
    soldBaseUnitSymbol,
    conversionFactor,
    product,
    unitsById,
    extraEdges,
  } = opts;

  if (returnQty <= 0) {
    throw new Error('Return quantity must be greater than 0');
  }

  // 1. If explicit UnitRef objects are provided
  if (returnUnit && baseUnit) {
    return convertQuantity({
      quantity: returnQty,
      fromUnit: returnUnit,
      toUnit: baseUnit,
      product,
      unitsById,
      extraEdges,
      validate: false,
    }).toNumber();
  }

  const retSym = (returnUnitSymbol || '').trim().toLowerCase();
  const ordSym = (soldOrderedUnitSymbol || '').trim().toLowerCase();
  const baseSym = (soldBaseUnitSymbol || '').trim().toLowerCase();

  // 2. If no return unit symbol specified or symbol matches ordered unit symbol
  if (!retSym || (ordSym && retSym === ordSym)) {
    if (soldOrderedQty <= 0) {
      throw new Error('Original sold quantity is invalid');
    }
    return reverseHistoricalBaseQty({
      originalOrderedQty: soldOrderedQty,
      originalBaseQty: soldBaseQty,
      returnOrderedQty: returnQty,
    }).toNumber();
  }

  // 3. If return unit symbol matches base unit symbol directly
  if (baseSym && retSym === baseSym) {
    return returnQty;
  }

  // 4. Try standard dimension conversion
  const fromStd = STANDARD_UNIT_SYMBOLS[retSym];
  const toStd = STANDARD_UNIT_SYMBOLS[baseSym] || STANDARD_UNIT_SYMBOLS[ordSym];

  if (fromStd && toStd) {
    if (fromStd.group !== toStd.group) {
      // Check if custom product conversion edge exists
      if (extraEdges && extraEdges.length > 0) {
        // Handled via graph if units are provided
      }
      throw new Error(
        `Incompatible units: cannot convert ${returnUnitSymbol} (${fromStd.group}) to ${soldBaseUnitSymbol || soldOrderedUnitSymbol} (${toStd.group})`,
      );
    }
    // Same dimension group conversion:
    // e.g. 0.5 kg (factor 1000) to g (factor 1) = 500 g -> baseQty = 500 * (soldBaseQty/soldOrderedQty)
    // or return in kg (factor 1000) when base is kg (factor 1000) -> factor 1
    const factorToBase = fromStd.factorToGroupBase / (STANDARD_UNIT_SYMBOLS[baseSym]?.factorToGroupBase || 1);
    return Number(money(returnQty).mul(factorToBase).toFixed(8));
  }

  // 5. If conversion factor was saved on line snapshot
  if (conversionFactor != null && Number(conversionFactor) > 0) {
    return Number(money(returnQty).mul(Number(conversionFactor)).toFixed(8));
  }

  throw new Error(
    `Incompatible units: cannot convert ${returnUnitSymbol || 'unknown'} to ${soldBaseUnitSymbol || soldOrderedUnitSymbol || 'base unit'}`,
  );
}

/**
 * Refund from the original sale: proportional line net + tax,
 * minus a share of order-level discount. Never invents tax rates or uses current catalog prices.
 *
 * Line-level discounts are already baked into `unitPrice` / `lineTotal`
 * at checkout — do not re-apply them here. `orderDiscountTotal` is only
 * the bill-level / coupon discount allocated by returned merchandise share.
 */
export function computeReturnRefundFromOriginal(args: {
  orderSubtotal: number;
  orderTaxTotal: number;
  orderDiscountTotal: number;
  soldItems: SoldLineForReturn[];
  returnItems: ReturnQtyLine[];
}): { amount: number; lines: ComputedReturnLine[] } {
  const merchandise = Math.max(
    0,
    Number(money(args.orderSubtotal).add(args.orderTaxTotal).toFixed(2)),
  );
  const discount = Math.max(
    0,
    Number(money(args.orderDiscountTotal).toFixed(2)),
  );

  type AggregatedSold = {
    soldOrderedQty: number;
    soldBaseQty: number;
    net: number;
    tax: number;
    unitPrice: number;
    orderedUnitSymbol: string;
    baseUnitSymbol: string;
    priceUnitSymbol: string;
    conversionFactor?: number | string | Prisma.Decimal | null;
  };

  const byLevel = new Map<string, AggregatedSold>();

  for (const item of args.soldItems) {
    if (!item.stockLevelId) continue;
    const orderedQty =
      item.orderedQuantity != null
        ? Number(item.orderedQuantity)
        : Number(item.quantity);
    const baseQty =
      item.baseQuantity != null
        ? Number(item.baseQuantity)
        : Number(item.quantity);
    const net = Number(item.lineTotal);
    const tax = Number(item.taxAmount ?? 0);
    const unit = Number(item.unitPrice);
    const ordSym =
      item.orderedUnitSymbol ||
      (typeof item.meta === 'object' && item.meta?.orderedUnitSymbol) ||
      '';
    const baseSym =
      item.baseUnitSymbol ||
      (typeof item.meta === 'object' && item.meta?.baseUnitSymbol) ||
      '';
    const priceSym =
      (typeof item.meta === 'object' && item.meta?.priceUnitSymbol) || '';

    const prev = byLevel.get(item.stockLevelId);
    if (prev) {
      prev.soldOrderedQty += orderedQty;
      prev.soldBaseQty += baseQty;
      prev.net += net;
      prev.tax += tax;
    } else {
      byLevel.set(item.stockLevelId, {
        soldOrderedQty: orderedQty,
        soldBaseQty: baseQty,
        net,
        tax,
        unitPrice: unit,
        orderedUnitSymbol: ordSym,
        baseUnitSymbol: baseSym,
        priceUnitSymbol: priceSym,
        conversionFactor: item.conversionFactor,
      });
    }
  }

  const lines: ComputedReturnLine[] = [];
  let grossBeforeDiscount = money(0);

  for (const ret of args.returnItems) {
    const sold = byLevel.get(ret.stockLevelId);
    if (!sold || sold.soldBaseQty <= 0) {
      throw new Error(`Item ${ret.stockLevelId} was not on this sale`);
    }

    const retUnitSym =
      ret.returnUnitSymbol ||
      ret.unitSymbol ||
      ret.unit?.symbol ||
      sold.orderedUnitSymbol;

    const returnBaseQty = resolveReturnBaseQty({
      returnQty: ret.quantity,
      returnUnitSymbol: retUnitSym,
      returnUnit: ret.unit,
      baseUnit: ret.baseUnit,
      soldOrderedQty: sold.soldOrderedQty,
      soldOrderedUnitSymbol: sold.orderedUnitSymbol,
      soldBaseQty: sold.soldBaseQty,
      soldBaseUnitSymbol: sold.baseUnitSymbol,
      conversionFactor: sold.conversionFactor,
      product: ret.product,
      unitsById: ret.unitsById,
      extraEdges: ret.extraEdges,
    });

    if (returnBaseQty > sold.soldBaseQty + 1e-9) {
      throw new Error(
        `Cannot return ${ret.quantity} (sold ${sold.soldOrderedQty})`,
      );
    }

    const share = sold.soldBaseQty > 0 ? returnBaseQty / sold.soldBaseQty : 0;
    const netShare = Number(money(sold.net).mul(share).toFixed(2));
    const taxShare = Number(money(sold.tax).mul(share).toFixed(2));
    const lineGross = Number(money(netShare).add(taxShare).toFixed(2));
    grossBeforeDiscount = grossBeforeDiscount.add(lineGross);

    lines.push({
      stockLevelId: ret.stockLevelId,
      quantity: ret.quantity,
      returnBaseQty: Number(returnBaseQty.toFixed(8)),
      unitPrice: sold.unitPrice,
      condition: ret.condition?.trim() || 'good',
      netShare,
      taxShare,
      discountShare: 0,
      refundShare: lineGross,
      orderedQuantity: sold.soldOrderedQty,
      orderedUnitSymbol: sold.orderedUnitSymbol,
      baseQuantity: sold.soldBaseQty,
      baseUnitSymbol: sold.baseUnitSymbol,
      priceUnitSymbol: sold.priceUnitSymbol,
    });
  }

  const grossNum = Number(grossBeforeDiscount.toFixed(2));
  const allocatedDiscount = Number(
    merchandise > 0
      ? money(discount).mul(grossNum).div(merchandise).toFixed(2)
      : '0',
  );
  let discountLeft = money(allocatedDiscount);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineGross = Number(
      money(line.netShare).add(line.taxShare).toFixed(2),
    );
    let disc = 0;
    if (discountLeft.gt(0) && grossNum > 0) {
      if (i === lines.length - 1) {
        disc = Number(discountLeft.toFixed(2));
      } else {
        disc = Number(
          money(lineGross).mul(allocatedDiscount).div(grossNum).toFixed(2),
        );
        discountLeft = discountLeft.sub(disc);
      }
    }
    line.discountShare = disc;
    line.refundShare = Number(money(lineGross).sub(disc).toFixed(2));
  }

  const amount = Number(
    lines
      .reduce((s, l) => s.add(l.refundShare), money(0))
      .toFixed(2),
  );

  return { amount, lines };
}
