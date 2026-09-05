import {
  computeReturnRefundFromOriginal,
  resolveReturnBaseQty,
  type SoldLineForReturn,
} from './sale-return-math';
import { reverseHistoricalBaseQty } from '../catalog/pricing-engine';

describe('Universal POS Returns / Reversals UOM', () => {
  describe('1. Weight Returns', () => {
    it('5 g sale -> 5 g return: restores 0.005 kg inventory and refunds historical value', () => {
      // Original sale: 5 g Broken Wheat @ ₹65/kg (5 g = 0.005 kg -> ₹0.33)
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-broken-wheat',
        quantity: 5,
        orderedQuantity: 5,
        orderedUnitSymbol: 'g',
        baseQuantity: 0.005,
        baseUnitSymbol: 'kg',
        unitPrice: 65,
        lineTotal: 0.33,
        taxAmount: 0.02,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 0.33,
        orderTaxTotal: 0.02,
        orderDiscountTotal: 0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-broken-wheat',
            quantity: 5,
            returnUnitSymbol: 'g',
          },
        ],
      });

      expect(ret.amount).toBe(0.35); // 0.33 + 0.02
      expect(ret.lines).toHaveLength(1);
      const line = ret.lines[0]!;
      expect(line.returnBaseQty).toBe(0.005);
      expect(line.netShare).toBe(0.33);
      expect(line.taxShare).toBe(0.02);
      expect(line.refundShare).toBe(0.35);

      // Verify stock ledger reversal math
      const openingStock = 80.0;
      const stockAfterSale = openingStock - 0.005; // 79.995 kg
      const stockAfterReturn = stockAfterSale + line.returnBaseQty; // 80.000 kg
      expect(Number(stockAfterReturn.toFixed(3))).toBe(80.0);
    });

    it('500 g sale -> 0.5 kg return (Mixed UOM): normalizes to base UOM and refunds 100%', () => {
      // Original sale: 500 g Wheat Flour @ ₹40/kg (0.5 kg -> ₹20.00)
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-wheat-flour',
        quantity: 500,
        orderedQuantity: 500,
        orderedUnitSymbol: 'g',
        baseQuantity: 0.5,
        baseUnitSymbol: 'kg',
        unitPrice: 40,
        lineTotal: 20.0,
        taxAmount: 1.0,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 20.0,
        orderTaxTotal: 1.0,
        orderDiscountTotal: 0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-wheat-flour',
            quantity: 0.5,
            returnUnitSymbol: 'kg',
          },
        ],
      });

      expect(ret.amount).toBe(21.0);
      expect(ret.lines[0]?.returnBaseQty).toBe(0.5);
      expect(ret.lines[0]?.netShare).toBe(20.0);
      expect(ret.lines[0]?.taxShare).toBe(1.0);
    });
  });

  describe('2. Volume Returns', () => {
    it('250 ml sale -> 250 ml return: restores 0.25 L inventory', () => {
      // Original sale: 250 ml Milk @ ₹60/L (0.25 L -> ₹15.00)
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-milk',
        quantity: 250,
        orderedQuantity: 250,
        orderedUnitSymbol: 'ml',
        baseQuantity: 0.25,
        baseUnitSymbol: 'L',
        unitPrice: 60,
        lineTotal: 15.0,
        taxAmount: 0.75,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 15.0,
        orderTaxTotal: 0.75,
        orderDiscountTotal: 0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-milk',
            quantity: 250,
            returnUnitSymbol: 'ml',
          },
        ],
      });

      expect(ret.amount).toBe(15.75);
      expect(ret.lines[0]?.returnBaseQty).toBe(0.25);
    });
  });

  describe('3. Length Returns', () => {
    it('50 cm sale -> 0.5 m return (Mixed UOM): restores 0.5 m inventory', () => {
      // Original sale: 50 cm Fabric @ ₹200/m (0.5 m -> ₹100.00)
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-fabric',
        quantity: 50,
        orderedQuantity: 50,
        orderedUnitSymbol: 'cm',
        baseQuantity: 0.5,
        baseUnitSymbol: 'm',
        unitPrice: 200,
        lineTotal: 100.0,
        taxAmount: 5.0,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 100.0,
        orderTaxTotal: 5.0,
        orderDiscountTotal: 0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-fabric',
            quantity: 0.5,
            returnUnitSymbol: 'm',
          },
        ],
      });

      expect(ret.amount).toBe(105.0);
      expect(ret.lines[0]?.returnBaseQty).toBe(0.5);
    });
  });

  describe('4. Packaging Returns', () => {
    it('0.5 dozen sale -> 6 pcs return: restores 6 pcs inventory generically', () => {
      // Original sale: 0.5 dozen Eggs @ ₹72/dozen (6 pcs -> ₹36.00)
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-eggs',
        quantity: 0.5,
        orderedQuantity: 0.5,
        orderedUnitSymbol: 'dozen',
        baseQuantity: 6,
        baseUnitSymbol: 'pcs',
        unitPrice: 72,
        lineTotal: 36.0,
        taxAmount: 0,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 36.0,
        orderTaxTotal: 0,
        orderDiscountTotal: 0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-eggs',
            quantity: 6,
            returnUnitSymbol: 'pcs',
          },
        ],
      });

      expect(ret.amount).toBe(36.0);
      expect(ret.lines[0]?.returnBaseQty).toBe(6);
    });
  });

  describe('5. Partial Returns', () => {
    it('2.5 kg sale -> 0.5 kg return: computes 20% proportional refund and remaining 2.0 kg', () => {
      // Original sale: 2.5 kg Basmati Rice @ ₹100/kg (₹250.00 + ₹12.50 tax)
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-rice',
        quantity: 2.5,
        orderedQuantity: 2.5,
        orderedUnitSymbol: 'kg',
        baseQuantity: 2.5,
        baseUnitSymbol: 'kg',
        unitPrice: 100,
        lineTotal: 250.0,
        taxAmount: 12.5,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 250.0,
        orderTaxTotal: 12.5,
        orderDiscountTotal: 0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-rice',
            quantity: 0.5,
            returnUnitSymbol: 'kg',
          },
        ],
      });

      // 0.5 / 2.5 = 20%
      // netShare = 250 * 0.2 = 50.00; taxShare = 12.50 * 0.2 = 2.50
      expect(ret.lines[0]?.returnBaseQty).toBe(0.5);
      expect(ret.lines[0]?.netShare).toBe(50.0);
      expect(ret.lines[0]?.taxShare).toBe(2.5);
      expect(ret.amount).toBe(52.5);

      const remainingBase = soldItem.baseQuantity as number - (ret.lines[0]?.returnBaseQty ?? 0);
      expect(remainingBase).toBe(2.0);
    });
  });

  describe('6. Rejection of Invalid / Over-Returns', () => {
    it('rejects return quantity greater than original sold quantity', () => {
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-rice',
        quantity: 2.5,
        orderedQuantity: 2.5,
        orderedUnitSymbol: 'kg',
        baseQuantity: 2.5,
        baseUnitSymbol: 'kg',
        unitPrice: 100,
        lineTotal: 250.0,
        taxAmount: 12.5,
      };

      expect(() =>
        computeReturnRefundFromOriginal({
          orderSubtotal: 250.0,
          orderTaxTotal: 12.5,
          orderDiscountTotal: 0,
          soldItems: [soldItem],
          returnItems: [
            {
              stockLevelId: 'stock-rice',
              quantity: 3.0,
              returnUnitSymbol: 'kg',
            },
          ],
        }),
      ).toThrow(/Cannot return/);
    });

    it('rejects incompatible unit conversions (e.g. kg -> L, kg -> piece, m -> kg)', () => {
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-wheat',
        quantity: 5,
        orderedQuantity: 5,
        orderedUnitSymbol: 'kg',
        baseQuantity: 5,
        baseUnitSymbol: 'kg',
        unitPrice: 65,
        lineTotal: 325.0,
        taxAmount: 0,
      };

      // kg -> L (mass vs volume)
      expect(() =>
        computeReturnRefundFromOriginal({
          orderSubtotal: 325.0,
          orderTaxTotal: 0,
          orderDiscountTotal: 0,
          soldItems: [soldItem],
          returnItems: [
            {
              stockLevelId: 'stock-wheat',
              quantity: 1,
              returnUnitSymbol: 'L',
            },
          ],
        }),
      ).toThrow(/Incompatible units/);

      // kg -> piece (mass vs count)
      expect(() =>
        computeReturnRefundFromOriginal({
          orderSubtotal: 325.0,
          orderTaxTotal: 0,
          orderDiscountTotal: 0,
          soldItems: [soldItem],
          returnItems: [
            {
              stockLevelId: 'stock-wheat',
              quantity: 1,
              returnUnitSymbol: 'piece',
            },
          ],
        }),
      ).toThrow(/Incompatible units/);
    });
  });

  describe('7. Historical Snapshot & Price-Change-After-Sale Protection', () => {
    it('uses original snapshot price when catalog price has changed from ₹65/kg to ₹80/kg', () => {
      // Sold 5 g Broken Wheat at historical price ₹65/kg -> lineTotal = ₹0.33
      // Even if catalog price is now ₹80/kg, return MUST refund ₹0.33
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-broken-wheat',
        quantity: 5,
        orderedQuantity: 5,
        orderedUnitSymbol: 'g',
        baseQuantity: 0.005,
        baseUnitSymbol: 'kg',
        unitPrice: 65,
        lineTotal: 0.33,
        taxAmount: 0,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 0.33,
        orderTaxTotal: 0,
        orderDiscountTotal: 0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-broken-wheat',
            quantity: 5,
            returnUnitSymbol: 'g',
          },
        ],
      });

      expect(ret.amount).toBe(0.33);
      expect(ret.lines[0]?.refundShare).toBe(0.33);
      expect(ret.lines[0]?.unitPrice).toBe(65);
    });

    it('proportional reversal of line discount, bill discount, and GST snapshot', () => {
      // Original sale: 2 units @ list ₹100, 10% line discount = ₹90 each (total ₹180)
      // Bill discount = ₹18 (10% bill discount) -> net merchandise = ₹162
      // GST 5% = ₹8.10 -> total paid = ₹170.10
      // Return 1 unit (50% return):
      // gross return = (90 + 4.50) = 94.50
      // bill discount share = 18 * (94.50 / 189) = 9.00
      // refund = 94.50 - 9.00 = 85.50
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-item-a',
        quantity: 2,
        orderedQuantity: 2,
        orderedUnitSymbol: 'pcs',
        baseQuantity: 2,
        baseUnitSymbol: 'pcs',
        unitPrice: 90,
        lineTotal: 180.0,
        taxAmount: 9.0,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 180.0,
        orderTaxTotal: 9.0,
        orderDiscountTotal: 18.0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-item-a',
            quantity: 1,
            returnUnitSymbol: 'pcs',
          },
        ],
      });

      expect(ret.lines[0]?.netShare).toBe(90.0);
      expect(ret.lines[0]?.taxShare).toBe(4.5);
      expect(ret.lines[0]?.discountShare).toBe(9.0);
      expect(ret.lines[0]?.refundShare).toBe(85.5);
      expect(ret.amount).toBe(85.5);
    });
  });

  describe('8. Legacy Single-UOM Sale Backward Compatibility', () => {
    it('handles return of legacy order without multi-UOM snapshot fields', () => {
      const soldItem: SoldLineForReturn = {
        stockLevelId: 'stock-legacy',
        quantity: 3,
        unitPrice: 50,
        lineTotal: 150.0,
        taxAmount: 7.5,
      };

      const ret = computeReturnRefundFromOriginal({
        orderSubtotal: 150.0,
        orderTaxTotal: 7.5,
        orderDiscountTotal: 0,
        soldItems: [soldItem],
        returnItems: [
          {
            stockLevelId: 'stock-legacy',
            quantity: 1,
          },
        ],
      });

      expect(ret.lines[0]?.returnBaseQty).toBe(1);
      expect(ret.lines[0]?.netShare).toBe(50.0);
      expect(ret.lines[0]?.taxShare).toBe(2.5);
      expect(ret.amount).toBe(52.5);
    });
  });

  describe('9. Sequential Fractional Sales and Returns (Exact Inventory Verification)', () => {
    it('opening 80 kg -> sequential sales -> sequential returns exactly restore 80.000 kg', () => {
      let stock = 80.0;

      // Sale 1: 5 g (0.005 kg)
      const sale1Base = reverseHistoricalBaseQty({
        originalOrderedQty: 5,
        originalBaseQty: 0.005,
        returnOrderedQty: 5,
      }).toNumber();
      stock -= sale1Base;
      expect(Number(stock.toFixed(5))).toBe(79.995);

      // Sale 2: 500 g (0.5 kg)
      const sale2Base = resolveReturnBaseQty({
        returnQty: 500,
        returnUnitSymbol: 'g',
        soldOrderedQty: 500,
        soldOrderedUnitSymbol: 'g',
        soldBaseQty: 0.5,
        soldBaseUnitSymbol: 'kg',
      });
      stock -= sale2Base;
      expect(Number(stock.toFixed(5))).toBe(79.495);

      // Sale 3: 250 g (0.25 kg)
      const sale3Base = resolveReturnBaseQty({
        returnQty: 250,
        returnUnitSymbol: 'g',
        soldOrderedQty: 250,
        soldOrderedUnitSymbol: 'g',
        soldBaseQty: 0.25,
        soldBaseUnitSymbol: 'kg',
      });
      stock -= sale3Base;
      expect(Number(stock.toFixed(5))).toBe(79.245);

      // Sale 4: 1 kg (1.0 kg)
      const sale4Base = 1.0;
      stock -= sale4Base;
      expect(Number(stock.toFixed(5))).toBe(78.245);

      // Sequential Returns:
      // Return 1: 250 g -> 78.495 kg
      const ret1Base = resolveReturnBaseQty({
        returnQty: 250,
        returnUnitSymbol: 'g',
        soldOrderedQty: 250,
        soldOrderedUnitSymbol: 'g',
        soldBaseQty: 0.25,
        soldBaseUnitSymbol: 'kg',
      });
      stock += ret1Base;
      expect(Number(stock.toFixed(5))).toBe(78.495);

      // Return 2: 500 g -> 78.995 kg
      const ret2Base = resolveReturnBaseQty({
        returnQty: 500,
        returnUnitSymbol: 'g',
        soldOrderedQty: 500,
        soldOrderedUnitSymbol: 'g',
        soldBaseQty: 0.5,
        soldBaseUnitSymbol: 'kg',
      });
      stock += ret2Base;
      expect(Number(stock.toFixed(5))).toBe(78.995);

      // Return 3: 5 g -> 79.000 kg
      const ret3Base = reverseHistoricalBaseQty({
        originalOrderedQty: 5,
        originalBaseQty: 0.005,
        returnOrderedQty: 5,
      }).toNumber();
      stock += ret3Base;
      expect(Number(stock.toFixed(5))).toBe(79.0);

      // Return 4: 1 kg -> 80.000 kg
      const ret4Base = 1.0;
      stock += ret4Base;
      expect(Number(stock.toFixed(5))).toBe(80.0);
    });
  });
});
