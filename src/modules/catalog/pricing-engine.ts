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
  isBaseUnit?: boolean;
  name?: string;
  decimals?: number;
  isActive?: boolean;
};

export type ProductUnitRef = {
  unitId: string;
  conversionToBase: DecimalValue;
  fixedPrice: DecimalValue | null;
  sellPrice?: DecimalValue | null;
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

export type ProductDiscountRule = {
  type: 'percent' | 'percentage' | 'fixed' | 'fixed_amount' | 'fixed_line';
  value: DecimalValue;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  effectiveFrom?: Date | string | null;
  effectiveTo?: Date | string | null;
  minQuantity?: DecimalValue | null;
  maxQuantity?: DecimalValue | null;
  customerTiers?: string[];
  customerTags?: string[];
  customerIds?: string[];
  customerEligibility?:
    | 'all'
    | {
        customerIds?: string[];
        customerTags?: string[];
        customerTiers?: string[];
      };
};

export type CustomerContext = {
  id?: string | null;
  tags?: string[] | null;
  tier?: string | null;
};

export type ProductPricingRef = {
  id: string;
  name?: string;
  sku?: string;
  baseUnitId?: string;
  pricingUnitId?: string | null;
  pricingStrategy?: 'CONVERTED' | 'FIXED_TIER';
  pricePerPricingUnit?: DecimalValue | null;
  /** Catalog selling price in the pricing/base unit (fallback). */
  basePrice?: DecimalValue | null;
  /** Maximum Retail Price / list price (per base/pricing unit). */
  mrp?: DecimalValue | null;
  configuredPriceQuantity?: DecimalValue | null;
  productDiscount?: ProductDiscountRule | null;
  meta?: Record<string, unknown> | null;
  productUnits?: ProductUnitRef[];
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

export type PriceSource =
  | 'unit_fixed'
  | 'converted'
  | 'override'
  | 'discounted'
  | 'product_unit';

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

  // ─── Flipkart-Style Explicit Separation ───
  /** List price / Maximum Retail Price per selling unit */
  mrp: Prisma.Decimal;
  /** Total MRP for the line: MRP × quantity */
  grossMrp: Prisma.Decimal;
  /** Selling price per unit after product discount: MRP − productDiscountPerUnit */
  sellingPrice: Prisma.Decimal;
  /** Product discount per unit: MRP − sellingPrice */
  productDiscountPerUnit: Prisma.Decimal;
  /** Total product discount for the line: (MRP − sellingPrice) × quantity (or capped) */
  productDiscount: Prisma.Decimal;
  /** Percentage discount off MRP (e.g. 5 for 5% OFF) */
  productDiscountPercent: number;
  /** Net line value before bill/coupon discount: grossMrp − productDiscount */
  productNet: Prisma.Decimal;
  /** True when product discount is active */
  hasProductDiscount: boolean;

  priceQuantity: Prisma.Decimal;
  configuredPriceQuantity: Prisma.Decimal;
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
  return (product.productUnits ?? []).find(
    (pu) =>
      pu.unitId === unitId &&
      pu.effectiveFrom <= at &&
      (pu.effectiveTo == null || pu.effectiveTo > at),
  );
}

export function catalogUnitPrice(
  product: ProductPricingRef,
  sellingUnit: UnitRef,
  at: Date,
): { unitPrice: Prisma.Decimal; source: PriceSource } | null {
  const pu = activeProductUnit(product, sellingUnit.id, at);
  if (!pu) return null;
  if (pu.fixedPrice != null) {
    const f = d(pu.fixedPrice);
    if (!f.gte(0)) {
      throw new UnitPricingError('fixed_price must be ≥ 0', 'INVALID_PRICE');
    }
    return { unitPrice: f, source: 'unit_fixed' };
  }
  if (pu.sellPrice != null) {
    const s = d(pu.sellPrice);
    if (!s.gte(0)) {
      throw new UnitPricingError('sell_price must be ≥ 0', 'INVALID_PRICE');
    }
    return { unitPrice: s, source: 'product_unit' };
  }
  return null;
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
  const unitFactorVal = opts.unit.conversionToGroupBase != null ? d(opts.unit.conversionToGroupBase) : new Decimal(1);
  const isCompositeCount = group === 'COUNT' && unitFactorVal.gt(1);
  const unitExplicitFraction =
    (opts.unit as Record<string, unknown>).allowFractionalQuantity ??
    (opts.unit as Record<string, unknown>).decimalQty;

  const productAllowFraction =
    (opts.product as Record<string, unknown> | undefined)?.allowFractionalQuantity ??
    (opts.product?.meta as Record<string, unknown> | undefined)?.allowFractionalQuantity ??
    (opts.product?.meta as Record<string, unknown> | undefined)?.allowFraction;

  let allowFraction: boolean;
  if (pu?.allowFraction != null) {
    allowFraction = pu.allowFraction;
  } else if (typeof productAllowFraction === 'boolean') {
    allowFraction = productAllowFraction;
  } else if (typeof unitExplicitFraction === 'boolean') {
    allowFraction = unitExplicitFraction;
  } else if (group !== 'COUNT') {
    // Physical continuous dimensions (WEIGHT, VOLUME, LENGTH, AREA, TIME) default to fractional
    allowFraction = true;
  } else if (opts.unit.decimals !== undefined && opts.unit.decimals > 0) {
    allowFraction = true;
  } else if (isCompositeCount) {
    // Splittable composite count units (e.g. factor > 1) allow fractional parts
    allowFraction = true;
  } else {
    // Base atomic discrete count units default to whole numbers unless configured
    allowFraction = false;
  }

  const precision =
    pu?.quantityPrecision ??
    (allowFraction
      ? opts.unit.decimals !== undefined && opts.unit.decimals > 0
        ? opts.unit.decimals
        : group === 'TIME'
          ? 4
          : 6
      : 0);
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

  if (opts.product && opts.product.productUnits && opts.product.baseUnitId) {
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

  const isCountGroup =
    opts.fromUnit.unitGroupCode === 'COUNT' &&
    opts.toUnit.unitGroupCode === 'COUNT';

  const fromFactor = opts.fromUnit.conversionToGroupBase != null ? d(opts.fromUnit.conversionToGroupBase) : new Decimal(1);
  const toFactor = opts.toUnit.conversionToGroupBase != null ? d(opts.toUnit.conversionToGroupBase) : new Decimal(1);
  const hasFixedCountRatio =
    isCountGroup &&
    (fromFactor.gt(1) || toFactor.gt(1) || (opts.fromUnit.isBaseUnit && opts.toUnit.isBaseUnit));

  if (
    opts.fromUnit.unitGroupId === opts.toUnit.unitGroupId &&
    opts.fromUnit.unitGroupCode !== 'CUSTOM' &&
    (opts.fromUnit.unitGroupCode !== 'COUNT' || hasFixedCountRatio)
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

export function isProductDiscountEligible(
  rule: ProductDiscountRule,
  qty: Prisma.Decimal,
  at: Date,
  customer?: CustomerContext | null,
): boolean {
  const fromDate = rule.startDate ?? rule.effectiveFrom;
  if (fromDate) {
    const from = new Date(fromDate);
    if (!Number.isNaN(from.getTime()) && at < from) return false;
  }
  const toDate = rule.endDate ?? rule.effectiveTo;
  if (toDate) {
    const to = new Date(toDate);
    if (!Number.isNaN(to.getTime()) && at > to) return false;
  }
  if (rule.minQuantity != null) {
    const min = d(rule.minQuantity);
    if (min.gt(0) && qty.lt(min)) return false;
  }

  const customerTiers =
    rule.customerTiers ??
    (typeof rule.customerEligibility === 'object'
      ? rule.customerEligibility?.customerTiers
      : undefined);
  const customerTags =
    rule.customerTags ??
    (typeof rule.customerEligibility === 'object'
      ? rule.customerEligibility?.customerTags
      : undefined);
  const customerIds =
    rule.customerIds ??
    (typeof rule.customerEligibility === 'object'
      ? rule.customerEligibility?.customerIds
      : undefined);

  const hasSpecificCustomerRules =
    (customerTiers && customerTiers.length > 0) ||
    (customerTags && customerTags.length > 0) ||
    (customerIds && customerIds.length > 0) ||
    (rule.customerEligibility != null && rule.customerEligibility !== 'all');

  if (hasSpecificCustomerRules) {
    if (!customer?.id && !customer?.tags?.length && !customer?.tier) {
      return false;
    }
    let matches = false;
    if (
      customerIds?.length &&
      customer?.id &&
      customerIds.includes(customer.id)
    ) {
      matches = true;
    }
    if (
      customerTags?.length &&
      customer?.tags?.some((t) => customerTags.includes(t))
    ) {
      matches = true;
    }
    if (
      customerTiers?.length &&
      customer?.tier &&
      customerTiers.includes(customer.tier)
    ) {
      matches = true;
    }
    if (!matches) return false;
  }
  return true;
}

/**
 * Price one transaction line. Inventory impact is +baseQuantity (caller signs).
 */
export function calculateLineAmount(opts: {
  product: ProductPricingRef;
  enteredQty: DecimalValue;
  sellingUnit?: UnitRef;
  unitsById?: Map<string, UnitRef>;
  at?: Date;
  settings?: TenantQtyMoneySettings;
  extraEdges?: ConversionEdge[];
  unitPriceOverride?: DecimalValue | null;
  lineDiscount?: LineDiscountInput | null;
  customer?: CustomerContext | null;
  taxProfile?: TaxProfile | null;
  taxRate?: number | null;
  validate?: boolean;
  /** +1 purchase/receive, −1 sale (default). */
  inventorySign?: 1 | -1;
}): LineCalcResult {
  const defaultUnit: UnitRef = {
    id: 'u-pcs',
    symbol: 'pcs',
    name: 'Pieces',
    unitGroupId: 'ug-count',
    unitGroupCode: 'COUNT',
    conversionToGroupBase: 1,
    decimals: 0,
    isActive: true,
  };
  const sellingUnit = opts.sellingUnit ?? defaultUnit;
  const unitsById =
    opts.unitsById ??
    new Map<string, UnitRef>([[sellingUnit.id, sellingUnit]]);
  const { product } = opts;
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

  const rawBaseUnit = product.baseUnitId ? unitsById.get(product.baseUnitId) : undefined;
  const hasUnitConversions = Boolean(
    (product.productUnits && product.productUnits.length > 0) ||
      (opts.extraEdges && opts.extraEdges.length > 0),
  );
  const baseUnit =
    rawBaseUnit &&
    (rawBaseUnit.unitGroupId === sellingUnit.unitGroupId || hasUnitConversions)
      ? rawBaseUnit
      : sellingUnit;

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
  let priceUnit = sellingUnit;

  let baselineUnitPrice: Prisma.Decimal;
  let priceSource: LineCalcResult['priceSource'] = 'converted';

  if (opts.unitPriceOverride != null) {
    const o = d(opts.unitPriceOverride);
    if (!o.gte(0)) {
      throw new UnitPricingError('unit_price_override must be ≥ 0', 'INVALID_OVERRIDE');
    }
    baselineUnitPrice = o;
    priceSource = 'override';
  } else {
    const specific = catalogUnitPrice(product, sellingUnit, at);
    if (specific) {
      baselineUnitPrice = specific.unitPrice;
      priceSource = specific.source;
    } else if (product.pricingStrategy === 'FIXED_TIER') {
      throw new UnitPricingError(
        `Fixed-tier product requires fixed_price on selling unit ${sellingUnit.symbol}`,
        'MISSING_FIXED_PRICE',
      );
    } else {
      const rawPrice = product.pricePerPricingUnit ?? product.basePrice;
      if (rawPrice == null || !d(rawPrice).gte(0)) {
        throw new UnitPricingError(
          'Converted pricing requires price_per_pricing_unit ≥ 0',
          'MISSING_PRICE',
        );
      }
      const price = d(rawPrice);
      const rawPricingUnit = product.pricingUnitId ? unitsById.get(product.pricingUnitId) : undefined;
      const pricingUnit =
        rawPricingUnit &&
        (rawPricingUnit.unitGroupId === baseUnit.unitGroupId || hasUnitConversions)
          ? rawPricingUnit
          : baseUnit;
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
      const configuredPriceQty =
        product.configuredPriceQuantity != null && d(product.configuredPriceQuantity).gt(0)
          ? d(product.configuredPriceQuantity)
          : new Decimal(1);

      baselineUnitPrice = enteredQty.gt(0)
        ? pricingQty.div(configuredPriceQty).mul(price).div(enteredQty)
        : price.div(configuredPriceQty);
      priceSource = 'converted';
      priceUnit = pricingUnit;
    }
  }

  // ─── 1. Determine MRP per Selling Unit ───
  let mrpPerSellingUnit: Prisma.Decimal;
  const configuredPriceQty =
    product.configuredPriceQuantity != null && d(product.configuredPriceQuantity).gt(0)
      ? d(product.configuredPriceQuantity)
      : new Decimal(1);

  if (product.mrp != null && d(product.mrp).gt(0)) {
    const baseMrp = d(product.mrp);
    if (sellingUnit.id === (product.baseUnitId || sellingUnit.id) && configuredPriceQty.eq(1)) {
      mrpPerSellingUnit = baseMrp;
    } else {
      const rawPricingUnit = product.pricingUnitId ? unitsById.get(product.pricingUnitId) : undefined;
      const pricingUnit =
        rawPricingUnit &&
        (rawPricingUnit.unitGroupId === baseUnit.unitGroupId || hasUnitConversions)
          ? rawPricingUnit
          : baseUnit;
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
      mrpPerSellingUnit = enteredQty.gt(0)
        ? pricingQty.div(configuredPriceQty).mul(baseMrp).div(enteredQty)
        : baseMrp.div(configuredPriceQty);
    }
  } else if (opts.unitPriceOverride != null) {
    mrpPerSellingUnit = baselineUnitPrice;
  } else {
    mrpPerSellingUnit = baselineUnitPrice;
  }

  // Ensure MRP is at least baselineUnitPrice if basePrice was explicitly lower
  if (mrpPerSellingUnit.lt(baselineUnitPrice)) {
    mrpPerSellingUnit = baselineUnitPrice;
  }

  // ─── 2. Evaluate Product / SKU Discount ───
  let productDiscountPerUnit = new Decimal(0);
  let sellingPricePerUnit = baselineUnitPrice;
  let productDiscountPercent = 0;
  let hasProductDiscount = false;
  let lineProductDiscount = new Decimal(0);
  let lineProductNet = new Decimal(0);

  // Check discount rule configured on product or metadata
  const metaDiscountRule =
    product.productDiscount ??
    ((product.meta as Record<string, unknown> | null)?.productDiscount as ProductDiscountRule | undefined) ??
    ((product.meta as Record<string, unknown> | null)?.discountRule as ProductDiscountRule | undefined);

  if (opts.lineDiscount) {
    // Explicit line discount passed into call
    const v = d(opts.lineDiscount.value);
    if (opts.lineDiscount.type === 'percent' || (opts.lineDiscount.type as string) === 'percentage') {
      if (v.lt(0) || v.gt(100)) {
        throw new UnitPricingError('Percent discount must be 0–100', 'DISCOUNT');
      }
      productDiscountPercent = v.toNumber();
      productDiscountPerUnit = mrpPerSellingUnit.mul(v).div(100);
      sellingPricePerUnit = Decimal.max(new Decimal(0), mrpPerSellingUnit.sub(productDiscountPerUnit));
      lineProductDiscount = mrpPerSellingUnit.mul(enteredQty).mul(v).div(100);
      lineProductNet = mrpPerSellingUnit.mul(enteredQty).sub(lineProductDiscount);
      hasProductDiscount = v.gt(0);
      priceSource = 'discounted';
    } else {
      const gross = mrpPerSellingUnit.mul(enteredQty);
      if (v.lt(0) || v.gt(gross)) {
        throw new UnitPricingError('Fixed discount cannot exceed line gross', 'DISCOUNT');
      }
      lineProductDiscount = v;
      lineProductNet = gross.sub(lineProductDiscount);
      productDiscountPerUnit = enteredQty.gt(0) ? v.div(enteredQty) : v;
      sellingPricePerUnit = Decimal.max(new Decimal(0), mrpPerSellingUnit.sub(productDiscountPerUnit));
      productDiscountPercent = mrpPerSellingUnit.gt(0)
        ? productDiscountPerUnit.div(mrpPerSellingUnit).mul(100).toNumber()
        : 0;
      hasProductDiscount = v.gt(0);
      priceSource = 'discounted';
    }
  } else if (metaDiscountRule && isProductDiscountEligible(metaDiscountRule, enteredQty, at, opts.customer)) {
    // Product rule active
    const ruleVal = d(metaDiscountRule.value);
    const maxQty = metaDiscountRule.maxQuantity != null ? d(metaDiscountRule.maxQuantity) : null;
    const discountedQty = maxQty != null && maxQty.gt(0)
      ? Decimal.min(enteredQty, maxQty)
      : enteredQty;
    const regularQty = Decimal.max(new Decimal(0), enteredQty.sub(discountedQty));
    const isPercent =
      metaDiscountRule.type === 'percent' ||
      (metaDiscountRule.type as string) === 'percentage';

    if (isPercent) {
      if (ruleVal.lt(0) || ruleVal.gt(100)) {
        throw new UnitPricingError('Percent discount must be 0–100', 'DISCOUNT');
      }
      productDiscountPercent = ruleVal.toNumber();
      const discPerUnit = mrpPerSellingUnit.mul(ruleVal).div(100);
      const discountedUnitSell = Decimal.max(new Decimal(0), mrpPerSellingUnit.sub(discPerUnit));
      lineProductDiscount = discPerUnit.mul(discountedQty);
      lineProductNet = discountedUnitSell.mul(discountedQty).add(mrpPerSellingUnit.mul(regularQty));
      productDiscountPerUnit = enteredQty.gt(0) ? lineProductDiscount.div(enteredQty) : discPerUnit;
      sellingPricePerUnit = enteredQty.gt(0) ? lineProductNet.div(enteredQty) : discountedUnitSell;
      hasProductDiscount = ruleVal.gt(0);
      priceSource = 'discounted';
    } else {
      const discPerUnit = Decimal.min(mrpPerSellingUnit, ruleVal);
      const discountedUnitSell = Decimal.max(new Decimal(0), mrpPerSellingUnit.sub(discPerUnit));
      lineProductDiscount = discPerUnit.mul(discountedQty);
      lineProductNet = discountedUnitSell.mul(discountedQty).add(mrpPerSellingUnit.mul(regularQty));
      productDiscountPerUnit = enteredQty.gt(0) ? lineProductDiscount.div(enteredQty) : discPerUnit;
      sellingPricePerUnit = enteredQty.gt(0) ? lineProductNet.div(enteredQty) : discountedUnitSell;
      productDiscountPercent = mrpPerSellingUnit.gt(0)
        ? productDiscountPerUnit.div(mrpPerSellingUnit).mul(100).toNumber()
        : 0;
      hasProductDiscount = ruleVal.gt(0);
      priceSource = 'discounted';
    }
  } else if (mrpPerSellingUnit.gt(baselineUnitPrice) && opts.unitPriceOverride == null) {
    // Implicit product discount: MRP > Selling Rate
    productDiscountPerUnit = mrpPerSellingUnit.sub(baselineUnitPrice);
    sellingPricePerUnit = baselineUnitPrice;
    lineProductDiscount = productDiscountPerUnit.mul(enteredQty);
    lineProductNet = sellingPricePerUnit.mul(enteredQty);
    productDiscountPercent = mrpPerSellingUnit.gt(0)
      ? productDiscountPerUnit.div(mrpPerSellingUnit).mul(100).toNumber()
      : 0;
    hasProductDiscount = lineProductDiscount.gt(0);
  } else {
    // No product discount
    sellingPricePerUnit = baselineUnitPrice;
    lineProductDiscount = new Decimal(0);
    lineProductNet = sellingPricePerUnit.mul(enteredQty);
    productDiscountPerUnit = new Decimal(0);
    productDiscountPercent = 0;
    hasProductDiscount = false;
  }

  // ─── 3. Flipkart Formula Invariants ───
  // grossMrp = MRP × quantity
  // productDiscount = (MRP − sellingPrice) × quantity
  // productNet = grossMrp − productDiscount
  // NEVER apply the same product discount again after productNet.
  const grossMrp = mrpPerSellingUnit.mul(enteredQty);

  const places = moneyPlaces(settings);
  const mode = roundingOf(settings);

  let lineTotal: Prisma.Decimal;
  let taxAmount: Prisma.Decimal;
  if (opts.taxProfile) {
    const taxed = computeLineTax(opts.taxProfile, {
      lineGross: lineProductNet,
      inclusive: opts.taxProfile.inclusive,
      ...(opts.taxRate != null ? { rate: opts.taxRate } : {}),
    });
    lineTotal = taxed.lineTotal;
    taxAmount = taxed.taxAmount;
  } else {
    lineTotal = roundMoney(lineProductNet, places, mode);
    taxAmount = new Decimal(0);
  }

  const finalAmount = opts.taxProfile?.inclusive
    ? roundMoney(lineProductNet, places, mode)
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

  const mrpRounded = roundMoney(mrpPerSellingUnit, Math.max(places, 4), mode);
  const grossMrpRounded = roundMoney(grossMrp, places, mode);
  const sellingPriceRounded = roundMoney(sellingPricePerUnit, Math.max(places, 4), mode);
  const productDiscountPerUnitRounded = roundMoney(productDiscountPerUnit, Math.max(places, 4), mode);
  const productDiscountRounded = roundMoney(lineProductDiscount, places, mode);
  const productNetRounded = roundMoney(lineProductNet, places, mode);

  const rawPricingUnitForRes = product.pricingUnitId ? unitsById.get(product.pricingUnitId) : undefined;
  const pricingUnitForRes =
    rawPricingUnitForRes &&
    (rawPricingUnitForRes.unitGroupId === baseUnit.unitGroupId || hasUnitConversions)
      ? rawPricingUnitForRes
      : baseUnit;
  const priceQtyEquiv = convertQuantity({
    quantity: qtyBase,
    fromUnit: baseUnit,
    toUnit: pricingUnitForRes,
    product,
    unitsById,
    extraEdges: opts.extraEdges,
    at,
    validate: false,
  });

  return {
    orderedQuantity: enteredQty,
    orderedUnitId: sellingUnit.id,
    orderedUnitSymbol: sellingUnit.symbol,
    baseQuantity: qtyBase,
    baseUnitId: baseUnit.id,
    baseUnitSymbol: baseUnit.symbol,
    conversionFactor: conversionFactor.toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
    conversionPath: converted.path,
    unitPrice: sellingPriceRounded,
    priceUnitId: priceUnit.id,
    priceUnitSymbol: priceUnit.symbol,
    priceSource,
    grossAmount: grossMrpRounded,
    discountAmount: productDiscountRounded,
    taxableAmount: lineTotal,
    taxAmount,
    lineTotal,
    finalAmount,
    inventoryImpact: qtyBase.mul(sign),
    validationWarnings: warnings,

    // Flipkart Explicit Fields
    mrp: mrpRounded,
    grossMrp: grossMrpRounded,
    sellingPrice: sellingPriceRounded,
    productDiscountPerUnit: productDiscountPerUnitRounded,
    productDiscount: productDiscountRounded,
    productDiscountPercent: Math.round(productDiscountPercent * 100) / 100,
    productNet: productNetRounded,
    hasProductDiscount,

    priceQuantity: priceQtyEquiv,
    configuredPriceQuantity: configuredPriceQty,

    qtyBase,
    amount: grossMrpRounded,
    conversionFactorUsed: conversionFactor.toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
    enteredUnitId: sellingUnit.id,
    enteredQty,
  };
}

export function serializeLineCalc(line: LineCalcResult): Record<string, unknown> {
  return {
    orderedQuantity: line.orderedQuantity.toString(),
    orderedUnitId: line.orderedUnitId,
    orderedUnit: line.orderedUnitSymbol,
    orderedUnitSymbol: line.orderedUnitSymbol,
    baseQuantity: line.baseQuantity.toString(),
    baseUnitId: line.baseUnitId,
    baseUnit: line.baseUnitSymbol,
    baseUnitSymbol: line.baseUnitSymbol,
    conversionFactor: line.conversionFactor.toString(),
    conversionPath: line.conversionPath,
    unitPrice: line.unitPrice.toString(),
    priceUnit: line.priceUnitSymbol,
    priceUnitId: line.priceUnitId,
    priceSource: line.priceSource,
    grossAmount: line.grossAmount.toFixed(2),
    discountAmount: line.discountAmount.toFixed(2),
    taxableAmount: line.taxableAmount.toFixed(2),
    taxAmount: line.taxAmount.toFixed(2),
    lineTotal: line.lineTotal.toFixed(2),
    finalAmount: line.finalAmount.toFixed(2),
    inventoryImpact: line.inventoryImpact.toString(),
    validationWarnings: line.validationWarnings,
    mrp: line.mrp.toFixed(2),
    grossMrp: line.grossMrp.toFixed(2),
    sellingPrice: line.sellingPrice.toFixed(2),
    productDiscountPerUnit: line.productDiscountPerUnit.toFixed(2),
    productDiscount: line.productDiscount.toFixed(2),
    productDiscountPercent: line.productDiscountPercent,
    productNet: line.productNet.toFixed(2),
    hasProductDiscount: line.hasProductDiscount,
    priceQuantity: line.priceQuantity ? line.priceQuantity.toString() : line.baseQuantity.toString(),
    configuredPriceQuantity: line.configuredPriceQuantity ? line.configuredPriceQuantity.toString() : '1',
    qtyBase: line.qtyBase.toNumber(),
    amount: Number(line.amount.toFixed(2)),
    conversionFactorUsed: Number(line.conversionFactorUsed.toFixed(8)),
    enteredUnitId: line.enteredUnitId,
    enteredQty: line.enteredQty.toNumber(),
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
