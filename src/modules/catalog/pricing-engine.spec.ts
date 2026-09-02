import { TaxMode } from '@prisma/client';
import {
  calculateLineAmount,
  convertQuantity,
  d,
  reverseHistoricalBaseQty,
  UnitPricingError,
  type ConversionEdge,
  type ProductPricingRef,
  type UnitRef,
} from './pricing-engine';
import type { TaxProfile } from '../../common/tax-engine';

const G_WEIGHT = 'g-weight';
const G_VOLUME = 'g-volume';
const G_LENGTH = 'g-length';
const G_COUNT = 'g-count';
const G_TIME = 'g-time';
const G_AREA = 'g-area';

function u(
  id: string,
  symbol: string,
  groupId: string,
  groupCode: string,
  toBase: number,
): UnitRef {
  return {
    id,
    symbol,
    unitGroupId: groupId,
    unitGroupCode: groupCode,
    conversionToGroupBase: toBase,
  };
}

const units = {
  g: u('u-g', 'g', G_WEIGHT, 'WEIGHT', 1),
  kg: u('u-kg', 'kg', G_WEIGHT, 'WEIGHT', 1000),
  mg: u('u-mg', 'mg', G_WEIGHT, 'WEIGHT', 0.001),
  t: u('u-t', 't', G_WEIGHT, 'WEIGHT', 1_000_000),
  ml: u('u-ml', 'ml', G_VOLUME, 'VOLUME', 1),
  L: u('u-L', 'L', G_VOLUME, 'VOLUME', 1000),
  mm: u('u-mm', 'mm', G_LENGTH, 'LENGTH', 1),
  cm: u('u-cm', 'cm', G_LENGTH, 'LENGTH', 10),
  m: u('u-m', 'm', G_LENGTH, 'LENGTH', 1000),
  m2: u('u-m2', 'm2', G_AREA, 'AREA', 1),
  pcs: u('u-pcs', 'pcs', G_COUNT, 'COUNT', 1),
  pack: u('u-pack', 'pack', G_COUNT, 'COUNT', 1),
  box: u('u-box', 'box', G_COUNT, 'COUNT', 1),
  carton: u('u-carton', 'carton', G_COUNT, 'COUNT', 1),
  bag: u('u-bag', 'bag', G_COUNT, 'COUNT', 1),
  min: u('u-min', 'min', G_TIME, 'TIME', 1),
  hour: u('u-hour', 'hour', G_TIME, 'TIME', 60),
  day: u('u-day', 'day', G_TIME, 'TIME', 1440),
};

const byId = new Map(Object.values(units).map((x) => [x.id, x]));
const now = new Date('2026-01-01T00:00:00Z');

function q(n: string | number) {
  return d(n).toFixed();
}

const taxEx: TaxProfile = {
  taxMode: TaxMode.simple,
  taxId: null,
  rate: 0.05,
  inclusive: false,
  receiptFooter: '',
};
const taxIn: TaxProfile = { ...taxEx, inclusive: true };

describe('pricing-engine §6 (compat)', () => {
  it('1. Rice 500 g @ ₹100/kg → ₹50, −0.5 kg', () => {
    const product: ProductPricingRef = {
      id: 'rice',
      baseUnitId: units.kg.id,
      pricingUnitId: units.kg.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 100,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 500,
      sellingUnit: units.g,
      unitsById: byId,
      at: now,
    });
    expect(q(line.qtyBase)).toBe('0.5');
    expect(q(line.amount)).toBe('50');
  });

  it('2. Milk 250 ml @ ₹60/L → ₹15, −0.25 L', () => {
    const product: ProductPricingRef = {
      id: 'milk',
      baseUnitId: units.L.id,
      pricingUnitId: units.L.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 60,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 250,
      sellingUnit: units.ml,
      unitsById: byId,
      at: now,
    });
    expect(q(line.qtyBase)).toBe('0.25');
    expect(q(line.amount)).toBe('15');
  });

  it('3. Cloth 1.5 m @ ₹200/m → ₹300', () => {
    const product: ProductPricingRef = {
      id: 'cloth',
      baseUnitId: units.m.id,
      pricingUnitId: units.m.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 200,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 1.5,
      sellingUnit: units.m,
      unitsById: byId,
      at: now,
    });
    expect(q(line.qtyBase)).toBe('1.5');
    expect(q(line.amount)).toBe('300');
  });

  it('4. Service 30 min @ ₹500/hour → ₹250', () => {
    const product: ProductPricingRef = {
      id: 'svc',
      baseUnitId: units.min.id,
      pricingUnitId: units.hour.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 500,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 30,
      sellingUnit: units.min,
      unitsById: byId,
      at: now,
    });
    expect(q(line.qtyBase)).toBe('30');
    expect(q(line.amount)).toBe('250');
  });

  it('5. Coke 3 pcs @ ₹40 fixed → ₹120, −3 pcs', () => {
    const product: ProductPricingRef = {
      id: 'coke',
      baseUnitId: units.pcs.id,
      pricingUnitId: null,
      pricingStrategy: 'FIXED_TIER',
      pricePerPricingUnit: null,
      productUnits: [
        {
          unitId: units.pcs.id,
          conversionToBase: 1,
          fixedPrice: 40,
          effectiveFrom: now,
          effectiveTo: null,
        },
      ],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 3,
      sellingUnit: units.pcs,
      unitsById: byId,
      at: now,
    });
    expect(q(line.qtyBase)).toBe('3');
    expect(q(line.amount)).toBe('120');
  });

  it('6. Water 1 box (=24 pcs) @ ₹240/box → ₹240, −24 pcs', () => {
    const product: ProductPricingRef = {
      id: 'water',
      baseUnitId: units.pcs.id,
      pricingUnitId: null,
      pricingStrategy: 'FIXED_TIER',
      pricePerPricingUnit: null,
      productUnits: [
        {
          unitId: units.box.id,
          conversionToBase: 24,
          fixedPrice: 240,
          effectiveFrom: now,
          effectiveTo: null,
        },
        {
          unitId: units.pcs.id,
          conversionToBase: 1,
          fixedPrice: 10,
          effectiveFrom: now,
          effectiveTo: null,
        },
      ],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 1,
      sellingUnit: units.box,
      unitsById: byId,
      at: now,
    });
    expect(q(line.qtyBase)).toBe('24');
    expect(q(line.amount)).toBe('240');
  });

  it('7. Water 6 pcs @ ₹10/pcs fixed → ₹60, −6 pcs', () => {
    const product: ProductPricingRef = {
      id: 'water',
      baseUnitId: units.pcs.id,
      pricingUnitId: null,
      pricingStrategy: 'FIXED_TIER',
      pricePerPricingUnit: null,
      productUnits: [
        {
          unitId: units.box.id,
          conversionToBase: 24,
          fixedPrice: 240,
          effectiveFrom: now,
          effectiveTo: null,
        },
        {
          unitId: units.pcs.id,
          conversionToBase: 1,
          fixedPrice: 10,
          effectiveFrom: now,
          effectiveTo: null,
        },
      ],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 6,
      sellingUnit: units.pcs,
      unitsById: byId,
      at: now,
    });
    expect(q(line.qtyBase)).toBe('6');
    expect(q(line.amount)).toBe('60');
  });

  it('8. GRN 10 bag × 25 kg/bag → +250 kg (qty base)', () => {
    const product: ProductPricingRef = {
      id: 'rice-grn',
      baseUnitId: units.kg.id,
      pricingUnitId: units.kg.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 100,
      productUnits: [
        {
          unitId: units.bag.id,
          conversionToBase: 25,
          fixedPrice: null,
          effectiveFrom: now,
          effectiveTo: null,
        },
      ],
    };
    const qtyBase = convertQuantity({
      quantity: 10,
      fromUnit: units.bag,
      toUnit: units.kg,
      product,
      unitsById: byId,
      at: now,
      validate: false,
    });
    expect(q(qtyBase)).toBe('250');
  });

  it('9. Reject kg → litre', () => {
    expect(() =>
      convertQuantity({
        quantity: 1,
        fromUnit: units.kg,
        toUnit: units.L,
      }),
    ).toThrow(/Incompatible units/);
  });
});

describe('universal calculation engine matrix', () => {
  const cokeConverted: ProductPricingRef = {
    id: 'coke',
    baseUnitId: units.pcs.id,
    pricingUnitId: units.pcs.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: 30,
    productUnits: [
      {
        unitId: units.box.id,
        conversionToBase: 24,
        fixedPrice: null,
        effectiveFrom: now,
        effectiveTo: null,
        allowFraction: false,
      },
      {
        unitId: units.pcs.id,
        conversionToBase: 1,
        fixedPrice: null,
        effectiveFrom: now,
        effectiveTo: null,
        allowFraction: false,
      },
    ],
  };

  it('A. Piece: sell 3 of 10 → inventory −3', () => {
    const line = calculateLineAmount({
      product: cokeConverted,
      enteredQty: 3,
      sellingUnit: units.pcs,
      unitsById: byId,
      at: now,
    });
    expect(q(line.baseQuantity)).toBe('3');
    expect(q(line.inventoryImpact)).toBe('-3');
  });

  it('B. Box 5 × 24 = 120 pcs', () => {
    const qty = convertQuantity({
      quantity: 5,
      fromUnit: units.box,
      toUnit: units.pcs,
      product: cokeConverted,
      unitsById: byId,
      at: now,
      validate: false,
    });
    expect(q(qty)).toBe('120');
  });

  it('C. Box sale 2 BOX → −48 PCS, piece price when no box price', () => {
    const line = calculateLineAmount({
      product: cokeConverted,
      enteredQty: 2,
      sellingUnit: units.box,
      unitsById: byId,
      at: now,
    });
    expect(q(line.orderedQuantity)).toBe('2');
    expect(line.orderedUnitSymbol).toBe('box');
    expect(q(line.baseQuantity)).toBe('48');
    expect(q(line.amount)).toBe('1440');
    expect(q(line.inventoryImpact)).toBe('-48');
  });

  it('D. Weight: 750 G of rice @ ₹60/kg = ₹45, −0.750 KG', () => {
    const rice: ProductPricingRef = {
      id: 'rice',
      baseUnitId: units.kg.id,
      pricingUnitId: units.kg.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 60,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product: rice,
      enteredQty: 750,
      sellingUnit: units.g,
      unitsById: byId,
      at: now,
    });
    expect(q(line.baseQuantity)).toBe('0.75');
    expect(q(line.amount)).toBe('45');
    expect(line.orderedQuantity.eq(750)).toBe(true);
  });

  it('E. Liquid: 750 ML of 50 L @ ₹150/L → −0.750 L, ₹112.50', () => {
    const oil: ProductPricingRef = {
      id: 'oil',
      baseUnitId: units.L.id,
      pricingUnitId: units.L.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 150,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product: oil,
      enteredQty: 750,
      sellingUnit: units.ml,
      unitsById: byId,
      at: now,
    });
    expect(q(line.baseQuantity)).toBe('0.75');
    expect(q(line.amount)).toBe('112.5');
  });

  it('F. Length: 2.75 M @ ₹200 → ₹550, −2.75 M', () => {
    const fabric: ProductPricingRef = {
      id: 'fabric',
      baseUnitId: units.m.id,
      pricingUnitId: units.m.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 200,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product: fabric,
      enteredQty: '2.75',
      sellingUnit: units.m,
      unitsById: byId,
      at: now,
    });
    expect(q(line.baseQuantity)).toBe('2.75');
    expect(q(line.amount)).toBe('550');
  });

  it('G. Multi-level carton → box → pack → pcs = 1440', () => {
    const edges: ConversionEdge[] = [
      { fromUnitId: units.carton.id, toUnitId: units.box.id, factor: 20 },
      { fromUnitId: units.box.id, toUnitId: units.pack.id, factor: 12 },
      { fromUnitId: units.pack.id, toUnitId: units.pcs.id, factor: 6 },
    ];
    const product: ProductPricingRef = {
      id: 'multi',
      baseUnitId: units.pcs.id,
      pricingUnitId: units.pcs.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 1,
      productUnits: [
        {
          unitId: units.pcs.id,
          conversionToBase: 1,
          fixedPrice: null,
          effectiveFrom: now,
          effectiveTo: null,
          allowFraction: false,
        },
      ],
      conversionEdges: edges,
    };
    const qty = convertQuantity({
      quantity: 1,
      fromUnit: units.carton,
      toUnit: units.pcs,
      product,
      unitsById: byId,
      extraEdges: edges,
      at: now,
      validate: false,
    });
    expect(q(qty)).toBe('1440');
    const two = calculateLineAmount({
      product,
      enteredQty: 2,
      sellingUnit: units.carton,
      unitsById: byId,
      extraEdges: edges,
      at: now,
      validate: false,
    });
    expect(q(two.baseQuantity)).toBe('2880');
  });

  it('H. Unit-specific BOX price is used instead of piece × 24', () => {
    const product: ProductPricingRef = {
      ...cokeConverted,
      productUnits: [
        {
          unitId: units.box.id,
          conversionToBase: 24,
          fixedPrice: 680,
          effectiveFrom: now,
          effectiveTo: null,
          allowFraction: false,
        },
        {
          unitId: units.pcs.id,
          conversionToBase: 1,
          fixedPrice: 30,
          effectiveFrom: now,
          effectiveTo: null,
          allowFraction: false,
        },
      ],
    };
    const box = calculateLineAmount({
      product,
      enteredQty: 2,
      sellingUnit: units.box,
      unitsById: byId,
      at: now,
    });
    expect(q(box.amount)).toBe('1360');
    expect(box.priceSource).toBe('unit_fixed');
    expect(q(box.baseQuantity)).toBe('48');
    const pcs = calculateLineAmount({
      product,
      enteredQty: 2,
      sellingUnit: units.pcs,
      unitsById: byId,
      at: now,
    });
    expect(q(pcs.amount)).toBe('60');
  });

  it('I. 0.5 PCS rejected when COUNT requires integer', () => {
    expect(() =>
      calculateLineAmount({
        product: cokeConverted,
        enteredQty: 0.5,
        sellingUnit: units.pcs,
        unitsById: byId,
        at: now,
      }),
    ).toThrow(UnitPricingError);
  });

  it('J. 1.275 KG accepted', () => {
    const potato: ProductPricingRef = {
      id: 'potato',
      baseUnitId: units.kg.id,
      pricingUnitId: units.kg.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 40,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product: potato,
      enteredQty: '1.275',
      sellingUnit: units.kg,
      unitsById: byId,
      at: now,
    });
    expect(q(line.baseQuantity)).toBe('1.275');
    expect(q(line.amount)).toBe('51');
  });

  it('K. Service 1.5 HOURS × hourly price', () => {
    const product: ProductPricingRef = {
      id: 'consult',
      baseUnitId: units.hour.id,
      pricingUnitId: units.hour.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 1000,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: '1.5',
      sellingUnit: units.hour,
      unitsById: byId,
      at: now,
    });
    expect(q(line.amount)).toBe('1500');
    expect(q(line.baseQuantity)).toBe('1.5');
  });

  it('L. Rental 3 DAYS × daily price', () => {
    const product: ProductPricingRef = {
      id: 'vehicle',
      baseUnitId: units.day.id,
      pricingUnitId: units.day.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 2500,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 3,
      sellingUnit: units.day,
      unitsById: byId,
      at: now,
    });
    expect(q(line.amount)).toBe('7500');
    expect(q(line.baseQuantity)).toBe('3');
  });

  it('M. Combo parent qty 2 — component consume = 2 × BOM (engine, not combo-specific kg)', () => {
    const component: ProductPricingRef = {
      id: 'coke-comp',
      baseUnitId: units.pcs.id,
      pricingUnitId: units.pcs.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 30,
      productUnits: cokeConverted.productUnits,
    };
    const perCombo = convertQuantity({
      quantity: 1,
      fromUnit: units.pcs,
      toUnit: units.pcs,
      product: component,
      unitsById: byId,
      at: now,
      validate: false,
    });
    expect(q(perCombo.mul(2))).toBe('2');
  });

  it('N. Recipe 250 G ingredient consumes 0.250 KG', () => {
    const rice: ProductPricingRef = {
      id: 'rice-ing',
      baseUnitId: units.kg.id,
      pricingUnitId: units.kg.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 60,
      productUnits: [],
    };
    const qty = convertQuantity({
      quantity: 250,
      fromUnit: units.g,
      toUnit: units.kg,
      product: rice,
      unitsById: byId,
      at: now,
      validate: false,
    });
    expect(q(qty)).toBe('0.25');
  });

  it('O. Return reverses exact historical base qty', () => {
    const back = reverseHistoricalBaseQty({
      originalOrderedQty: 2,
      originalBaseQty: 48,
      returnOrderedQty: 1,
    });
    expect(q(back)).toBe('24');
  });

  it('T. Historical conversion: old sale stays 24 pcs/box after config changes to 20', () => {
    const then = new Date('2025-01-01T00:00:00Z');
    const later = new Date('2026-06-01T00:00:00Z');
    const product: ProductPricingRef = {
      id: 'hist',
      baseUnitId: units.pcs.id,
      pricingUnitId: units.pcs.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 10,
      productUnits: [
        {
          unitId: units.box.id,
          conversionToBase: 24,
          fixedPrice: null,
          effectiveFrom: then,
          effectiveTo: later,
          allowFraction: false,
        },
        {
          unitId: units.box.id,
          conversionToBase: 20,
          fixedPrice: null,
          effectiveFrom: later,
          effectiveTo: null,
          allowFraction: false,
        },
        {
          unitId: units.pcs.id,
          conversionToBase: 1,
          fixedPrice: null,
          effectiveFrom: then,
          effectiveTo: null,
          allowFraction: false,
        },
      ],
    };
    const oldSale = calculateLineAmount({
      product,
      enteredQty: 1,
      sellingUnit: units.box,
      unitsById: byId,
      at: new Date('2025-06-01T00:00:00Z'),
    });
    expect(q(oldSale.baseQuantity)).toBe('24');
    const newSale = calculateLineAmount({
      product,
      enteredQty: 1,
      sellingUnit: units.box,
      unitsById: byId,
      at: new Date('2026-08-01T00:00:00Z'),
    });
    expect(q(newSale.baseQuantity)).toBe('20');
  });

  it('W. Decimal precision: 0.1 + 0.2 style money is exact via Decimal strings', () => {
    const product: ProductPricingRef = {
      id: 'dec',
      baseUnitId: units.kg.id,
      pricingUnitId: units.kg.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: '0.1',
      productUnits: [],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: '0.2',
      sellingUnit: units.kg,
      unitsById: byId,
      at: now,
    });
    expect(line.amount.eq('0.02')).toBe(true);
  });

  it('X. Tax-exclusive: 100 net + 5% = tax 5, final 105', () => {
    const product: ProductPricingRef = {
      id: 'tax-ex',
      baseUnitId: units.pcs.id,
      pricingUnitId: units.pcs.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 100,
      productUnits: [
        {
          unitId: units.pcs.id,
          conversionToBase: 1,
          fixedPrice: null,
          effectiveFrom: now,
          effectiveTo: null,
          allowFraction: false,
        },
      ],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 1,
      sellingUnit: units.pcs,
      unitsById: byId,
      at: now,
      taxProfile: taxEx,
    });
    expect(q(line.lineTotal)).toBe('100');
    expect(q(line.taxAmount)).toBe('5');
    expect(q(line.finalAmount)).toBe('105');
  });

  it('Y. Tax-inclusive: 105 gross @ 5% → net 100, tax 5', () => {
    const product: ProductPricingRef = {
      id: 'tax-in',
      baseUnitId: units.pcs.id,
      pricingUnitId: units.pcs.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 105,
      productUnits: [
        {
          unitId: units.pcs.id,
          conversionToBase: 1,
          fixedPrice: null,
          effectiveFrom: now,
          effectiveTo: null,
          allowFraction: false,
        },
      ],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 1,
      sellingUnit: units.pcs,
      unitsById: byId,
      at: now,
      taxProfile: taxIn,
    });
    expect(q(line.lineTotal)).toBe('100');
    expect(q(line.taxAmount)).toBe('5');
    expect(q(line.finalAmount)).toBe('105');
  });

  it('Z. Discount + unit conversion + tax', () => {
    const product: ProductPricingRef = {
      id: 'disc',
      baseUnitId: units.pcs.id,
      pricingUnitId: units.pcs.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 30,
      productUnits: [
        {
          unitId: units.box.id,
          conversionToBase: 24,
          fixedPrice: 700,
          effectiveFrom: now,
          effectiveTo: null,
          allowFraction: false,
        },
      ],
    };
    const line = calculateLineAmount({
      product,
      enteredQty: 1,
      sellingUnit: units.box,
      unitsById: byId,
      at: now,
      lineDiscount: { type: 'percent', value: 10 },
      taxProfile: taxEx,
    });
    expect(q(line.grossAmount)).toBe('700');
    expect(q(line.discountAmount)).toBe('70');
    expect(q(line.lineTotal)).toBe('630');
    expect(q(line.taxAmount)).toBe('31.5');
    expect(q(line.baseQuantity)).toBe('24');
  });

  it('does not silently round 1.275 kg', () => {
    const potato: ProductPricingRef = {
      id: 'p',
      baseUnitId: units.kg.id,
      pricingUnitId: units.kg.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 40,
      productUnits: [],
    };
    const line = calculateLineAmount({
      product: potato,
      enteredQty: '1.275',
      sellingUnit: units.kg,
      unitsById: byId,
      at: now,
    });
    expect(line.baseQuantity.toFixed()).toBe('1.275');
  });

  it('never assumes a global box factor without product mapping', () => {
    const product: ProductPricingRef = {
      id: 'orphan-box',
      baseUnitId: units.pcs.id,
      pricingUnitId: units.pcs.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 10,
      productUnits: [],
    };
    expect(() =>
      convertQuantity({
        quantity: 1,
        fromUnit: units.box,
        toUnit: units.pcs,
        product,
        unitsById: byId,
        at: now,
        validate: false,
      }),
    ).toThrow(/Incompatible units/);
  });
});
