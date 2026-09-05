import { Decimal } from '@prisma/client/runtime/library';
import {
  calculateLineAmount,
  convertQuantity,
  serializeLineCalc,
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

    it('calculates gross = ₹0.28 and unitPrice = ₹0.028/g when quantity is 10g of ₹28/kg item', () => {
      const item28 = {
        ...tomatoProduct,
        id: 'prod-item-28',
        basePrice: 28,
        pricePerPricingUnit: 28,
      };
      const result = calculateLineAmount({
        product: item28,
        enteredQty: 10,
        sellingUnit: unitG,
        unitsById,
      });

      // 10g = 0.01 kg
      expect(result.baseQuantity.toNumber()).toBe(0.01);
      expect(result.unitPrice.toNumber()).toBe(0.028);
      expect(result.grossAmount.toNumber()).toBe(0.28);
      expect(result.lineTotal.toNumber()).toBe(0.28);

      const serialized = serializeLineCalc(result);
      expect(serialized.qtyBase).toBe(0.01);
      expect(serialized.amount).toBe(0.28);
      expect(serialized.unitPrice).toBe('0.028');
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

      // Step 4 & 5: Exclusive Tax 5% on ₹20.25 => CGST 2.5% (₹0.51) + SGST 2.5% (₹0.51) => Total GST ₹1.02
      const taxProfile = buildTaxProfile({
        taxMode: 'in_gst' as any,
        settings: { tax: { ratePercent: 5, inclusive: false } },
      });
      const taxed = computeLineTax(taxProfile, { lineGross: taxableValue });
      expect(taxed.taxAmount.toNumber()).toBe(1.02);
      const exactDue = taxableValue + taxed.taxAmount.toNumber(); // 20.25 + 1.02 = 21.27
      expect(exactDue).toBe(21.27);

      // Step 6 & 7: Cash Round-off on ₹21.27 => round-off -0.27 => Net Payable ₹21.00
      const roundedCash = Math.round(exactDue); // 21
      const cashRoundOff = Number((roundedCash - exactDue).toFixed(2)); // -0.27
      expect(roundedCash).toBe(21);
      expect(cashRoundOff).toBe(-0.27);

      // Digital (UPI/Card) Net Payable => Exact ₹21.27
      expect(exactDue).toBe(21.27);
    });
  });

  describe('5. Stock Validation with UOM Conversions (Gram & Liter Right / Wrong Qty)', () => {
    it('Gram vs Kg: Right quantity (500g against 2kg stock) is allowed with correct price', () => {
      const stockOnHandKg = 2; // 2 kg in inventory
      const enteredQtyGrams = 500; // 500 g requested
      
      const line = calculateLineAmount({
        product: tomatoProduct,
        enteredQty: enteredQtyGrams,
        sellingUnit: unitG,
        unitsById,
      });

      const requiredStockInBase = line.baseQuantity.toNumber(); // 0.5 kg
      expect(requiredStockInBase).toBe(0.5);
      expect(requiredStockInBase <= stockOnHandKg).toBe(true); // Allowed
      expect(line.grossAmount.toNumber()).toBe(22.5); // ₹22.50
    });

    it('Gram vs Kg: Wrong/Excess quantity (2500g against 2kg stock) exceeds available stock', () => {
      const stockOnHandKg = 2; // 2 kg in inventory
      const enteredQtyGrams = 2500; // 2500 g = 2.5 kg requested
      
      const line = calculateLineAmount({
        product: tomatoProduct,
        enteredQty: enteredQtyGrams,
        sellingUnit: unitG,
        unitsById,
      });

      const requiredStockInBase = line.baseQuantity.toNumber(); // 2.5 kg
      expect(requiredStockInBase).toBe(2.5);
      const isStockSufficient = requiredStockInBase <= stockOnHandKg;
      expect(isStockSufficient).toBe(false); // Correctly detected as Insufficient Stock
    });

    it('Liter vs ml: Right quantity (500ml against 1L stock) is allowed with correct price', () => {
      const stockOnHandLitre = 1; // 1 L in inventory
      const enteredQtyMl = 500; // 500 ml requested
      
      const line = calculateLineAmount({
        product: milkProduct,
        enteredQty: enteredQtyMl,
        sellingUnit: unitMl,
        unitsById,
      });

      const requiredStockInBase = line.baseQuantity.toNumber(); // 0.5 L
      expect(requiredStockInBase).toBe(0.5);
      expect(requiredStockInBase <= stockOnHandLitre).toBe(true); // Allowed
      expect(line.grossAmount.toNumber()).toBe(30); // ₹30.00
    });

    it('Liter vs ml: Wrong/Excess quantity (1500ml against 1L stock) exceeds available stock', () => {
      const stockOnHandLitre = 1; // 1 L in inventory
      const enteredQtyMl = 1500; // 1500 ml = 1.5 L requested
      
      const line = calculateLineAmount({
        product: milkProduct,
        enteredQty: enteredQtyMl,
        sellingUnit: unitMl,
        unitsById,
      });

      const requiredStockInBase = line.baseQuantity.toNumber(); // 1.5 L
      expect(requiredStockInBase).toBe(1.5);
      const isStockSufficient = requiredStockInBase <= stockOnHandLitre;
      expect(isStockSufficient).toBe(false); // Correctly detected as Insufficient Stock
    });
  });

  describe('6. Weight Item Selling with Legacy Default Base Unit', () => {
    it('seamlessly sells 1.5 kg when product had default pcs baseUnitId with no multi-unit conversions', () => {
      const kgUnit: UnitRef = {
        id: 'u-kg',
        symbol: 'kg',
        name: 'Kilogram',
        unitGroupId: 'ug-weight',
        unitGroupCode: 'WEIGHT',
        conversionToGroupBase: 1,
        decimals: 3,
        isActive: true,
      };
      const pcsUnit: UnitRef = {
        id: 'u-pcs',
        symbol: 'pcs',
        name: 'Pieces',
        unitGroupId: 'ug-count',
        unitGroupCode: 'COUNT',
        conversionToGroupBase: 1,
        decimals: 0,
        isActive: true,
      };
      const unitsMap = new Map<string, UnitRef>([
        ['u-kg', kgUnit],
        ['u-pcs', pcsUnit],
      ]);

      const result = calculateLineAmount({
        product: {
          id: 'prod-apple',
          baseUnitId: 'u-pcs', // legacy or defaulted
          pricingUnitId: 'u-pcs',
          pricingStrategy: 'CONVERTED',
          pricePerPricingUnit: 120, // ₹120 / kg
          basePrice: 120,
          productUnits: [],
          availableInPos: true,
          canSell: true,
          canPurchase: true,
          isActive: true,
          trackQty: true,
        },
        enteredQty: 1.5,
        sellingUnit: kgUnit,
        unitsById: unitsMap,
      });

      expect(result.enteredQty.toNumber()).toBe(1.5);
      expect(result.baseQuantity.toNumber()).toBe(1.5);
      expect(result.unitPrice.toNumber()).toBe(120);
      expect(result.grossAmount.toNumber()).toBe(180);
      expect(result.productNet.toNumber()).toBe(180);
    });
  });

  describe('7. Dozen & Count Unit Conversion (Bananas @ ₹60/dozen)', () => {
    const dozenUnit: UnitRef = {
      id: 'u-dozen',
      symbol: 'dozen',
      name: 'Dozen',
      unitGroupId: 'ug-count',
      unitGroupCode: 'COUNT',
      conversionToGroupBase: 12,
      decimals: 0,
      isActive: true,
    };
    const pcsUnit: UnitRef = {
      id: 'u-pcs',
      symbol: 'pcs',
      name: 'Piece',
      unitGroupId: 'ug-count',
      unitGroupCode: 'COUNT',
      conversionToGroupBase: 1,
      decimals: 0,
      isActive: true,
    };
    const countUnitsMap = new Map<string, UnitRef>([
      ['u-dozen', dozenUnit],
      ['u-pcs', pcsUnit],
    ]);

    it('calculates gross = ₹600 for 10 dozen bananas when product base is pcs', () => {
      const result = calculateLineAmount({
        product: {
          id: 'prod-banana',
          baseUnitId: 'u-pcs',
          pricingUnitId: 'u-dozen',
          pricingStrategy: 'CONVERTED',
          pricePerPricingUnit: 60, // ₹60 / dozen
          basePrice: 60,
          productUnits: [],
          availableInPos: true,
          canSell: true,
          canPurchase: true,
          isActive: true,
          trackQty: true,
        },
        enteredQty: 10,
        sellingUnit: dozenUnit,
        unitsById: countUnitsMap,
      });

      // 10 dozen = 120 pcs base qty
      expect(result.enteredQty.toNumber()).toBe(10);
      expect(result.baseQuantity.toNumber()).toBe(120);
      expect(result.unitPrice.toNumber()).toBe(60);
      expect(result.grossAmount.toNumber()).toBe(600);
      expect(result.lineTotal.toNumber()).toBe(600);
    });

    it('calculates gross = ₹30 for 6 pcs of bananas (@ ₹60/dozen)', () => {
      const result = calculateLineAmount({
        product: {
          id: 'prod-banana',
          baseUnitId: 'u-pcs',
          pricingUnitId: 'u-dozen',
          pricingStrategy: 'CONVERTED',
          pricePerPricingUnit: 60, // ₹60 / dozen
          basePrice: 60,
          productUnits: [],
          availableInPos: true,
          canSell: true,
          canPurchase: true,
          isActive: true,
          trackQty: true,
        },
        enteredQty: 6,
        sellingUnit: pcsUnit,
        unitsById: countUnitsMap,
      });

      // 6 pcs = 6 pcs base qty
      expect(result.enteredQty.toNumber()).toBe(6);
      expect(result.baseQuantity.toNumber()).toBe(6);
      // Unit price for 1 pcs = 60 / 12 = 5
      expect(result.unitPrice.toNumber()).toBe(5);
      // 6 * 5 = ₹30
      expect(result.grossAmount.toNumber()).toBe(30);
    });

    const banana50: ProductPricingRef = {
      id: 'prod-banana-50',
      baseUnitId: 'u-pcs',
      pricingUnitId: 'u-dozen',
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: 50, // ₹50 / dozen
      basePrice: 50,
      productUnits: [],
      availableInPos: true,
      canSell: true,
      canPurchase: true,
      isActive: true,
      trackQty: true,
    };

    it('allows 0.5 dozen: converts to 6 pieces base qty, ₹25.00 amount (deducts 6 pieces from inventory)', () => {
      const result = calculateLineAmount({
        product: banana50,
        enteredQty: 0.5,
        sellingUnit: dozenUnit,
        unitsById: countUnitsMap,
      });

      // 0.5 dozen = 6 pieces
      expect(result.enteredQty.toNumber()).toBe(0.5);
      expect(result.orderedUnitSymbol).toBe('dozen');
      expect(result.baseQuantity.toNumber()).toBe(6);
      expect(result.baseUnitSymbol).toBe('pcs');
      // 0.5 * 50 = ₹25.00
      expect(result.grossAmount.toNumber()).toBe(25);
      expect(result.lineTotal.toNumber()).toBe(25);
    });

    it('allows 1 dozen: converts to 12 pieces base qty, ₹50.00 amount', () => {
      const result = calculateLineAmount({
        product: banana50,
        enteredQty: 1,
        sellingUnit: dozenUnit,
        unitsById: countUnitsMap,
      });

      expect(result.enteredQty.toNumber()).toBe(1);
      expect(result.baseQuantity.toNumber()).toBe(12);
      expect(result.grossAmount.toNumber()).toBe(50);
    });

    it('allows 1.5 dozen: converts to 18 pieces base qty, ₹75.00 amount', () => {
      const result = calculateLineAmount({
        product: banana50,
        enteredQty: 1.5,
        sellingUnit: dozenUnit,
        unitsById: countUnitsMap,
      });

      expect(result.enteredQty.toNumber()).toBe(1.5);
      expect(result.baseQuantity.toNumber()).toBe(18);
      expect(result.grossAmount.toNumber()).toBe(75);
    });

    it('allows 2.5 dozen: converts to 30 pieces base qty, ₹125.00 amount', () => {
      const result = calculateLineAmount({
        product: banana50,
        enteredQty: 2.5,
        sellingUnit: dozenUnit,
        unitsById: countUnitsMap,
      });

      expect(result.enteredQty.toNumber()).toBe(2.5);
      expect(result.baseQuantity.toNumber()).toBe(30);
      expect(result.grossAmount.toNumber()).toBe(125);
    });

    it('rejects fractional quantity for indivisible piece product (e.g. 1.5 pcs without allowFractionalQuantity)', () => {
      const soapPiece: ProductPricingRef = {
        id: 'prod-soap-pcs',
        baseUnitId: 'u-pcs',
        pricingUnitId: 'u-pcs',
        pricingStrategy: 'CONVERTED',
        pricePerPricingUnit: 20,
        basePrice: 20,
        productUnits: [],
        availableInPos: true,
        canSell: true,
        canPurchase: true,
        isActive: true,
        trackQty: true,
      };

      expect(() =>
        calculateLineAmount({
          product: soapPiece,
          enteredQty: 1.5,
          sellingUnit: pcsUnit,
          unitsById: countUnitsMap,
        }),
      ).toThrow(/Quantity for pcs must be a whole number/i);
    });
  });

  describe('8. Broken Wheat Multi-UOM Scale (₹65/kg, Stock 80 kg)', () => {
    const brokenWheat: ProductPricingRef = {
      id: 'prod-broken-wheat',
      baseUnitId: unitKg.id,
      pricingUnitId: unitKg.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: '65.00',
      basePrice: '65.00',
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
          conversionToBase: '0.001',
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

    it('5 g: 0.005 kg base qty, ₹0.33 display gross, stock 80 kg → 79.995 kg (NEVER 5 × 65 = ₹325)', () => {
      let currentStock = 80; // 80 kg opening stock
      const result = calculateLineAmount({
        product: brokenWheat,
        enteredQty: 5,
        sellingUnit: unitG,
        unitsById,
      });

      // 5 g = 0.005 kg
      expect(result.baseQuantity.toNumber()).toBe(0.005);
      expect(result.orderedQuantity.toNumber()).toBe(5);
      expect(result.orderedUnitSymbol).toBe('g');
      expect(result.baseUnitSymbol).toBe('kg');
      expect(result.priceUnitSymbol).toBe('kg');
      // 0.005 * 65 = 0.325 => rounded to 0.33
      expect(result.grossAmount.toNumber()).toBe(0.33);
      expect(result.lineTotal.toNumber()).toBe(0.33);

      // Inventory deduction 1: 80 - 0.005 = 79.995 kg
      currentStock = currentStock - result.baseQuantity.toNumber();
      expect(currentStock).toBe(79.995);

      // Sequential Inventory deduction 2: Customer buys 500 g -> 79.995 - 0.500 = 79.495 kg
      const result2 = calculateLineAmount({
        product: brokenWheat,
        enteredQty: 500,
        sellingUnit: unitG,
        unitsById,
      });
      expect(result2.baseQuantity.toNumber()).toBe(0.5);
      currentStock = currentStock - result2.baseQuantity.toNumber();
      expect(currentStock).toBe(79.495);
    });

    it('100 g: 0.1 kg base qty → ₹6.50', () => {
      const result = calculateLineAmount({
        product: brokenWheat,
        enteredQty: 100,
        sellingUnit: unitG,
        unitsById,
      });
      expect(result.baseQuantity.toNumber()).toBe(0.1);
      expect(result.grossAmount.toNumber()).toBe(6.5);
    });

    it('250 g: 0.25 kg base qty → ₹16.25', () => {
      const result = calculateLineAmount({
        product: brokenWheat,
        enteredQty: 250,
        sellingUnit: unitG,
        unitsById,
      });
      expect(result.baseQuantity.toNumber()).toBe(0.25);
      expect(result.grossAmount.toNumber()).toBe(16.25);
    });

    it('500 g: 0.5 kg base qty → ₹32.50', () => {
      const result = calculateLineAmount({
        product: brokenWheat,
        enteredQty: 500,
        sellingUnit: unitG,
        unitsById,
      });
      expect(result.baseQuantity.toNumber()).toBe(0.5);
      expect(result.grossAmount.toNumber()).toBe(32.5);
    });

    it('1 kg: 1 kg base qty → ₹65.00', () => {
      const result = calculateLineAmount({
        product: brokenWheat,
        enteredQty: 1,
        sellingUnit: unitKg,
        unitsById,
      });
      expect(result.baseQuantity.toNumber()).toBe(1);
      expect(result.grossAmount.toNumber()).toBe(65);
    });

    it('2 kg: 2 kg base qty → ₹130.00', () => {
      const result = calculateLineAmount({
        product: brokenWheat,
        enteredQty: 2,
        sellingUnit: unitKg,
        unitsById,
      });
      expect(result.baseQuantity.toNumber()).toBe(2);
      expect(result.grossAmount.toNumber()).toBe(130);
    });

    it('2.5 kg: 2.5 kg base qty → ₹162.50', () => {
      const result = calculateLineAmount({
        product: brokenWheat,
        enteredQty: 2.5,
        sellingUnit: unitKg,
        unitsById,
      });
      expect(result.baseQuantity.toNumber()).toBe(2.5);
      expect(result.grossAmount.toNumber()).toBe(162.5);
    });
  });

  describe('9. Length UOM Conversion (Cable @ ₹100/m, Stock 100 m)', () => {
    const unitM: UnitRef = {
      id: 'u-m',
      symbol: 'm',
      unitGroupId: 'grp-length',
      unitGroupCode: 'LENGTH',
      conversionToGroupBase: '1000', // base is mm
      isActive: true,
    };
    const unitCm: UnitRef = {
      id: 'u-cm',
      symbol: 'cm',
      unitGroupId: 'grp-length',
      unitGroupCode: 'LENGTH',
      conversionToGroupBase: '10', // 1 cm = 10 mm
      isActive: true,
    };
    const lengthUnitsMap = new Map<string, UnitRef>([
      [unitM.id, unitM],
      [unitCm.id, unitCm],
    ]);

    const cableProduct: ProductPricingRef = {
      id: 'prod-cable',
      baseUnitId: unitM.id,
      pricingUnitId: unitM.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: '100.00',
      basePrice: '100.00',
      productUnits: [
        {
          unitId: unitM.id,
          conversionToBase: '1',
          fixedPrice: null,
          effectiveFrom: new Date('2020-01-01'),
          effectiveTo: null,
          isDefaultSellingUnit: true,
        },
        {
          unitId: unitCm.id,
          conversionToBase: '0.01',
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

    it('50 cm: converts to 0.5 m, price = ₹50.00, inventory 100 m - 0.5 m = 99.5 m', () => {
      const stockOnHand = 100;
      const result = calculateLineAmount({
        product: cableProduct,
        enteredQty: 50,
        sellingUnit: unitCm,
        unitsById: lengthUnitsMap,
      });

      expect(result.baseQuantity.toNumber()).toBe(0.5);
      expect(result.grossAmount.toNumber()).toBe(50);
      const remainingStock = stockOnHand - result.baseQuantity.toNumber();
      expect(remainingStock).toBe(99.5);
    });

    it('1 m: converts to 1 m, price = ₹100.00', () => {
      const result = calculateLineAmount({
        product: cableProduct,
        enteredQty: 1,
        sellingUnit: unitM,
        unitsById: lengthUnitsMap,
      });

      expect(result.baseQuantity.toNumber()).toBe(1);
      expect(result.grossAmount.toNumber()).toBe(100);
    });
  });

  describe('10. Product-Specific Packaging Conversion with Differing Sale, Price, and Inventory UOMs', () => {
    const unitPiece: UnitRef = {
      id: 'u-piece',
      symbol: 'piece',
      unitGroupId: 'grp-count',
      unitGroupCode: 'COUNT',
      conversionToGroupBase: '1',
      isActive: true,
    };
    const unitPack: UnitRef = {
      id: 'u-pack',
      symbol: 'pack',
      unitGroupId: 'grp-count',
      unitGroupCode: 'COUNT',
      conversionToGroupBase: '1',
      isActive: true,
    };
    const unitBox: UnitRef = {
      id: 'u-box',
      symbol: 'box',
      unitGroupId: 'grp-count',
      unitGroupCode: 'COUNT',
      conversionToGroupBase: '1',
      isActive: true,
    };
    const pkgUnitsMap = new Map<string, UnitRef>([
      [unitPiece.id, unitPiece],
      [unitPack.id, unitPack],
      [unitBox.id, unitBox],
    ]);

    const cocaColaProduct: ProductPricingRef = {
      id: 'prod-coke',
      baseUnitId: unitPiece.id,
      pricingUnitId: unitPiece.id,
      pricingStrategy: 'CONVERTED',
      pricePerPricingUnit: '30.00', // ₹30 per piece
      basePrice: '30.00',
      productUnits: [
        {
          unitId: unitPiece.id,
          conversionToBase: '1',
          fixedPrice: null,
          effectiveFrom: new Date('2020-01-01'),
          effectiveTo: null,
          isDefaultSellingUnit: true,
        },
        {
          unitId: unitPack.id,
          conversionToBase: '6', // 1 pack = 6 pieces
          fixedPrice: '180.00', // ₹180 per pack
          effectiveFrom: new Date('2020-01-01'),
          effectiveTo: null,
        },
        {
          unitId: unitBox.id,
          conversionToBase: '24', // 1 box = 24 pieces
          fixedPrice: '700.00', // ₹700 per box
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

    it('Sale UOM = pack, Inventory UOM = piece: 2 packs @ ₹180/pack => Price ₹360, Inventory 240 - 12 = 228 pcs', () => {
      const stockOnHand = 240;
      const result = calculateLineAmount({
        product: cocaColaProduct,
        enteredQty: 2,
        sellingUnit: unitPack,
        unitsById: pkgUnitsMap,
      });

      // 2 packs * 6 = 12 pieces base qty
      expect(result.baseQuantity.toNumber()).toBe(12);
      expect(result.orderedQuantity.toNumber()).toBe(2);
      expect(result.orderedUnitSymbol).toBe('pack');
      // Fixed price for 1 pack = ₹180 => 2 packs = ₹360
      expect(result.unitPrice.toNumber()).toBe(180);
      expect(result.grossAmount.toNumber()).toBe(360);

      // Inventory deduction: 240 - 12 = 228
      const remainingStock = stockOnHand - result.baseQuantity.toNumber();
      expect(remainingStock).toBe(228);
    });

    it('1 box @ ₹700/box => normalizes to 24 pieces base qty, inventory 240 - 24 = 216 pieces', () => {
      const stockOnHand = 240;
      const result = calculateLineAmount({
        product: cocaColaProduct,
        enteredQty: 1,
        sellingUnit: unitBox,
        unitsById: pkgUnitsMap,
      });

      // 1 box * 24 = 24 pieces
      expect(result.baseQuantity.toNumber()).toBe(24);
      expect(result.grossAmount.toNumber()).toBe(700);
      const remainingStock = stockOnHand - result.baseQuantity.toNumber();
      expect(remainingStock).toBe(216);
    });
  });

  describe('11. Incompatible UOM Conversion Rejection', () => {
    it('rejects kg → L (WEIGHT to VOLUME) with INCOMPATIBLE_UNITS', () => {
      expect(() =>
        convertQuantity({
          quantity: 1,
          fromUnit: unitKg,
          toUnit: unitL,
          unitsById,
        }),
      ).toThrow(/Incompatible units|cannot convert/i);
    });

    it('rejects kg → piece (WEIGHT to COUNT) with INCOMPATIBLE_UNITS', () => {
      expect(() =>
        convertQuantity({
          quantity: 1,
          fromUnit: unitKg,
          toUnit: unitPcs,
          unitsById,
        }),
      ).toThrow(/Incompatible units|cannot convert/i);
    });
  });

  describe('12. Backward Compatibility for Legacy Single-Unit Products', () => {
    it('preserves piece product without any multi-unit definitions', () => {
      const legacyPcsProduct: ProductPricingRef = {
        id: 'prod-legacy-pcs',
        baseUnitId: unitPcs.id,
        pricingUnitId: unitPcs.id,
        pricingStrategy: 'CONVERTED',
        pricePerPricingUnit: '25.00',
        basePrice: '25.00',
        productUnits: [],
        availableInPos: true,
        canSell: true,
        canPurchase: true,
        isActive: true,
        trackQty: true,
      };

      const result = calculateLineAmount({
        product: legacyPcsProduct,
        enteredQty: 4,
        sellingUnit: unitPcs,
        unitsById,
      });

      expect(result.enteredQty.toNumber()).toBe(4);
      expect(result.baseQuantity.toNumber()).toBe(4);
      expect(result.unitPrice.toNumber()).toBe(25);
      expect(result.grossAmount.toNumber()).toBe(100);
    });

    it('preserves kg product without multi-unit definitions', () => {
      const legacyKgProduct: ProductPricingRef = {
        id: 'prod-legacy-kg',
        baseUnitId: unitKg.id,
        pricingUnitId: unitKg.id,
        pricingStrategy: 'CONVERTED',
        pricePerPricingUnit: '80.00',
        basePrice: '80.00',
        productUnits: [],
        availableInPos: true,
        canSell: true,
        canPurchase: true,
        isActive: true,
        trackQty: true,
      };

      const result = calculateLineAmount({
        product: legacyKgProduct,
        enteredQty: 2,
        sellingUnit: unitKg,
        unitsById,
      });

      expect(result.enteredQty.toNumber()).toBe(2);
      expect(result.baseQuantity.toNumber()).toBe(2);
      expect(result.unitPrice.toNumber()).toBe(80);
      expect(result.grossAmount.toNumber()).toBe(160);
    });
  });

  describe('13. Universal UOM Data-Driven Matrix Engine Tests', () => {
    const LENGTH_GROUP_ID = 'grp-length';
    const unitM: UnitRef = {
      id: 'u-m',
      symbol: 'm',
      unitGroupId: LENGTH_GROUP_ID,
      unitGroupCode: 'LENGTH',
      conversionToGroupBase: '1000',
      isActive: true,
    };
    const unitCm: UnitRef = {
      id: 'u-cm',
      symbol: 'cm',
      unitGroupId: LENGTH_GROUP_ID,
      unitGroupCode: 'LENGTH',
      conversionToGroupBase: '10',
      isActive: true,
    };
    const dozenUnit: UnitRef = {
      id: 'u-dozen',
      symbol: 'dozen',
      name: 'Dozen',
      unitGroupId: COUNT_GROUP_ID,
      unitGroupCode: 'COUNT',
      conversionToGroupBase: 12,
      isActive: true,
    };
    const packUnit: UnitRef = {
      id: 'u-pack',
      symbol: 'pack',
      name: 'Pack',
      unitGroupId: COUNT_GROUP_ID,
      unitGroupCode: 'COUNT',
      conversionToGroupBase: 1,
      isActive: true,
    };
    const boxUnit: UnitRef = {
      id: 'u-box',
      symbol: 'box',
      name: 'Box',
      unitGroupId: COUNT_GROUP_ID,
      unitGroupCode: 'COUNT',
      conversionToGroupBase: 1,
      isActive: true,
    };

    const universalUnitsMap = new Map<string, UnitRef>([
      [unitKg.id, unitKg],
      [unitG.id, unitG],
      [unitL.id, unitL],
      [unitMl.id, unitMl],
      [unitM.id, unitM],
      [unitCm.id, unitCm],
      [unitPcs.id, unitPcs],
      [dozenUnit.id, dozenUnit],
      [packUnit.id, packUnit],
      [boxUnit.id, boxUnit],
    ]);

    describe('Weight Matrix: 5g, 100g, 250g, 500g, 1kg, 2.5kg (@ ₹65/kg)', () => {
      const weightCases = [
        { qty: 5, unit: unitG, expectedBaseQty: 0.005, expectedGross: 0.33 },
        { qty: 100, unit: unitG, expectedBaseQty: 0.1, expectedGross: 6.5 },
        { qty: 250, unit: unitG, expectedBaseQty: 0.25, expectedGross: 16.25 },
        { qty: 500, unit: unitG, expectedBaseQty: 0.5, expectedGross: 32.5 },
        { qty: 1, unit: unitKg, expectedBaseQty: 1, expectedGross: 65 },
        { qty: 2.5, unit: unitKg, expectedBaseQty: 2.5, expectedGross: 162.5 },
      ];

      test.each(weightCases)(
        'selling $qty $unit.symbol → base $expectedBaseQty kg, amount ₹$expectedGross',
        ({ qty, unit, expectedBaseQty, expectedGross }) => {
          const res = calculateLineAmount({
            product: {
              id: 'p-grain',
              baseUnitId: unitKg.id,
              pricingUnitId: unitKg.id,
              pricingStrategy: 'CONVERTED',
              pricePerPricingUnit: 65,
              basePrice: 65,
              productUnits: [
                { unitId: unitKg.id, conversionToBase: 1, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
                { unitId: unitG.id, conversionToBase: 0.001, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
              ],
            },
            enteredQty: qty,
            sellingUnit: unit,
            unitsById: universalUnitsMap,
          });
          expect(res.enteredQty.toNumber()).toBe(qty);
          expect(res.baseQuantity.toNumber()).toBe(expectedBaseQty);
          expect(res.grossAmount.toNumber()).toBe(expectedGross);
        },
      );
    });

    describe('Volume Matrix: 250ml, 500ml, 1L, 1.5L (@ ₹60/L)', () => {
      const volumeCases = [
        { qty: 250, unit: unitMl, expectedBaseQty: 0.25, expectedGross: 15 },
        { qty: 500, unit: unitMl, expectedBaseQty: 0.5, expectedGross: 30 },
        { qty: 1, unit: unitL, expectedBaseQty: 1, expectedGross: 60 },
        { qty: 1.5, unit: unitL, expectedBaseQty: 1.5, expectedGross: 90 },
      ];

      test.each(volumeCases)(
        'selling $qty $unit.symbol → base $expectedBaseQty L, amount ₹$expectedGross',
        ({ qty, unit, expectedBaseQty, expectedGross }) => {
          const res = calculateLineAmount({
            product: {
              id: 'p-oil',
              baseUnitId: unitL.id,
              pricingUnitId: unitL.id,
              pricingStrategy: 'CONVERTED',
              pricePerPricingUnit: 60,
              basePrice: 60,
              productUnits: [
                { unitId: unitL.id, conversionToBase: 1, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
                { unitId: unitMl.id, conversionToBase: 0.001, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
              ],
            },
            enteredQty: qty,
            sellingUnit: unit,
            unitsById: universalUnitsMap,
          });
          expect(res.enteredQty.toNumber()).toBe(qty);
          expect(res.baseQuantity.toNumber()).toBe(expectedBaseQty);
          expect(res.grossAmount.toNumber()).toBe(expectedGross);
        },
      );
    });

    describe('Length Matrix: 50cm, 100cm, 1.5m (@ ₹100/m)', () => {
      const lengthCases = [
        { qty: 50, unit: unitCm, expectedBaseQty: 0.5, expectedGross: 50 },
        { qty: 100, unit: unitCm, expectedBaseQty: 1, expectedGross: 100 },
        { qty: 1.5, unit: unitM, expectedBaseQty: 1.5, expectedGross: 150 },
      ];

      test.each(lengthCases)(
        'selling $qty $unit.symbol → base $expectedBaseQty m, amount ₹$expectedGross',
        ({ qty, unit, expectedBaseQty, expectedGross }) => {
          const res = calculateLineAmount({
            product: {
              id: 'p-wire',
              baseUnitId: unitM.id,
              pricingUnitId: unitM.id,
              pricingStrategy: 'CONVERTED',
              pricePerPricingUnit: 100,
              basePrice: 100,
              productUnits: [
                { unitId: unitM.id, conversionToBase: 1, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
                { unitId: unitCm.id, conversionToBase: 0.01, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
              ],
            },
            enteredQty: qty,
            sellingUnit: unit,
            unitsById: universalUnitsMap,
          });
          expect(res.enteredQty.toNumber()).toBe(qty);
          expect(res.baseQuantity.toNumber()).toBe(expectedBaseQty);
          expect(res.grossAmount.toNumber()).toBe(expectedGross);
        },
      );
    });

    describe('Packaging & Count Matrix (Splittable & Whole-only)', () => {
      const bananaProduct: ProductPricingRef = {
        id: 'p-banana',
        baseUnitId: unitPcs.id,
        pricingUnitId: dozenUnit.id,
        pricingStrategy: 'CONVERTED',
        pricePerPricingUnit: 50, // ₹50/dozen
        basePrice: 50,
        productUnits: [],
      };

      const packagingCases = [
        { qty: 0.5, unit: dozenUnit, prod: bananaProduct, expectedBaseQty: 6, expectedGross: 25 },
        { qty: 1, unit: dozenUnit, prod: bananaProduct, expectedBaseQty: 12, expectedGross: 50 },
        { qty: 1.5, unit: dozenUnit, prod: bananaProduct, expectedBaseQty: 18, expectedGross: 75 },
        { qty: 2.5, unit: dozenUnit, prod: bananaProduct, expectedBaseQty: 30, expectedGross: 125 },
        {
          qty: 0.5,
          unit: packUnit,
          prod: {
            id: 'p-pack-prod',
            baseUnitId: unitPcs.id,
            pricingUnitId: packUnit.id,
            pricingStrategy: 'CONVERTED',
            pricePerPricingUnit: 60,
            basePrice: 60,
            allowFractionalQuantity: true,
            productUnits: [{ unitId: packUnit.id, conversionToBase: 6, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null, allowFraction: true }],
          },
          expectedBaseQty: 3,
          expectedGross: 30,
        },
        {
          qty: 2,
          unit: packUnit,
          prod: {
            id: 'p-pack-prod-2',
            baseUnitId: unitPcs.id,
            pricingUnitId: packUnit.id,
            pricingStrategy: 'CONVERTED',
            pricePerPricingUnit: 60,
            basePrice: 60,
            productUnits: [{ unitId: packUnit.id, conversionToBase: 6, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null }],
          },
          expectedBaseQty: 12,
          expectedGross: 120,
        },
        {
          qty: 0.5,
          unit: boxUnit,
          prod: {
            id: 'p-box-prod',
            baseUnitId: unitPcs.id,
            pricingUnitId: boxUnit.id,
            pricingStrategy: 'CONVERTED',
            pricePerPricingUnit: 240,
            basePrice: 240,
            allowFractionalQuantity: true,
            productUnits: [{ unitId: boxUnit.id, conversionToBase: 24, fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null, allowFraction: true }],
          },
          expectedBaseQty: 12,
          expectedGross: 120,
        },
        {
          qty: 1,
          unit: unitPcs,
          prod: {
            id: 'p-item',
            baseUnitId: unitPcs.id,
            pricingUnitId: unitPcs.id,
            pricingStrategy: 'CONVERTED',
            pricePerPricingUnit: 10,
            basePrice: 10,
            productUnits: [],
          },
          expectedBaseQty: 1,
          expectedGross: 10,
        },
        {
          qty: 2,
          unit: unitPcs,
          prod: {
            id: 'p-item',
            baseUnitId: unitPcs.id,
            pricingUnitId: unitPcs.id,
            pricingStrategy: 'CONVERTED',
            pricePerPricingUnit: 10,
            basePrice: 10,
            productUnits: [],
          },
          expectedBaseQty: 2,
          expectedGross: 20,
        },
      ];

      test.each(packagingCases)(
        'packaging sale $qty $unit.symbol → base $expectedBaseQty, amount ₹$expectedGross',
        ({ qty, unit, prod, expectedBaseQty, expectedGross }) => {
          const res = calculateLineAmount({
            product: prod,
            enteredQty: qty,
            sellingUnit: unit,
            unitsById: universalUnitsMap,
          });
          expect(res.enteredQty.toNumber()).toBe(qty);
          expect(res.baseQuantity.toNumber()).toBe(expectedBaseQty);
          expect(res.grossAmount.toNumber()).toBe(expectedGross);
        },
      );

      it('rejects 0.5 piece when fractional=false', () => {
        expect(() =>
          calculateLineAmount({
            product: {
              id: 'p-soap',
              baseUnitId: unitPcs.id,
              pricingUnitId: unitPcs.id,
              pricingStrategy: 'CONVERTED',
              pricePerPricingUnit: 10,
              basePrice: 10,
              productUnits: [],
            },
            enteredQty: 0.5,
            sellingUnit: unitPcs,
            unitsById: universalUnitsMap,
          }),
        ).toThrow(/Quantity for pcs must be a whole number/i);
      });
    });

    describe('Incompatible Conversions Rejection', () => {
      const incompatiblePairs = [
        { from: unitKg, to: unitL, desc: 'kg → L' },
        { from: unitKg, to: unitPcs, desc: 'kg → piece' },
        { from: unitM, to: unitKg, desc: 'm → kg' },
      ];

      test.each(incompatiblePairs)('rejects incompatible conversion: $desc', ({ from, to }) => {
        expect(() =>
          convertQuantity({
            quantity: 1,
            fromUnit: from,
            toUnit: to,
            unitsById: universalUnitsMap,
          }),
        ).toThrow(/Incompatible units/i);
      });
    });

    describe('Loose / Variable Quantity Dynamic Unit Selector & Physical Preservation', () => {
      const wheatProduct: ProductPricingRef = {
        id: 'p-broken-wheat',
        baseUnitId: unitG.id, // Base UOM = g
        pricingUnitId: unitKg.id, // Price = ₹65/kg
        pricingStrategy: 'CONVERTED',
        pricePerPricingUnit: 65,
        basePrice: 65,
        productUnits: [
          {
            unitId: unitG.id,
            conversionToBase: 1,
            fixedPrice: null,
            effectiveFrom: new Date('2020-01-01'),
            effectiveTo: null,
            allowFraction: true,
          },
          {
            unitId: unitKg.id,
            conversionToBase: 1000,
            fixedPrice: null,
            effectiveFrom: new Date('2020-01-01'),
            effectiveTo: null,
            allowFraction: true,
          },
        ],
      };

      const testMatrix = [
        { inputQty: 5, unit: unitG, expectedBaseQty: 5, expectedPrice: 0.33 },
        { inputQty: 100, unit: unitG, expectedBaseQty: 100, expectedPrice: 6.50 },
        { inputQty: 250, unit: unitG, expectedBaseQty: 250, expectedPrice: 16.25 },
        { inputQty: 500, unit: unitG, expectedBaseQty: 500, expectedPrice: 32.50 },
        { inputQty: 1, unit: unitKg, expectedBaseQty: 1000, expectedPrice: 65.00 },
        { inputQty: 2.5, unit: unitKg, expectedBaseQty: 2500, expectedPrice: 162.50 },
      ];

      test.each(testMatrix)(
        'Broken Wheat $inputQty $unit.symbol → base $expectedBaseQty g, price ₹$expectedPrice',
        ({ inputQty, unit, expectedBaseQty, expectedPrice }) => {
          const res = calculateLineAmount({
            product: wheatProduct,
            enteredQty: inputQty,
            sellingUnit: unit,
            unitsById: universalUnitsMap,
          });
          expect(res.enteredQty.toNumber()).toBe(inputQty);
          expect(res.baseQuantity.toNumber()).toBe(expectedBaseQty);
          expect(Number(res.grossAmount.toFixed(2))).toBe(expectedPrice);
        },
      );

      it('preserves physical quantity when switching unit from 5 g to kg → 0.005 kg', () => {
        // Current: 5 g
        const currentRes = calculateLineAmount({
          product: wheatProduct,
          enteredQty: 5,
          sellingUnit: unitG,
          unitsById: universalUnitsMap,
        });
        const currentBaseQty = currentRes.baseQuantity.toNumber(); // 5 g

        // User switches selector to kg: new entered qty = 5 g / 1000 = 0.005 kg
        const switchedQty = currentBaseQty / 1000;
        expect(switchedQty).toBe(0.005);

        const switchedRes = calculateLineAmount({
          product: wheatProduct,
          enteredQty: switchedQty,
          sellingUnit: unitKg,
          unitsById: universalUnitsMap,
        });
        expect(switchedRes.enteredQty.toNumber()).toBe(0.005);
        expect(switchedRes.baseQuantity.toNumber()).toBe(5);
        expect(Number(switchedRes.grossAmount.toFixed(2))).toBe(0.33);
      });

      it('preserves physical quantity when switching unit from 0.5 kg to g → 500 g', () => {
        // Current: 0.5 kg
        const currentRes = calculateLineAmount({
          product: wheatProduct,
          enteredQty: 0.5,
          sellingUnit: unitKg,
          unitsById: universalUnitsMap,
        });
        const currentBaseQty = currentRes.baseQuantity.toNumber(); // 500 g

        // User switches selector to g: new entered qty = 500 g / 1 = 500 g
        const switchedQty = currentBaseQty / 1;
        expect(switchedQty).toBe(500);

        const switchedRes = calculateLineAmount({
          product: wheatProduct,
          enteredQty: switchedQty,
          sellingUnit: unitG,
          unitsById: universalUnitsMap,
        });
        expect(switchedRes.enteredQty.toNumber()).toBe(500);
        expect(switchedRes.baseQuantity.toNumber()).toBe(500);
        expect(Number(switchedRes.grossAmount.toFixed(2))).toBe(32.50);
      });
    });
  });
});

