/**
 * UOM engine safety tests — legacy fallback + purchase conversion.
 * Complements pricing-engine.spec.ts (rice kg/g, box/piece, etc.).
 */
import { convertQuantity, d, type UnitRef } from './pricing-engine';

const now = new Date('2026-01-01T00:00:00Z');
const WEIGHT_GRP = '00000000-0000-4000-8000-000000000001';
const COUNT_GRP = '00000000-0000-4000-8000-000000000002';

function unit(
  id: string,
  symbol: string,
  groupCode: string,
  groupId: string,
  factor: number,
): UnitRef {
  return {
    id,
    symbol,
    unitGroupId: groupId,
    unitGroupCode: groupCode,
    conversionToGroupBase: d(factor),
    isActive: true,
  };
}

describe('UOM country-weight conversions (USA lb/oz)', () => {
  const g = unit('g', 'g', 'WEIGHT', WEIGHT_GRP, 1);
  const oz = unit('oz', 'oz', 'WEIGHT', WEIGHT_GRP, 28.349523125);
  const lb = unit('lb', 'lb', 'WEIGHT', WEIGHT_GRP, 453.59237);
  const byId = new Map([g, oz, lb].map((u) => [u.id, u]));

  it('1 lb = 16 oz in group base (grams)', () => {
    const ozFromLb = convertQuantity({
      quantity: 1,
      fromUnit: lb,
      toUnit: oz,
      unitsById: byId,
    });
    expect(Number(ozFromLb.toFixed(4))).toBeCloseTo(16, 3);
  });

  it('2 lb converts to oz base qty', () => {
    const baseG = convertQuantity({
      quantity: 2,
      fromUnit: lb,
      toUnit: g,
      unitsById: byId,
    });
    expect(Number(baseG.toFixed(2))).toBeCloseTo(907.18, 1);
  });
});

describe('purchase unit → base (box/piece)', () => {
  const pcs = unit('pcs', 'pcs', 'COUNT', COUNT_GRP, 1);
  const box = unit('box', 'box', 'COUNT', COUNT_GRP, 1);

  it('product-specific 1 box = 24 pcs', () => {
    const qtyBase = convertQuantity({
      quantity: 5,
      fromUnit: box,
      toUnit: pcs,
      product: {
        id: 'p1',
        baseUnitId: pcs.id,
        pricingUnitId: pcs.id,
        pricingStrategy: 'CONVERTED',
        pricePerPricingUnit: 10,
        productUnits: [
          {
            unitId: box.id,
            conversionToBase: 24,
            fixedPrice: null,
            effectiveFrom: now,
            effectiveTo: null,
          },
        ],
      },
      unitsById: new Map([
        [pcs.id, pcs],
        [box.id, box],
      ]),
    });
    expect(qtyBase.toFixed()).toBe('120');
  });

  it('legacy path: no product ref blocks cross-category conversion', () => {
    const kg = unit('kg', 'kg', 'WEIGHT', WEIGHT_GRP, 1000);
    const L = unit('L', 'L', 'VOLUME', '00000000-0000-4000-8000-000000000003', 1000);
    expect(() =>
      convertQuantity({
        quantity: 1,
        fromUnit: kg,
        toUnit: L,
        unitsById: new Map([
          [kg.id, kg],
          [L.id, L],
        ]),
      }),
    ).toThrow(/Incompatible units/);
  });
});
