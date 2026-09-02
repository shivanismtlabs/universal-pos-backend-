/**
 * Universal quantity + conversion + pricing engine.
 *
 * Transaction unit → product conversion → canonical base qty → price →
 * discount → tax. Inventory always moves in the product base unit.
 *
 * Decimal-only for quantity and money. Never industry-specific (no grocery /
 * restaurant / clothing branches) — product + unit + conversion + price rule.
 */
import { Prisma } from '@prisma/client';
import {
  computeLineTax,
  type TaxProfile,
} from '../../common/tax-engine';

export const Decimal = Prisma.Decimal;
export type DecimalValue = Prisma.Decimal.Value;

export type RoundingMode = 'ROUND_HALF_UP' | 'ROUND_DOWN' | 'ROUND_BANKERS';

export type TenantQtyMoneySettings = {
  currencyDecimalPlaces: number;
  /** Display / JSON places — inventory qty is never silently rounded. */
  quantityDecimalPlaces: number;
  roundingMode: RoundingMode;
};

export type UnitRef = {
  id: string;
  symbol: string;
  unitGroupId: string;
  unitGroupCode: string;
  conversionToGroupBase: DecimalValue;
  isActive?: boolean;
};

export type ProductUnitRef = {
  unitId: string;
  conversionToBase: DecimalValue;
  fixedPrice: DecimalValue | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  quantityPrecision?: number | null;
  minQuantity?: DecimalValue | null;
  quantityStep?: DecimalValue | null;
  allowFraction?: boolean | null;
  barcode?: string | null;
  isDefaultSellingUnit?: boolean;
  isPurchaseUnit?: boolean;
};

export type ConversionEdge = {
  fromUnitId: string;
  toUnitId: string;
  /** 1 fromUnit = factor toUnit */
  factor: DecimalValue;
};

export type ProductPricingRef = {
  id: string;
  baseUnitId: string;
  pricingUnitId: string | null;
  pricingStrategy: 'CONVERTED' | 'FIXED_TIER';
  pricePerPricingUnit: DecimalValue | null;
  /** Catalog selling price in the pricing/base unit (fallback). */
  basePrice?: DecimalValue | null;
  productUnits: ProductUnitRef[];
  conversionEdges?: ConversionEdge[];
  availableInPos?: boolean;
  canSell?: boolean;
  canPurchase?: boolean;
  isActive?: boolean;
  trackQty?: boolean;
};

export type LineDiscountInput = {
  type: 'percent' | 'amount';
  value: DecimalValue;
};

export type PriceSource = 'unit_fixed' | 'converted' | 'override';

export type LineCalcResult = {
  orderedQuantity: Prisma.Decimal;
  orderedUnitId: string;
  orderedUnitSymbol: string;
  baseQuantity: Prisma.Decimal;
  baseUnitId: string;
  baseUnitSymbol: string;
  conversionFactor: Prisma.Decimal;
  conversionPath: string[];
  unitPrice: Prisma.Decimal;
  priceUnitId: string;
  priceUnitSymbol: string;
  priceSource: PriceSource;
  grossAmount: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  taxableAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  /** OrderItem.lineTotal — net of tax when exclusive, net extracted when inclusive. */
  lineTotal: Prisma.Decimal;
  finalAmount: Prisma.Decimal;
  inventoryImpact: Prisma.Decimal;
  validationWarnings: string[];
  /** Back-compat aliases used by quote API / existing tests */
  qtyBase: Prisma.Decimal;
  amount: Prisma.Decimal;
  conversionFactorUsed: Prisma.Decimal;
  enteredUnitId: string;
  enteredQty: Prisma.Decimal;
};

export class UnitPricingError extends Error {
  constructor(
    message: string,
    readonly code: string = 'UNIT_PRICING',
  ) {
    super(message);
    this.name = 'UnitPricingError';
  }
}

const DEFAULT_SETTINGS: TenantQtyMoneySettings = {
  currencyDecimalPlaces: 2,
  quantityDecimalPlaces: 8,
  roundingMode: 'ROUND_HALF_UP',
};

const MAX_HOPS = 16;
const MAX_ABS = new Decimal('1e18');
const QTY_INTERNAL_PLACES = 12;

const DECIMAL_ROUNDING: Record<RoundingMode, Prisma.Decimal.Rounding> = {
  ROUND_HALF_UP: Decimal.ROUND_HALF_UP,
  ROUND_DOWN: Decimal.ROUND_DOWN,
  ROUND_BANKERS: Decimal.ROUND_HALF_EVEN,
};

export function d(n: DecimalValue | Prisma.Decimal): Prisma.Decimal {
  if (n instanceof Decimal) return n;
  if (typeof n === 'number') {
    if (!Number.isFinite(n)) {
      throw new UnitPricingError('Invalid numeric value', 'INVALID_NUMBER');
    }
    return new Decimal(n.toString());
  }
  try {
    return new Decimal(n as DecimalValue);
  } catch {
    throw new UnitPricingError('Invalid numeric value', 'INVALID_NUMBER');
  }
}

export function roundMoney(
  value: DecimalValue,
  places: number,
  mode: RoundingMode = 'ROUND_HALF_UP',
): Prisma.Decimal {
  return d(value).toDecimalPlaces(places, DECIMAL_ROUNDING[mode]);
}

/** @deprecated Money-only. Do not use to mutate inventory quantities. */
export function roundDecimal(
  value: number,
  places: number,
  mode: RoundingMode = 'ROUND_HALF_UP',
): number {
  return Number(roundMoney(value, places, mode).toFixed(places));
}

function roundingOf(settings?: TenantQtyMoneySettings): RoundingMode {
  return settings?.roundingMode ?? DEFAULT_SETTINGS.roundingMode;
}

function moneyPlaces(settings?: TenantQtyMoneySettings): number {
  return settings?.currencyDecimalPlaces ?? DEFAULT_SETTINGS.currencyDecimalPlaces;
}

export function activeProductUnit(
  product: ProductPricingRef,
  unitId: string,
  at: Date,
): ProductUnitRef | undefined {
  return product.productUnits.find(
    (pu) =>
      pu.unitId === unitId &&
      pu.effectiveFrom <= at &&
      (pu.effectiveTo == null || pu.effectiveTo > at),
  );
}

function unitFactor(unit: UnitRef): Prisma.Decimal {
  const f = d(unit.conversionToGroupBase);
  if (!f.gt(0)) {
    throw new UnitPricingError(
      `Invalid conversion for unit ${unit.symbol}`,
      'INVALID_CONVERSION',
    );
  }
  return f;
}

function assertFiniteQty(qty: Prisma.Decimal, label = 'Quantity'): void {
  if (qty.isNaN() || !qty.isFinite()) {
    throw new UnitPricingError(`${label} must be a finite number`, 'INVALID_QTY');
  }
  if (qty.abs().gt(MAX_ABS)) {
    throw new UnitPricingError(`${label} overflows conversion limits`, 'OVERFLOW');
  }
}

/**
 * Validate entered transaction qty. Never silently rescales the customer's qty.
 */
export function validateEnteredQuantity(opts: {
  quantity: DecimalValue;
  unit: UnitRef;
  product?: ProductPricingRef;
  at?: Date;
}): void {
  const qty = d(opts.quantity);
  assertFiniteQty(qty);
  if (!qty.gt(0)) {
    throw new UnitPricingError('Quantity must be greater than 0', 'QTY_NOT_POSITIVE');
  }

  const pu = opts.product
    ? activeProductUnit(opts.product, opts.unit.id, opts.at ?? new Date())
    : undefined;

  const group = opts.unit.unitGroupCode;
  const defaultFraction = group !== 'COUNT';
  const allowFraction = pu?.allowFraction ?? defaultFraction;
  const precision =
    pu?.quantityPrecision ??
    (allowFraction ? (group === 'TIME' ? 4 : 6) : 0);
  const minQty = pu?.minQuantity != null ? d(pu.minQuantity) : new Decimal(0);
  const step =
    pu?.quantityStep != null
      ? d(pu.quantityStep)
      : allowFraction
        ? null
        : new Decimal(1);

  if (minQty.gt(0) && qty.lt(minQty)) {
    throw new UnitPricingError(
      `Quantity must be at least ${minQty.toString()} ${opts.unit.symbol}`,
      'QTY_BELOW_MIN',
    );
  }

  const dp = qty.decimalPlaces();
  if (precision === 0 || allowFraction === false) {
    if (!qty.isInteger()) {
      throw new UnitPricingError(
        `Quantity for ${opts.unit.symbol} must be a whole number`,
        'QTY_NOT_INTEGER',
      );
    }
  } else if (dp > precision) {
    throw new UnitPricingError(
      `Quantity for ${opts.unit.symbol} can have at most ${precision} decimal place(s)`,
      'QTY_PRECISION',
    );
  }

  if (step && step.gt(0)) {
    const origin = minQty.gt(0) ? minQty : new Decimal(0);
    const rem = qty.sub(origin).mod(step);
    if (!rem.isZero()) {
      throw new UnitPricingError(
        `Quantity for ${opts.unit.symbol} must be in steps of ${step.toString()}`,
        'QTY_STEP',
      );
    }
  }
}

function sameGroupConvert(
  quantity: Prisma.Decimal,
  fromUnit: UnitRef,
  toUnit: UnitRef,
): Prisma.Decimal {
  if (fromUnit.unitGroupId !== toUnit.unitGroupId) {
    throw new UnitPricingError(
      `Incompatible units: cannot convert ${fromUnit.symbol} (${fromUnit.unitGroupCode}) to ${toUnit.symbol} (${toUnit.unitGroupCode})`,
      'INCOMPATIBLE_UNITS',
    );
  }
  const out = quantity.mul(unitFactor(fromUnit)).div(unitFactor(toUnit));
  assertFiniteQty(out, 'Converted quantity');
  return out;
}

type GraphHop = { to: string; factor: Prisma.Decimal; label: string };

function buildGraph(opts: {
  product?: ProductPricingRef;
  unitsById: Map<string, UnitRef>;
  extraEdges?: ConversionEdge[];
  at: Date;
}): Map<string, GraphHop[]> {
  const graph = new Map<string, GraphHop[]>();
  const add = (from: string, to: string, factor: Prisma.Decimal, label: string) => {
    if (!(factor.gt(0)) || from === to) return;
    const list = graph.get(from) ?? [];
    list.push({ to, factor, label });
    graph.set(from, list);
    const rev = graph.get(to) ?? [];
    rev.push({
      to: from,
      factor: new Decimal(1).div(factor),
      label: `${label}⁻¹`,
    });
    graph.set(to, rev);
  };

  const units = [...opts.unitsById.values()];
  const byGroup = new Map<string, UnitRef[]>();
  for (const u of units) {
    const list = byGroup.get(u.unitGroupId) ?? [];
    list.push(u);
    byGroup.set(u.unitGroupId, list);
  }
  for (const groupUnits of byGroup.values()) {
    const sample = groupUnits[0];
    if (!sample) continue;
    // COUNT packaging is product-specific — do not assume 1 box = 1 pcs globally.
    if (sample.unitGroupCode === 'COUNT' || sample.unitGroupCode === 'CUSTOM') {
      continue;
    }
    for (const a of groupUnits) {
      for (const b of groupUnits) {
        if (a.id === b.id) continue;
        add(
          a.id,
          b.id,
          unitFactor(a).div(unitFactor(b)),
          `${a.symbol}→${b.symbol}`,
        );
      }
    }
  }

  if (opts.product) {
    const baseId = opts.product.baseUnitId;
    for (const pu of opts.product.productUnits) {
      if (pu.effectiveFrom > opts.at) continue;
      if (pu.effectiveTo != null && pu.effectiveTo <= opts.at) continue;
      const factor = d(pu.conversionToBase);
      if (!factor.gt(0)) {
        throw new UnitPricingError('conversion_to_base must be > 0', 'INVALID_CONVERSION');
      }
      const unit = opts.unitsById.get(pu.unitId);
      add(
        pu.unitId,
        baseId,
        factor,
        unit ? `${unit.symbol}→base` : 'product_unit',
      );
    }
    for (const e of opts.product.conversionEdges ?? []) {
      add(e.fromUnitId, e.toUnitId, d(e.factor), 'product_edge');
    }
  }

  for (const e of opts.extraEdges ?? []) {
    add(e.fromUnitId, e.toUnitId, d(e.factor), 'edge');
  }

  return graph;
}

function bfsConvert(
  quantity: Prisma.Decimal,
  fromId: string,
  toId: string,
  graph: Map<string, GraphHop[]>,
): { qty: Prisma.Decimal; path: string[] } | null {
  if (fromId === toId) return { qty: quantity, path: [fromId] };

  type Node = { id: string; qty: Prisma.Decimal; path: string[]; hops: number };
  const queue: Node[] = [{ id: fromId, qty: quantity, path: [fromId], hops: 0 }];
  const visited = new Set<string>([fromId]);

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.hops >= MAX_HOPS) continue;
    for (const hop of graph.get(cur.id) ?? []) {
      if (visited.has(hop.to)) continue;
      const nextQty = cur.qty.mul(hop.factor);
      if (!nextQty.isFinite() || nextQty.abs().gt(MAX_ABS)) {
        throw new UnitPricingError(
          'Conversion overflow',
          'OVERFLOW',
        );
      }
      const nextPath = [...cur.path, hop.to];
      if (hop.to === toId) {
        return { qty: nextQty, path: nextPath };
      }
      visited.add(hop.to);
      queue.push({
        id: hop.to,
        qty: nextQty,
        path: nextPath,
        hops: cur.hops + 1,
      });
    }
  }
  return null;
}

function detectCycle(graph: Map<string, GraphHop[]>): string | null {
  const state = new Map<string, 0 | 1 | 2>();
  const dfs = (id: string, stack: string[]): string | null => {
    state.set(id, 1);
    for (const hop of graph.get(id) ?? []) {
      if (hop.label.endsWith('⁻¹')) continue;
      const st = state.get(hop.to) ?? 0;
      if (st === 1 && stack.includes(hop.to)) {
        return [...stack, hop.to].join(' → ');
      }
      if (st === 0) {
        const c = dfs(hop.to, [...stack, hop.to]);
        if (c) return c;
      }
    }
    state.set(id, 2);
    return null;
  };
  for (const id of graph.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const c = dfs(id, [id]);
      if (c) return c;
    }
  }
  return null;
}

export function convertQuantity(opts: {
  quantity: DecimalValue;
  fromUnit: UnitRef;
  toUnit: UnitRef;
  product?: ProductPricingRef;
  unitsById?: Map<string, UnitRef>;
  extraEdges?: ConversionEdge[];
  at?: Date;
  settings?: TenantQtyMoneySettings;
  /** When true (default for sale entry), validate precision/step. */
  validate?: boolean;
}): Prisma.Decimal {
  const quantity = d(opts.quantity);
  assertFiniteQty(quantity);
  if (quantity.lt(0)) {
    throw new UnitPricingError('Quantity must be a non-negative number', 'INVALID_QTY');
  }

  if (opts.validate !== false && quantity.gt(0) && opts.product) {
    validateEnteredQuantity({
      quantity,
      unit: opts.fromUnit,
      product: opts.product,
      at: opts.at,
    });
  }

  if (opts.fromUnit.id === opts.toUnit.id) {
    return quantity;
  }

  const unitsById = opts.unitsById ?? new Map([
    [opts.fromUnit.id, opts.fromUnit],
    [opts.toUnit.id, opts.toUnit],
  ]);
  const at = opts.at ?? new Date();
  const graph = buildGraph({
    product: opts.product,
    unitsById,
    extraEdges: opts.extraEdges,
    at,
  });

  const found = bfsConvert(quantity, opts.fromUnit.id, opts.toUnit.id, graph);
  if (found) {
    return found.qty;
  }

  if (
    opts.fromUnit.unitGroupId === opts.toUnit.unitGroupId &&
    opts.fromUnit.unitGroupCode !== 'COUNT' &&
    opts.fromUnit.unitGroupCode !== 'CUSTOM'
  ) {
    return sameGroupConvert(quantity, opts.fromUnit, opts.toUnit);
  }

  throw new UnitPricingError(
    `Incompatible units: cannot convert ${opts.fromUnit.symbol} (${opts.fromUnit.unitGroupCode}) to ${opts.toUnit.symbol} (${opts.toUnit.unitGroupCode})`,
    'INCOMPATIBLE_UNITS',
  );
}

export function convertQuantityDetailed(opts: {
  quantity: DecimalValue;
  fromUnit: UnitRef;
  toUnit: UnitRef;
  product?: ProductPricingRef;
  unitsById?: Map<string, UnitRef>;
  extraEdges?: ConversionEdge[];
  at?: Date;
  validate?: boolean;
}): { qty: Prisma.Decimal; path: string[]; factor: Prisma.Decimal } {
  const qty = convertQuantity(opts);
  const entered = d(opts.quantity);
  const factor = entered.gt(0)
    ? qty.div(entered)
    : new Decimal(1);
  const unitsById = opts.unitsById ?? new Map([
    [opts.fromUnit.id, opts.fromUnit],
    [opts.toUnit.id, opts.toUnit],
  ]);
  const graph = buildGraph({
    product: opts.product,
    unitsById,
    extraEdges: opts.extraEdges,
    at: opts.at ?? new Date(),
  });
  const found = bfsConvert(entered, opts.fromUnit.id, opts.toUnit.id, graph);
  return {
    qty,
    path: found?.path ?? [opts.fromUnit.id, opts.toUnit.id],
    factor,
  };
}

function catalogUnitPrice(
  product: ProductPricingRef,
  sellingUnit: UnitRef,
  at: Date,
): { unitPrice: Prisma.Decimal; source: PriceSource } | null {
  const pu = activeProductUnit(product, sellingUnit.id, at);
  if (pu?.fixedPrice != null) {
    const p = d(pu.fixedPrice);
    if (p.gte(0)) return { unitPrice: p, source: 'unit_fixed' };
  }
  return null;
}

/**
 * Price one transaction line. Inventory impact is +baseQuantity (caller signs).
 */
export function calculateLineAmount(opts: {
  product: ProductPricingRef;
  enteredQty: DecimalValue;
  sellingUnit: UnitRef;
  unitsById: Map<string, UnitRef>;
  at?: Date;
  settings?: TenantQtyMoneySettings;
  extraEdges?: ConversionEdge[];
  unitPriceOverride?: DecimalValue | null;
  lineDiscount?: LineDiscountInput | null;
  taxProfile?: TaxProfile | null;
  taxRate?: number | null;
  validate?: boolean;
  /** +1 purchase/receive, −1 sale (default). */
  inventorySign?: 1 | -1;
}): LineCalcResult {
  const { product, sellingUnit, unitsById } = opts;
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const at = opts.at ?? new Date();
  const enteredQty = d(opts.enteredQty);

  if (opts.validate !== false) {
    validateEnteredQuantity({
      quantity: enteredQty,
      unit: sellingUnit,
      product,
      at,
    });
  } else if (!enteredQty.gt(0)) {
    throw new UnitPricingError('Entered quantity must be greater than 0', 'QTY_NOT_POSITIVE');
  }

  if (sellingUnit.isActive === false) {
    throw new UnitPricingError(
      `Unit ${sellingUnit.symbol} is not enabled`,
      'UNIT_DISABLED',
    );
  }

  const baseUnit = unitsById.get(product.baseUnitId);
  if (!baseUnit) throw new UnitPricingError('Product base unit is missing', 'NO_BASE_UNIT');

  const converted = convertQuantityDetailed({
    quantity: enteredQty,
    fromUnit: sellingUnit,
    toUnit: baseUnit,
    product,
    unitsById,
    extraEdges: opts.extraEdges,
    at,
    validate: false,
  });
  const qtyBase = converted.qty.toDecimalPlaces(
    QTY_INTERNAL_PLACES,
    Decimal.ROUND_HALF_UP,
  );

  const conversionFactor = enteredQty.gt(0)
    ? qtyBase.div(enteredQty)
    : new Decimal(1);

  let unitPrice: Prisma.Decimal;
  let priceSource: PriceSource;
  let priceUnit = sellingUnit;

  if (opts.unitPriceOverride != null && d(opts.unitPriceOverride).gte(0)) {
    unitPrice = d(opts.unitPriceOverride);
    priceSource = 'override';
  } else {
    const specific = catalogUnitPrice(product, sellingUnit, at);
    if (specific) {
      unitPrice = specific.unitPrice;
      priceSource = specific.source;
    } else if (product.pricingStrategy === 'FIXED_TIER') {
      throw new UnitPricingError(
        `Fixed-tier product requires fixed_price on selling unit ${sellingUnit.symbol}`,
        'MISSING_FIXED_PRICE',
      );
    } else {
      const price =
        product.pricePerPricingUnit != null
          ? d(product.pricePerPricingUnit)
          : product.basePrice != null
            ? d(product.basePrice)
            : null;
      if (price == null || !price.gte(0)) {
        throw new UnitPricingError(
          'Converted pricing requires price_per_pricing_unit ≥ 0',
          'MISSING_PRICE',
        );
      }
      const pricingUnitId = product.pricingUnitId ?? product.baseUnitId;
      const pricingUnit = unitsById.get(pricingUnitId);
      if (!pricingUnit) throw new UnitPricingError('Pricing unit is missing', 'NO_PRICING_UNIT');
      const pricingQty = convertQuantity({
        quantity: qtyBase,
        fromUnit: baseUnit,
        toUnit: pricingUnit,
        product,
        unitsById,
        extraEdges: opts.extraEdges,
        at,
        validate: false,
      });
      const grossFromBase = pricingQty.mul(price);
      unitPrice = enteredQty.gt(0)
        ? grossFromBase.div(enteredQty)
        : price;
      priceSource = 'converted';
      priceUnit = pricingUnit;
    }
  }

  const grossRaw = unitPrice.mul(enteredQty);
  let discountAmount = new Decimal(0);
  if (opts.lineDiscount) {
    const v = d(opts.lineDiscount.value);
    if (opts.lineDiscount.type === 'percent') {
      if (v.lt(0) || v.gt(100)) {
        throw new UnitPricingError('Percent discount must be 0–100', 'DISCOUNT');
      }
      discountAmount = grossRaw.mul(v).div(100);
    } else {
      if (v.lt(0) || v.gt(grossRaw)) {
        throw new UnitPricingError('Fixed discount cannot exceed line gross', 'DISCOUNT');
      }
      discountAmount = v;
    }
  }

  const netAfterDisc = grossRaw.sub(discountAmount).lt(0)
    ? new Decimal(0)
    : grossRaw.sub(discountAmount);
  const places = moneyPlaces(settings);
  const mode = roundingOf(settings);

  let lineTotal: Prisma.Decimal;
  let taxAmount: Prisma.Decimal;
  if (opts.taxProfile) {
    const taxed = computeLineTax(opts.taxProfile, {
      lineGross: netAfterDisc,
      ...(opts.taxRate != null ? { rate: opts.taxRate } : {}),
    });
    lineTotal = taxed.lineTotal;
    taxAmount = taxed.taxAmount;
  } else {
    lineTotal = roundMoney(netAfterDisc, places, mode);
    taxAmount = new Decimal(0);
  }

  const discountRounded = roundMoney(discountAmount, places, mode);
  const grossRounded = roundMoney(grossRaw, places, mode);
  const finalAmount = opts.taxProfile?.inclusive
    ? roundMoney(netAfterDisc, places, mode)
    : lineTotal.add(taxAmount);

  const sign = opts.inventorySign ?? -1;
  const warnings: string[] = [];
  const cycle = detectCycle(
    buildGraph({
      product,
      unitsById,
      extraEdges: opts.extraEdges,
      at,
    }),
  );
  if (cycle) {
    warnings.push(`Conversion graph contains a cycle (${cycle}); shortest path was used`);
  }

  const unitPriceRounded = roundMoney(unitPrice, Math.max(places, 4), mode);

  return {
    orderedQuantity: enteredQty,
    orderedUnitId: sellingUnit.id,
    orderedUnitSymbol: sellingUnit.symbol,
    baseQuantity: qtyBase,
    baseUnitId: baseUnit.id,
    baseUnitSymbol: baseUnit.symbol,
    conversionFactor: conversionFactor.toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
    conversionPath: converted.path,
    unitPrice: unitPriceRounded,
    priceUnitId: priceUnit.id,
    priceUnitSymbol: priceUnit.symbol,
    priceSource,
    grossAmount: grossRounded,
    discountAmount: discountRounded,
    taxableAmount: lineTotal,
    taxAmount,
    lineTotal,
    finalAmount,
    inventoryImpact: qtyBase.mul(sign),
    validationWarnings: warnings,
    qtyBase,
    amount: grossRounded,
    conversionFactorUsed: conversionFactor.toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
    enteredUnitId: sellingUnit.id,
    enteredQty,
  };
}

export function serializeLineCalc(line: LineCalcResult): Record<string, unknown> {
  return {
    orderedQuantity: line.orderedQuantity.toFixed(),
    orderedUnitId: line.orderedUnitId,
    orderedUnit: line.orderedUnitSymbol,
    orderedUnitSymbol: line.orderedUnitSymbol,
    baseQuantity: line.baseQuantity.toFixed(),
    baseUnitId: line.baseUnitId,
    baseUnit: line.baseUnitSymbol,
    baseUnitSymbol: line.baseUnitSymbol,
    conversionFactor: line.conversionFactor.toFixed(),
    conversionPath: line.conversionPath,
    unitPrice: line.unitPrice.toFixed(),
    priceUnit: line.priceUnitSymbol,
    priceUnitId: line.priceUnitId,
    priceSource: line.priceSource,
    grossAmount: line.grossAmount.toFixed(),
    discountAmount: line.discountAmount.toFixed(),
    taxableAmount: line.taxableAmount.toFixed(),
    taxAmount: line.taxAmount.toFixed(),
    lineTotal: line.lineTotal.toFixed(),
    finalAmount: line.finalAmount.toFixed(),
    inventoryImpact: line.inventoryImpact.toFixed(),
    validationWarnings: line.validationWarnings,
    qtyBase: Number(line.qtyBase.toFixed()),
    amount: Number(line.amount.toFixed(2)),
    conversionFactorUsed: Number(line.conversionFactorUsed.toFixed(8)),
    enteredUnitId: line.enteredUnitId,
    enteredQty: Number(line.enteredQty.toFixed()),
  };
}

/** Historical return: scale original base qty by returned ordered qty. */
export function reverseHistoricalBaseQty(opts: {
  originalOrderedQty: DecimalValue;
  originalBaseQty: DecimalValue;
  returnOrderedQty: DecimalValue;
}): Prisma.Decimal {
  const ordered = d(opts.originalOrderedQty);
  const base = d(opts.originalBaseQty);
  const ret = d(opts.returnOrderedQty);
  if (!ordered.gt(0)) {
    throw new UnitPricingError('Original ordered quantity is invalid', 'RETURN');
  }
  if (ret.lte(0)) {
    throw new UnitPricingError('Return quantity must be greater than 0', 'RETURN');
  }
  if (ret.gt(ordered)) {
    throw new UnitPricingError(
      `Cannot return ${ret.toString()} (sold ${ordered.toString()})`,
      'RETURN',
    );
  }
  return base.mul(ret).div(ordered);
}
