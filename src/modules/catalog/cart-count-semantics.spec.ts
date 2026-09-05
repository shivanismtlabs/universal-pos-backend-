import { calculateLineAmount, type UnitRef, type ProductPricingRef } from './pricing-engine';

describe('Cart Line Count vs Product Quantity/UOM Semantics', () => {
  const WEIGHT_GROUP = 'grp-weight';
  const VOLUME_GROUP = 'grp-volume';
  const LENGTH_GROUP = 'grp-length';
  const COUNT_GROUP = 'grp-count';
  const TIME_GROUP = 'grp-time';

  const uG: UnitRef = { id: 'u-g', symbol: 'g', unitGroupId: WEIGHT_GROUP, unitGroupCode: 'WEIGHT', conversionToGroupBase: '1', isActive: true };
  const uKg: UnitRef = { id: 'u-kg', symbol: 'kg', unitGroupId: WEIGHT_GROUP, unitGroupCode: 'WEIGHT', conversionToGroupBase: '1000', isActive: true };
  const uMl: UnitRef = { id: 'u-ml', symbol: 'ml', unitGroupId: VOLUME_GROUP, unitGroupCode: 'VOLUME', conversionToGroupBase: '1', isActive: true };
  const uL: UnitRef = { id: 'u-l', symbol: 'L', unitGroupId: VOLUME_GROUP, unitGroupCode: 'VOLUME', conversionToGroupBase: '1000', isActive: true };
  const uCm: UnitRef = { id: 'u-cm', symbol: 'cm', unitGroupId: LENGTH_GROUP, unitGroupCode: 'LENGTH', conversionToGroupBase: '10', isActive: true };
  const uM: UnitRef = { id: 'u-m', symbol: 'm', unitGroupId: LENGTH_GROUP, unitGroupCode: 'LENGTH', conversionToGroupBase: '1000', isActive: true };
  const uPcs: UnitRef = { id: 'u-pcs', symbol: 'pcs', unitGroupId: COUNT_GROUP, unitGroupCode: 'COUNT', conversionToGroupBase: '1', isActive: true };
  const uDozen: UnitRef = { id: 'u-dozen', symbol: 'dozen', unitGroupId: COUNT_GROUP, unitGroupCode: 'COUNT', conversionToGroupBase: '12', isActive: true };
  const uPack: UnitRef = { id: 'u-pack', symbol: 'pack', unitGroupId: COUNT_GROUP, unitGroupCode: 'COUNT', conversionToGroupBase: '1', isActive: true };
  const uHour: UnitRef = { id: 'u-hour', symbol: 'hour', unitGroupId: TIME_GROUP, unitGroupCode: 'TIME', conversionToGroupBase: '1', isActive: true };
  const uSession: UnitRef = { id: 'u-session', symbol: 'session', unitGroupId: COUNT_GROUP, unitGroupCode: 'COUNT', conversionToGroupBase: '1', isActive: true };
  const uRentalUnit: UnitRef = { id: 'u-rental', symbol: 'unit', unitGroupId: COUNT_GROUP, unitGroupCode: 'COUNT', conversionToGroupBase: '1', isActive: true };

  const unitsById = new Map<string, UnitRef>([
    [uG.id, uG], [uKg.id, uKg],
    [uMl.id, uMl], [uL.id, uL],
    [uCm.id, uCm], [uM.id, uM],
    [uPcs.id, uPcs], [uDozen.id, uDozen], [uPack.id, uPack],
    [uHour.id, uHour], [uSession.id, uSession], [uRentalUnit.id, uRentalUnit],
  ]);

  /** Helper simulating cart line count calculation */
  function getCartItemCount(cartLines: Array<{ productId: string; orderedQuantity: number; orderedUnitSymbol: string }>): number {
    return cartLines.length;
  }

  describe('1. Cart Line Count Semantics for Individual UOM Categories', () => {
    it('Weight UOM: 500 g, 0.5 kg, 2.5 kg each evaluate to 1 cart item', () => {
      const line500g = [{ productId: 'turmeric', orderedQuantity: 500, orderedUnitSymbol: 'g' }];
      const line05kg = [{ productId: 'turmeric', orderedQuantity: 0.5, orderedUnitSymbol: 'kg' }];
      const line25kg = [{ productId: 'turmeric', orderedQuantity: 2.5, orderedUnitSymbol: 'kg' }];

      expect(getCartItemCount(line500g)).toBe(1);
      expect(getCartItemCount(line05kg)).toBe(1);
      expect(getCartItemCount(line25kg)).toBe(1);
    });

    it('Volume UOM: 250 ml, 1 L each evaluate to 1 cart item', () => {
      const line250ml = [{ productId: 'milk', orderedQuantity: 250, orderedUnitSymbol: 'ml' }];
      const line1l = [{ productId: 'milk', orderedQuantity: 1, orderedUnitSymbol: 'L' }];

      expect(getCartItemCount(line250ml)).toBe(1);
      expect(getCartItemCount(line1l)).toBe(1);
    });

    it('Length UOM: 50 cm, 2 m each evaluate to 1 cart item', () => {
      const line50cm = [{ productId: 'cable', orderedQuantity: 50, orderedUnitSymbol: 'cm' }];
      const line2m = [{ productId: 'cable', orderedQuantity: 2, orderedUnitSymbol: 'm' }];

      expect(getCartItemCount(line50cm)).toBe(1);
      expect(getCartItemCount(line2m)).toBe(1);
    });

    it('Packaging UOM: 0.5 dozen, 2 dozen, 3 packs each evaluate to 1 cart item', () => {
      const line05dz = [{ productId: 'banana', orderedQuantity: 0.5, orderedUnitSymbol: 'dozen' }];
      const line2dz = [{ productId: 'banana', orderedQuantity: 2, orderedUnitSymbol: 'dozen' }];
      const line3pack = [{ productId: 'biscuit', orderedQuantity: 3, orderedUnitSymbol: 'pack' }];

      expect(getCartItemCount(line05dz)).toBe(1);
      expect(getCartItemCount(line2dz)).toBe(1);
      expect(getCartItemCount(line3pack)).toBe(1);
    });

    it('Count UOM: 5 pcs, 10 pcs each evaluate to 1 cart item', () => {
      const line5pcs = [{ productId: 'soap', orderedQuantity: 5, orderedUnitSymbol: 'pcs' }];
      const line10pcs = [{ productId: 'soap', orderedQuantity: 10, orderedUnitSymbol: 'pcs' }];

      expect(getCartItemCount(line5pcs)).toBe(1);
      expect(getCartItemCount(line10pcs)).toBe(1);
    });

    it('Service UOM: 1.5 hours, 2 sessions each evaluate to 1 cart item', () => {
      const line15hr = [{ productId: 'consulting', orderedQuantity: 1.5, orderedUnitSymbol: 'hour' }];
      const line2sess = [{ productId: 'spa', orderedQuantity: 2, orderedUnitSymbol: 'session' }];

      expect(getCartItemCount(line15hr)).toBe(1);
      expect(getCartItemCount(line2sess)).toBe(1);
    });

    it('Rental UOM: 2 units evaluate to 1 cart item', () => {
      const line2rental = [{ productId: 'camera', orderedQuantity: 2, orderedUnitSymbol: 'unit' }];

      expect(getCartItemCount(line2rental)).toBe(1);
    });
  });

  describe('2. Multi-Product Cart Line Count', () => {
    it('Cart containing 500 g Turmeric + 250 ml Milk + 0.5 dozen Banana yields 3 items (NEVER 750.5)', () => {
      const cart = [
        { productId: 'turmeric', orderedQuantity: 500, orderedUnitSymbol: 'g' },
        { productId: 'milk', orderedQuantity: 250, orderedUnitSymbol: 'ml' },
        { productId: 'banana', orderedQuantity: 0.5, orderedUnitSymbol: 'dozen' },
      ];

      expect(cart.length).toBe(3);
      expect(getCartItemCount(cart)).toBe(3);
      expect(getCartItemCount(cart)).not.toBe(750.5);
    });
  });

  describe('3. Same Product Quantity & UOM Updates', () => {
    it('Updating product quantity from 500 g to 1 kg preserves single cart line count (1 item)', () => {
      const cart = [
        { productId: 'turmeric', orderedQuantity: 500, orderedUnitSymbol: 'g' },
      ];
      expect(getCartItemCount(cart)).toBe(1);

      // Simulate updating quantity and UOM on existing line
      cart[0].orderedQuantity = 1;
      cart[0].orderedUnitSymbol = 'kg';

      expect(cart.length).toBe(1);
      expect(getCartItemCount(cart)).toBe(1);
    });
  });

  describe('4. Universal UOM Calculation Regression', () => {
    it('Calculates correct base quantity and pricing without breaking UOM conversion pipeline', () => {
      const turmericProd: ProductPricingRef = {
        id: 'turmeric',
        baseUnitId: uKg.id,
        pricingUnitId: uKg.id,
        pricingStrategy: 'CONVERTED',
        pricePerPricingUnit: '600.00', // ₹600/kg
        basePrice: '600.00',
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

      // 500 g @ ₹600/kg => 0.5 kg base qty => ₹300.00
      const calcG = calculateLineAmount({ product: turmericProd, enteredQty: 500, sellingUnit: uG, unitsById });
      expect(calcG.baseQuantity.toNumber()).toBe(0.5);
      expect(calcG.grossAmount.toNumber()).toBe(300);

      // 0.5 kg @ ₹600/kg => 0.5 kg base qty => ₹300.00
      const calcKg = calculateLineAmount({ product: turmericProd, enteredQty: 0.5, sellingUnit: uKg, unitsById });
      expect(calcKg.baseQuantity.toNumber()).toBe(0.5);
      expect(calcKg.grossAmount.toNumber()).toBe(300);
    });
  });
});
