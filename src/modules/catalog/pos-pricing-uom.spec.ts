import { Decimal } from '@prisma/client/runtime/library';
import {
  calculateLineAmount,
  convertQuantity,
  d,
  roundMoney,
  type ProductPricingRef,
  type UnitRef,
} from './pricing-engine';
import { buildTaxProfile, computeLineTax } from '../../common/tax-engine';

describe('POS Cart, Pricing Calculation & UOM Conversion Engine', () => {
  const WEIGHT_GROUP_ID = 'grp-weight';
  const VOLUME_GROUP_ID = 'grp-volume';
  const COUNT_GROUP_ID = 'grp-count';

  const unitKg: UnitRef = {
    id: 'u-kg',
    symbol: 'kg',
    unitGroupId: WEIGHT_GROUP_ID,
    unitGroupCode: 'WEIGHT',
    conversionToGroupBase: '1000', // 1 kg = 1000 g
    isActive: true,
  };

  const unitG: UnitRef = {
    id: 'u-g',
    symbol: 'g',
    unitGroupId: WEIGHT_GROUP_ID,
    unitGroupCode: 'WEIGHT',
    conversionToGroupBase: '1', // base is g
    isActive: true,
  };

  const unitL: UnitRef = {
    id: 'u-L',
    symbol: 'L',
    unitGroupId: VOLUME_GROUP_ID,
    unitGroupCode: 'VOLUME',
    conversionToGroupBase: '1000', // 1 L = 1000 ml
    isActive: true,
  };

  const unitMl: UnitRef = {
    id: 'u-ml',
    symbol: 'ml',
    unitGroupId: VOLUME_GROUP_ID,
    unitGroupCode: 'VOLUME',
    conversionToGroupBase: '1', // base is ml
    isActive: true,
  };

  const unitPcs: UnitRef = {
    id: 'u-pcs',
    symbol: 'pcs',
    unitGroupId: COUNT_GROUP_ID,
    unitGroupCode: 'COUNT',
    conversionToGroupBase: '1',
    isActive: true,
  };

  const unitsById = new Map<string, UnitRef>([
    [unitKg.id, unitKg],
    [unitG.id, unitG],
    [unitL.id, unitL],
    [unitMl.id, unitMl],
    [unitPcs.id, unitPcs],
  ]);

  const tomatoProduct: ProductPricingRef = {
    id: 'prod-tomato',
    baseUnitId: unitKg.id,
    pricingUnitId: unitKg.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '45.00', // ₹45 per kg
    basePrice: '45.00',
    productUnits: [
      {
        unitId: unitKg.id,
        conversionToBase: '1',
        fixedPrice: null,
        effectiveFrom: new Date('2020-01-01'),
        effectiveTo: null,
        isDefaultSellingUnit: true,
      },
      {
        unitId: unitG.id,
        conversionToBase: '0.001', // 1 g = 0.001 kg
        fixedPrice: null,
        effectiveFrom: new Date('2020-01-01'),
        effectiveTo: null,
      },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const milkProduct: ProductPricingRef = {
    id: 'prod-milk',
    baseUnitId: unitL.id,
    pricingUnitId: unitL.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '60.00', // ₹60 per L
    basePrice: '60.00',
    productUnits: [
      {
        unitId: unitL.id,
        conversionToBase: '1',
        fixedPrice: null,
        effectiveFrom: new Date('2020-01-01'),
        effectiveTo: null,
      },
      {
        unitId: unitMl.id,
        conversionToBase: '0.001', // 1 ml = 0.001 L
        fixedPrice: null,
        effectiveFrom: new Date('2020-01-01'),
        effectiveTo: null,
      },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const soapProduct: ProductPricingRef = {
    id: 'prod-soap',
    baseUnitId: unitPcs.id,
    pricingUnitId: unitPcs.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '10.00',
    basePrice: '10.00',
    productUnits: [
      {
        unitId: unitPcs.id,
        conversionToBase: '1',
        fixedPrice: null,
        effectiveFrom: new Date('2020-01-01'),
        effectiveTo: null,
      },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  describe('1. UOM Conversion: 1 kg = 1000 g (Tomatoes @ ₹45/kg)', () => {
    it('calculates gross = ₹22.50 and unitPrice = ₹0.045/g when quantity is 500g', () => {
      const result = calculateLineAmount({
        product: tomatoProduct,
        enteredQty: 500,
        sellingUnit: unitG,
        unitsById,
      });

      // 500g converted to base = 0.5kg
      expect(result.baseQuantity.toNumber()).toBe(0.5);
      // Unit price for 1 gram = 45 / 1000 = 0.045
      expect(result.unitPrice.toNumber()).toBe(0.045);
      // Gross = 500 * 0.045 = ₹22.50 (NEVER 500 * 45 = 22,500)
      expect(result.grossAmount.toNumber()).toBe(22.5);
      expect(result.lineTotal.toNumber()).toBe(22.5);
    });

    it('calculates gross = ₹45.00 when quantity is 1kg', () => {
      const result = calculateLineAmount({
        product: tomatoProduct,
        enteredQty: 1,
        sellingUnit: unitKg,
        unitsById,
      });

      expect(result.baseQuantity.toNumber()).toBe(1);
      expect(result.unitPrice.toNumber()).toBe(45);
      expect(result.grossAmount.toNumber()).toBe(45);
    });
  });

  describe('2. UOM Conversion: 1 L = 1000 ml (Milk @ ₹60/L)', () => {
    it('calculates gross = ₹15.00 and unitPrice = ₹0.06/ml when quantity is 250ml', () => {
      const result = calculateLineAmount({
        product: milkProduct,
        enteredQty: 250,
        sellingUnit: unitMl,
        unitsById,
      });

      // 250ml = 0.25 L
      expect(result.baseQuantity.toNumber()).toBe(0.25);
      expect(result.unitPrice.toNumber()).toBe(0.06);
      // Gross = 250 * 0.06 = ₹15.00
      expect(result.grossAmount.toNumber()).toBe(15);
      expect(result.lineTotal.toNumber()).toBe(15);
    });
  });

  describe('3. Count: Pieces (Soap @ ₹10/pcs)', () => {
    it('calculates gross = ₹30.00 for 3 pcs', () => {
      const result = calculateLineAmount({
        product: soapProduct,
        enteredQty: 3,
        sellingUnit: unitPcs,
        unitsById,
      });

      expect(result.baseQuantity.toNumber()).toBe(3);
      expect(result.unitPrice.toNumber()).toBe(10);
      expect(result.grossAmount.toNumber()).toBe(30);
    });
  });

  describe('4. Strict Calculation Order & Discount Calculation', () => {
    it('Order: Converted Qty → Gross → Discount → Taxable Value → Tax → Round-off → Net Payable', () => {
      // Step 1 & 2: 500g @ ₹45/kg => Gross ₹22.50
      // Step 3: 10% line discount => Discount ₹2.25 => Net ₹20.25
      const lineResult = calculateLineAmount({
        product: tomatoProduct,
        enteredQty: 500,
        sellingUnit: unitG,
        unitsById,
        lineDiscount: { type: 'percent', value: 10 },
      });

      expect(lineResult.grossAmount.toNumber()).toBe(22.5);
      expect(lineResult.discountAmount.toNumber()).toBe(2.25);
      const taxableValue = lineResult.grossAmount.sub(lineResult.discountAmount).toNumber();
      expect(taxableValue).toBe(20.25);

      // Step 4 & 5: Exclusive Tax 5% on ₹20.25 => ₹1.0125 => rounded ₹1.01
      const taxProfile = buildTaxProfile({
        taxMode: 'in_gst' as any,
        settings: { tax: { ratePercent: 5, inclusive: false } },
      });
      const taxed = computeLineTax(taxProfile, { lineGross: taxableValue });
      expect(taxed.taxAmount.toNumber()).toBe(1.01);
      const exactDue = taxableValue + taxed.taxAmount.toNumber(); // 20.25 + 1.01 = 21.26
      expect(exactDue).toBe(21.26);

      // Step 6 & 7: Cash Round-off on ₹21.26 => round-off -0.26 => Net Payable ₹21.00
      const roundedCash = Math.round(exactDue); // 21
      const cashRoundOff = Number((roundedCash - exactDue).toFixed(2)); // -0.26
      expect(roundedCash).toBe(21);
      expect(cashRoundOff).toBe(-0.26);

      // Digital (UPI/Card) Net Payable => Exact ₹21.26
      expect(exactDue).toBe(21.26);
    });
  });

  describe('5. Inclusive GST Calculation', () => {
    it('extracts GST correctly from inclusive price: ₹22.50 @ 5% GST => Taxable ₹21.43, Tax ₹1.07', () => {
      const taxProfile = buildTaxProfile({
        taxMode: 'in_gst' as any,
        settings: { tax: { ratePercent: 5, inclusive: true } },
      });
      const taxed = computeLineTax(taxProfile, { lineGross: 22.5 });

      expect(taxed.lineTotal.toNumber()).toBe(21.43);
      expect(taxed.taxAmount.toNumber()).toBe(1.07);
      expect(taxed.lineTotal.add(taxed.taxAmount).toNumber()).toBe(22.5);
    });
  });
});
