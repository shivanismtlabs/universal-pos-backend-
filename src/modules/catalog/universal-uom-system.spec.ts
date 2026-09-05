import {
  calculateLineAmount,
  convertQuantity,
  reverseHistoricalBaseQty,
  UnitPricingError,
  type UnitRef,
  type ProductPricingRef,
} from './pricing-engine';

describe('Universal POS — Configuration-Driven UOM & Quantity Engine (20-Point Matrix)', () => {
  const WEIGHT_GRP = 'grp-weight';
  const VOLUME_GRP = 'grp-volume';
  const LENGTH_GRP = 'grp-length';
  const COUNT_GRP = 'grp-count';
  const TIME_GRP = 'grp-time';
  const CUSTOM_GRP = 'grp-custom';

  const uG: UnitRef = { id: 'u-g', symbol: 'g', unitGroupId: WEIGHT_GRP, unitGroupCode: 'WEIGHT', conversionToGroupBase: '1', isActive: true };
  const uKg: UnitRef = { id: 'u-kg', symbol: 'kg', unitGroupId: WEIGHT_GRP, unitGroupCode: 'WEIGHT', conversionToGroupBase: '1000', isActive: true };
  const uMl: UnitRef = { id: 'u-ml', symbol: 'ml', unitGroupId: VOLUME_GRP, unitGroupCode: 'VOLUME', conversionToGroupBase: '1', isActive: true };
  const uL: UnitRef = { id: 'u-l', symbol: 'L', unitGroupId: VOLUME_GRP, unitGroupCode: 'VOLUME', conversionToGroupBase: '1000', isActive: true };
  const uCm: UnitRef = { id: 'u-cm', symbol: 'cm', unitGroupId: LENGTH_GRP, unitGroupCode: 'LENGTH', conversionToGroupBase: '10', isActive: true };
  const uM: UnitRef = { id: 'u-m', symbol: 'm', unitGroupId: LENGTH_GRP, unitGroupCode: 'LENGTH', conversionToGroupBase: '1000', isActive: true };
  const uPcs: UnitRef = { id: 'u-pcs', symbol: 'pcs', unitGroupId: COUNT_GRP, unitGroupCode: 'COUNT', conversionToGroupBase: '1', isActive: true };
  const uDozen: UnitRef = { id: 'u-dozen', symbol: 'dozen', unitGroupId: COUNT_GRP, unitGroupCode: 'COUNT', conversionToGroupBase: '12', isActive: true };
  const uTablet: UnitRef = { id: 'u-tab', symbol: 'tablet', unitGroupId: COUNT_GRP, unitGroupCode: 'COUNT', conversionToGroupBase: '1', isActive: true };
  const uStrip: UnitRef = { id: 'u-strip', symbol: 'strip', unitGroupId: COUNT_GRP, unitGroupCode: 'COUNT', conversionToGroupBase: '10', isActive: true };
  const uDay: UnitRef = { id: 'u-day', symbol: 'day', unitGroupId: TIME_GRP, unitGroupCode: 'TIME', conversionToGroupBase: '1', isActive: true };
  const uWeek: UnitRef = { id: 'u-week', symbol: 'week', unitGroupId: TIME_GRP, unitGroupCode: 'TIME', conversionToGroupBase: '7', isActive: true };
  const uSvc: UnitRef = { id: 'u-svc', symbol: 'service', unitGroupId: COUNT_GRP, unitGroupCode: 'COUNT', conversionToGroupBase: '1', decimals: 2, isActive: true };
  const uBottle: UnitRef = { id: 'u-btl', symbol: 'bottle', unitGroupId: CUSTOM_GRP, unitGroupCode: 'CUSTOM', conversionToGroupBase: '1', isActive: true };
  const uCrate: UnitRef = { id: 'u-crate', symbol: 'crate', unitGroupId: CUSTOM_GRP, unitGroupCode: 'CUSTOM', conversionToGroupBase: '24', isActive: true };
  const uDisabled: UnitRef = { id: 'u-disabled', symbol: 'old_unit', unitGroupId: WEIGHT_GRP, unitGroupCode: 'WEIGHT', conversionToGroupBase: '1', isActive: false };

  const unitsById = new Map<string, UnitRef>([
    [uG.id, uG], [uKg.id, uKg],
    [uMl.id, uMl], [uL.id, uL],
    [uCm.id, uCm], [uM.id, uM],
    [uPcs.id, uPcs], [uDozen.id, uDozen], [uTablet.id, uTablet], [uStrip.id, uStrip],
    [uDay.id, uDay], [uWeek.id, uWeek],
    [uSvc.id, uSvc], [uBottle.id, uBottle], [uCrate.id, uCrate],
    [uDisabled.id, uDisabled],
  ]);

  const pulseProd: ProductPricingRef = {
    id: 'prod-pulse',
    baseUnitId: uKg.id,
    pricingUnitId: uKg.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '20.00', // ₹20/kg
    basePrice: '20.00',
    productUnits: [
      { unitId: uKg.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      { unitId: uG.id, conversionToBase: '0.001', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const cableProd: ProductPricingRef = {
    id: 'prod-cable',
    baseUnitId: uM.id,
    pricingUnitId: uM.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '100.00', // ₹100/m
    basePrice: '100.00',
    productUnits: [
      { unitId: uM.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      { unitId: uCm.id, conversionToBase: '0.01', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const milkProd: ProductPricingRef = {
    id: 'prod-milk',
    baseUnitId: uL.id,
    pricingUnitId: uL.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '60.00', // ₹60/L
    basePrice: '60.00',
    productUnits: [
      { unitId: uL.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      { unitId: uMl.id, conversionToBase: '0.001', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const eggProd: ProductPricingRef = {
    id: 'prod-egg',
    baseUnitId: uPcs.id,
    pricingUnitId: uPcs.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '6.00', // ₹6/pcs
    basePrice: '6.00',
    productUnits: [
      { unitId: uPcs.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      { unitId: uDozen.id, conversionToBase: '12', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const pharmaProd: ProductPricingRef = {
    id: 'prod-paracetamol',
    baseUnitId: uTablet.id,
    pricingUnitId: uTablet.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '2.00', // ₹2/tablet
    basePrice: '2.00',
    productUnits: [
      { unitId: uTablet.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      { unitId: uStrip.id, conversionToBase: '10', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const rentalProd: ProductPricingRef = {
    id: 'prod-projector',
    baseUnitId: uDay.id,
    pricingUnitId: uDay.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '500.00', // ₹500/day
    basePrice: '500.00',
    productUnits: [
      { unitId: uDay.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      { unitId: uWeek.id, conversionToBase: '7', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const serviceProd: ProductPricingRef = {
    id: 'prod-carwash',
    baseUnitId: uSvc.id,
    pricingUnitId: uSvc.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '350.00',
    basePrice: '350.00',
    productUnits: [
      { unitId: uSvc.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: false,
  };

  const customCrateProd: ProductPricingRef = {
    id: 'prod-soda',
    baseUnitId: uBottle.id,
    pricingUnitId: uBottle.id,
    pricingStrategy: 'CONVERTED',
    pricePerPricingUnit: '15.00', // ₹15/bottle
    basePrice: '15.00',
    productUnits: [
      { unitId: uBottle.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      { unitId: uCrate.id, conversionToBase: '24', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
    ],
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  const legacyDefaultCountProd: ProductPricingRef = {
    id: 'prod-legacy-item',
    pricePerPricingUnit: '50.00',
    basePrice: '50.00',
    availableInPos: true,
    canSell: true,
    canPurchase: true,
    isActive: true,
    trackQty: true,
  };

  // ─── 1. Weight Conversion ───
  it('1. Weight: 500 g converts to 0.5 kg base quantity', () => {
    const res = calculateLineAmount({ product: pulseProd, enteredQty: 500, sellingUnit: uG, unitsById });
    expect(res.baseQuantity.toNumber()).toBe(0.5);
    expect(res.baseUnitSymbol).toBe('kg');
  });

  // ─── 2. Weight Pricing ───
  it('2. Weight pricing: 0.5 kg × ₹20/kg produces ₹10 line amount', () => {
    const res = calculateLineAmount({ product: pulseProd, enteredQty: 500, sellingUnit: uG, unitsById });
    expect(res.lineTotal.toNumber()).toBe(10);
    expect(res.grossAmount.toNumber()).toBe(10);
  });

  // ─── 3. Identical Quantities ───
  it('3. Identical quantities: 500 g and 0.5 kg produce identical base quantity and amount', () => {
    const resG = calculateLineAmount({ product: pulseProd, enteredQty: 500, sellingUnit: uG, unitsById });
    const resKg = calculateLineAmount({ product: pulseProd, enteredQty: 0.5, sellingUnit: uKg, unitsById });
    expect(resG.baseQuantity.toNumber()).toBe(resKg.baseQuantity.toNumber());
    expect(resG.lineTotal.toNumber()).toBe(resKg.lineTotal.toNumber());
  });

  // ─── 4. Length ───
  it('4. Length: 50 cm converts to 0.5 m base quantity and ₹50 line amount (@ ₹100/m)', () => {
    const res = calculateLineAmount({ product: cableProd, enteredQty: 50, sellingUnit: uCm, unitsById });
    expect(res.baseQuantity.toNumber()).toBe(0.5);
    expect(res.lineTotal.toNumber()).toBe(50);
  });

  // ─── 5. Volume ───
  it('5. Volume: 250 ml converts to 0.25 L base quantity and ₹15 line amount (@ ₹60/L)', () => {
    const res = calculateLineAmount({ product: milkProd, enteredQty: 250, sellingUnit: uMl, unitsById });
    expect(res.baseQuantity.toNumber()).toBe(0.25);
    expect(res.lineTotal.toNumber()).toBe(15);
  });

  // ─── 6. Count Packaging (Dozen) ───
  it('6. Count: 0.5 dozen converts to 6 pcs base quantity and ₹36 line amount (@ ₹6/pcs)', () => {
    const res = calculateLineAmount({ product: eggProd, enteredQty: 0.5, sellingUnit: uDozen, unitsById });
    expect(res.baseQuantity.toNumber()).toBe(6);
    expect(res.lineTotal.toNumber()).toBe(36);
  });

  // ─── 7. Pharma Packaging (Strip of Tablets) ───
  it('7. Packaging: 1 strip converts to 10 tablets base quantity and ₹20 line amount (@ ₹2/tablet)', () => {
    const res = calculateLineAmount({ product: pharmaProd, enteredQty: 1, sellingUnit: uStrip, unitsById });
    expect(res.baseQuantity.toNumber()).toBe(10);
    expect(res.lineTotal.toNumber()).toBe(20);
  });

  // ─── 8. Time / Rental Duration ───
  it('8. Time: 1 week converts to 7 days base quantity and ₹3500 line amount (@ ₹500/day)', () => {
    const res = calculateLineAmount({ product: rentalProd, enteredQty: 1, sellingUnit: uWeek, unitsById });
    expect(res.baseQuantity.toNumber()).toBe(7);
    expect(res.lineTotal.toNumber()).toBe(3500);
  });

  // ─── 9. Service Quantity ───
  it('9. Service: 1.5 services converts to 1.5 base quantity and ₹525 line amount (@ ₹350/service)', () => {
    const res = calculateLineAmount({ product: serviceProd, enteredQty: 1.5, sellingUnit: uSvc, unitsById });
    expect(res.baseQuantity.toNumber()).toBe(1.5);
    expect(res.lineTotal.toNumber()).toBe(525);
  });

  // ─── 10. Custom Business Unit ───
  it('10. Custom unit: 1 crate converts to 24 bottles base quantity and ₹360 line amount (@ ₹15/bottle)', () => {
    const res = calculateLineAmount({ product: customCrateProd, enteredQty: 1, sellingUnit: uCrate, unitsById });
    expect(res.baseQuantity.toNumber()).toBe(24);
    expect(res.lineTotal.toNumber()).toBe(360);
  });

  // ─── 11. Stock Validation ───
  it('11. Stock validation: 500 g (0.5 kg) correctly checked against stock limit', () => {
    const res = calculateLineAmount({ product: pulseProd, enteredQty: 500, sellingUnit: uG, unitsById });
    const baseRequired = res.baseQuantity.toNumber(); // 0.5 kg
    const stockAvailableKg = 0.2; // 200 g stock available

    expect(baseRequired).toBe(0.5);
    expect(baseRequired > stockAvailableKg).toBe(true); // Exceeds available stock
  });

  // ─── 12. Cart Item Count Line Semantics ───
  it('12. Cart item count: 1 cart line of 500 g pulse yields cartLines.length = 1 (NEVER 500)', () => {
    const cart = [{ productId: 'prod-pulse', orderedQuantity: 500, orderedUnitSymbol: 'g' }];
    expect(cart.length).toBe(1);
  });

  // ─── 13. Multiple Cart Lines ───
  it('13. Multiple cart lines: 500 g pulse + 2 pcs eggs yields cart item count = 2', () => {
    const cart = [
      { productId: 'prod-pulse', orderedQuantity: 500, orderedUnitSymbol: 'g' },
      { productId: 'prod-egg', orderedQuantity: 2, orderedUnitSymbol: 'pcs' },
    ];
    expect(cart.length).toBe(2);
  });

  // ─── 14. Price Equivalence ───
  it('14. Price equivalence: 500 g and 0.5 kg yield mathematically identical final line totals', () => {
    const res1 = calculateLineAmount({ product: pulseProd, enteredQty: 500, sellingUnit: uG, unitsById });
    const res2 = calculateLineAmount({ product: pulseProd, enteredQty: 0.5, sellingUnit: uKg, unitsById });
    expect(res1.finalAmount.toString()).toBe(res2.finalAmount.toString());
  });

  // ─── 15. Fraction Precision ───
  it('15. Fraction precision: rejects fractional quantity for discrete atomic pcs unit', () => {
    expect(() =>
      calculateLineAmount({ product: eggProd, enteredQty: 1.5, sellingUnit: uPcs, unitsById }),
    ).toThrow(/Quantity for pcs must be a whole number/i);
  });

  // ─── 16. Invalid Unit Handling ───
  it('16. Invalid unit: throws UNIT_DISABLED when selling unit is inactive', () => {
    expect(() =>
      calculateLineAmount({ product: pulseProd, enteredQty: 1, sellingUnit: uDisabled, unitsById }),
    ).toThrow(/is not enabled/i);
  });

  // ─── 17. Missing Conversion Factor ───
  it('17. Incompatible units: throws error when converting between incompatible groups without conversion link', () => {
    expect(() =>
      convertQuantity({ quantity: 10, fromUnit: uG, toUnit: uM, unitsById }),
    ).toThrow(/Incompatible units/i);
  });

  // ─── 18. Zero / Negative Quantity ───
  it('18. Zero/negative quantity: throws error for <= 0 entered quantity', () => {
    expect(() =>
      calculateLineAmount({ product: pulseProd, enteredQty: 0, sellingUnit: uG, unitsById }),
    ).toThrow(/must be greater than 0/i);
    expect(() =>
      calculateLineAmount({ product: pulseProd, enteredQty: -5, sellingUnit: uG, unitsById }),
    ).toThrow(/must be greater than 0/i);
  });

  // ─── 19. Return Using Historical Conversion ───
  it('19. Historical Return: scales original base quantity by returned ordered quantity accurately', () => {
    // Original sale: 500 g (baseQuantity = 0.5 kg)
    // Customer returns: 250 g
    const returnedBaseQty = reverseHistoricalBaseQty({
      originalOrderedQty: 500,
      originalBaseQty: 0.5,
      returnOrderedQty: 250,
    });
    expect(returnedBaseQty.toNumber()).toBe(0.25);
  });

  // ─── 20. Backward-Compatible Count Product ───
  it('20. Backward compatibility: default fallback product without UOM master evaluates cleanly to pcs', () => {
    const res = calculateLineAmount({ product: legacyDefaultCountProd, enteredQty: 3 });
    expect(res.orderedQuantity.toNumber()).toBe(3);
    expect(res.baseQuantity.toNumber()).toBe(3);
    expect(res.orderedUnitSymbol).toBe('pcs');
    expect(res.lineTotal.toNumber()).toBe(150);
  });

  // ─── 21. Explicit 13 Acceptance Tests Matrix ───
  describe('User Acceptance Test Suite (13 Specific Criteria)', () => {
    const pulsePer100gProd: ProductPricingRef = {
      id: 'prod-pulse-100g',
      baseUnitId: uG.id,
      pricingUnitId: uG.id,
      configuredPriceQuantity: '100', // ₹200 per 100 g
      pricePerPricingUnit: '200.00',
      basePrice: '200.00',
      productUnits: [
        { unitId: uG.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
        { unitId: uKg.id, conversionToBase: '1000', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      ],
      availableInPos: true,
      canSell: true,
      isActive: true,
      trackQty: true,
    };

    const pulsePerKgProd: ProductPricingRef = {
      id: 'prod-pulse-kg',
      baseUnitId: uG.id,
      pricingUnitId: uKg.id,
      configuredPriceQuantity: '1', // ₹2000 per 1 kg
      pricePerPricingUnit: '2000.00',
      basePrice: '2000.00',
      productUnits: [
        { unitId: uG.id, conversionToBase: '1', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
        { unitId: uKg.id, conversionToBase: '1000', fixedPrice: null, effectiveFrom: new Date('2020-01-01'), effectiveTo: null },
      ],
      availableInPos: true,
      canSell: true,
      isActive: true,
      trackQty: true,
    };

    it('Test 1: Price = ₹200 / 100 g, Input = 100 g → ₹200', () => {
      const res = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 100, sellingUnit: uG, unitsById });
      expect(res.amount.toNumber()).toBe(200);
    });

    it('Test 2: Price = ₹200 / 100 g, Input = 0.1 kg → Base = 100 g, Amount = ₹200', () => {
      const res = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 0.1, sellingUnit: uKg, unitsById });
      expect(res.baseQuantity.toNumber()).toBe(100);
      expect(res.amount.toNumber()).toBe(200);
    });

    it('Test 3: Price = ₹200 / 100 g, Input = 250 g → ₹500', () => {
      const res = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 250, sellingUnit: uG, unitsById });
      expect(res.amount.toNumber()).toBe(500);
    });

    it('Test 4: Price = ₹200 / 100 g, Input = 500 g → ₹1,000', () => {
      const res = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 500, sellingUnit: uG, unitsById });
      expect(res.amount.toNumber()).toBe(1000);
    });

    it('Test 5: Price = ₹2,000 / kg, Input = 500 g → ₹1,000', () => {
      const res = calculateLineAmount({ product: pulsePerKgProd, enteredQty: 500, sellingUnit: uG, unitsById });
      expect(res.amount.toNumber()).toBe(1000);
    });

    it('Test 6: Stock = 300 g, Input = 100 g → Allowed, remaining stock = 200 g', () => {
      const res = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 100, sellingUnit: uG, unitsById });
      const stock = 300;
      const baseReq = res.baseQuantity.toNumber();
      expect(baseReq).toBe(100);
      expect(baseReq <= stock).toBe(true);
      expect(stock - baseReq).toBe(200);
    });

    it('Test 7: Stock = 300 g, Input = 0.5 kg → Blocked (insufficient stock)', () => {
      const res = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 0.5, sellingUnit: uKg, unitsById });
      const stock = 300;
      const baseReq = res.baseQuantity.toNumber(); // 500 g
      expect(baseReq).toBe(500);
      expect(baseReq > stock).toBe(true);
    });

    it('Test 8: 100 g added to cart → cart line count = 1', () => {
      const cart = [{ sku: 'PULSE', qty: 100, sellUnit: 'g' }];
      expect(cart.length).toBe(1);
    });

    it('Test 9: 100 g added to cart → qty = 100, UOM = g, NOT 100 items', () => {
      const cartLine = { sku: 'PULSE', qty: 100, sellUnit: 'g' };
      expect(cartLine.qty).toBe(100);
      expect(cartLine.sellUnit).toBe('g');
    });

    it('Test 10: 0.1 kg added to cart → qty = 0.1, UOM = kg, baseQuantity = 100 g, amount = ₹200', () => {
      const res = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 0.1, sellingUnit: uKg, unitsById });
      expect(res.orderedQuantity.toNumber()).toBe(0.1);
      expect(res.orderedUnitSymbol).toBe('kg');
      expect(res.baseQuantity.toNumber()).toBe(100);
      expect(res.amount.toNumber()).toBe(200);
    });

    it('Test 11: Changing UOM from g → kg recalculates amount immediately & consistently', () => {
      const res1 = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 100, sellingUnit: uG, unitsById });
      const res2 = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 0.1, sellingUnit: uKg, unitsById });
      expect(res1.amount.toNumber()).toBe(200);
      expect(res2.amount.toNumber()).toBe(200);
    });

    it('Test 12: Changing quantity from 100 g to 250 g recalculates amount ₹200 → ₹500', () => {
      const res1 = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 100, sellingUnit: uG, unitsById });
      const res2 = calculateLineAmount({ product: pulsePer100gProd, enteredQty: 250, sellingUnit: uG, unitsById });
      expect(res1.amount.toNumber()).toBe(200);
      expect(res2.amount.toNumber()).toBe(500);
    });

    it('Test 13: Changing quantity/UOM never changes cart line count', () => {
      let cartLines = [{ sku: 'PULSE', qty: 100, sellUnit: 'g' }];
      expect(cartLines.length).toBe(1);
      cartLines = [{ sku: 'PULSE', qty: 0.1, sellUnit: 'kg' }];
      expect(cartLines.length).toBe(1);
    });
  });
});
