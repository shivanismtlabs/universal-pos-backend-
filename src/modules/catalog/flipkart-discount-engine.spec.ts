import { Prisma } from '@prisma/client';
import {
  calculateLineAmount,
  ProductPricingRef,
  serializeLineCalc,
} from './pricing-engine';
import { computeReturnRefundFromOriginal } from '../pos/sale-return-math';
import { computeLineTax, buildTaxProfile } from '../../common/tax-engine';
import { calcMeta } from '../pos/pos-qty';

describe('Flipkart-Style Product Discount Engine & Rules', () => {
  const d = (n: number | string | Prisma.Decimal) => new Prisma.Decimal(n);

  describe('Core Flipkart Example Scenario', () => {
    it('calculates MRP ₹199 with 5% OFF for 5 pcs -> Product Discount ₹49.75 and Net ₹945.25', () => {
      const product: ProductPricingRef = {
        id: 'prod-1',
        name: 'Cotton T-Shirt',
        sku: 'TSHIRT-01',
        basePrice: d(199),
        mrp: d(199),
        productDiscount: {
          type: 'percentage',
          value: d(5), // 5% OFF
        },
      };

      const result = calculateLineAmount({
        product,
        enteredQty: d(5),
      });

      // MRP = 199.00
      expect(result.mrp.toFixed(2)).toBe('199.00');
      // Selling price after 5% OFF = 199 - 9.95 = 189.05
      expect(result.sellingPrice.toFixed(2)).toBe('189.05');
      // Gross MRP for 5 pcs = 199 * 5 = 995.00
      expect(result.grossMrp.toFixed(2)).toBe('995.00');
      // Product discount for 5 pcs = (199 - 189.05) * 5 = 9.95 * 5 = 49.75
      expect(result.productDiscount.toFixed(2)).toBe('49.75');
      // Product Net = Gross MRP - Product Discount = 995.00 - 49.75 = 945.25
      expect(result.productNet.toFixed(2)).toBe('945.25');
      expect(result.grossAmount.toFixed(2)).toBe('995.00');
      expect(result.productDiscountPercent).toBe(5);
      expect(result.hasProductDiscount).toBe(true);

      // Verify serialization snapshots
      const serialized = serializeLineCalc(result);
      expect(serialized.mrp).toBe('199.00');
      expect(serialized.sellingPrice).toBe('189.05');
      expect(serialized.productDiscount).toBe('49.75');
      expect(serialized.productNet).toBe('945.25');

      // Verify POS calcMeta helper
      const meta = calcMeta(result);
      expect(meta.mrp).toBe('199.00');
      expect(meta.sellingPrice).toBe('189.05');
      expect(meta.productDiscount).toBe('49.75');
      expect(meta.productNet).toBe('945.25');
    });
  });

  describe('Independent Selling Price & Explicit Discount Rules', () => {
    it('supports fixed amount discount per unit', () => {
      const product: ProductPricingRef = {
        id: 'prod-2',
        name: 'Headphones',
        sku: 'HEADPHONE-01',
        basePrice: d(1500),
        mrp: d(2000),
        productDiscount: {
          type: 'fixed_amount',
          value: d(300), // Fixed ₹300 OFF per unit
        },
      };

      const result = calculateLineAmount({
        product,
        enteredQty: d(2),
      });

      // MRP = 2000
      expect(result.mrp.toFixed(2)).toBe('2000.00');
      // Selling price = 2000 - 300 = 1700
      expect(result.sellingPrice.toFixed(2)).toBe('1700.00');
      // Gross MRP = 4000
      expect(result.grossMrp.toFixed(2)).toBe('4000.00');
      // Product discount = 600
      expect(result.productDiscount.toFixed(2)).toBe('600.00');
      // Net = 3400
      expect(result.productNet.toFixed(2)).toBe('3400.00');
    });

    it('respects effective date window (active vs expired)', () => {
      const pastWindowProduct: ProductPricingRef = {
        id: 'prod-3',
        name: 'Diwali Special Sweet',
        sku: 'SWEET-01',
        basePrice: d(500),
        mrp: d(500),
        productDiscount: {
          type: 'percentage',
          value: d(20),
          startDate: new Date('2020-01-01'),
          endDate: new Date('2020-01-10'),
        },
      };

      const resultExpired = calculateLineAmount({
        product: pastWindowProduct,
        enteredQty: d(1),
      });

      // Expired discount should not apply
      expect(resultExpired.hasProductDiscount).toBe(false);
      expect(resultExpired.sellingPrice.toFixed(2)).toBe('500.00');
      expect(resultExpired.productDiscount.toFixed(2)).toBe('0.00');
      expect(resultExpired.productNet.toFixed(2)).toBe('500.00');
    });

    it('respects quantity limits (e.g. max 2 units at discounted rate)', () => {
      const product: ProductPricingRef = {
        id: 'prod-4',
        name: 'Flash Sale Item',
        sku: 'FLASH-01',
        basePrice: d(100),
        mrp: d(100),
        productDiscount: {
          type: 'fixed_amount',
          value: d(20), // ₹20 OFF
          maxQuantity: d(2), // Only first 2 units get discount
        },
      };

      const result = calculateLineAmount({
        product,
        enteredQty: d(5), // Buying 5 units
      });

      // Gross MRP = 100 * 5 = 500
      expect(result.grossMrp.toFixed(2)).toBe('500.00');
      // Product discount = 20 * 2 = 40 (capped at 2 qty)
      expect(result.productDiscount.toFixed(2)).toBe('40.00');
      // Product Net = 500 - 40 = 460
      expect(result.productNet.toFixed(2)).toBe('460.00');
      // Effective selling price per unit = 460 / 5 = 92.00
      expect(result.sellingPrice.toFixed(2)).toBe('92.00');
    });

    it('respects customer tier and tag eligibility', () => {
      const product: ProductPricingRef = {
        id: 'prod-5',
        name: 'VIP Member Exclusive Product',
        sku: 'VIP-01',
        basePrice: d(1000),
        mrp: d(1000),
        productDiscount: {
          type: 'percentage',
          value: d(15),
          customerTiers: ['VIP', 'GOLD'],
        },
      };

      // Non-VIP customer
      const nonVip = calculateLineAmount({
        product,
        enteredQty: d(1),
        customer: { id: 'cust-1', tier: 'SILVER', tags: [] },
      });
      expect(nonVip.hasProductDiscount).toBe(false);
      expect(nonVip.productNet.toFixed(2)).toBe('1000.00');

      // VIP customer
      const vip = calculateLineAmount({
        product,
        enteredQty: d(1),
        customer: { id: 'cust-2', tier: 'VIP', tags: [] },
      });
      expect(vip.hasProductDiscount).toBe(true);
      expect(vip.productNet.toFixed(2)).toBe('850.00');
      expect(vip.productDiscount.toFixed(2)).toBe('150.00');
    });
  });

  describe('Tax & Bill Discount Separation (Rules 7, 8, 9, 10)', () => {
    it('applies productNet -> bill discount allocation -> taxable value -> GST with no double deduction', () => {
      const taxProfile = buildTaxProfile({
        taxMode: 'gst',
        settings: {
          taxMode: 'gst',
          taxInclusive: false, // GST exclusive
          gstRatePercent: 18,
        },
      });

      // Product with 5% product discount
      const product: ProductPricingRef = {
        id: 'prod-6',
        name: 'Apparel',
        sku: 'APP-01',
        basePrice: d(199),
        mrp: d(199),
        productDiscount: {
          type: 'percentage',
          value: d(5),
        },
      };

      const calc = calculateLineAmount({
        product,
        enteredQty: d(5),
      });

      // ProductNet is 945.25
      const productNet = calc.productNet;
      expect(productNet.toFixed(2)).toBe('945.25');

      // Apply Bill discount of ₹45.25
      const billDiscount = d(45.25);
      const taxableBase = productNet.sub(billDiscount); // 900.00
      expect(taxableBase.toFixed(2)).toBe('900.00');

      // GST 18% on ₹900.00 = ₹162.00
      const taxed = computeLineTax(taxProfile, {
        lineGross: taxableBase,
        inclusive: false,
        rate: 0.18,
      });

      expect(taxed.lineTotal.toFixed(2)).toBe('900.00');
      expect(taxed.taxAmount.toFixed(2)).toBe('162.00');

      const finalPayable = taxed.lineTotal.add(taxed.taxAmount);
      expect(finalPayable.toFixed(2)).toBe('1062.00');
    });

    it('extracts GST accurately for tax-inclusive pricing from productNet', () => {
      const taxProfile = buildTaxProfile({
        taxMode: 'gst',
        settings: {
          taxMode: 'gst',
          taxInclusive: true, // GST inclusive
          gstRatePercent: 18,
        },
      });

      const product: ProductPricingRef = {
        id: 'prod-7',
        name: 'Inclusive Goods',
        sku: 'INC-01',
        basePrice: d(118),
        mrp: d(118),
        productDiscount: {
          type: 'fixed_amount',
          value: d(18), // ₹18 off => ₹100 selling price incl tax
        },
      };

      const calc = calculateLineAmount({
        product,
        enteredQty: d(1),
      });

      expect(calc.productNet.toFixed(2)).toBe('100.00');

      const taxed = computeLineTax(taxProfile, {
        lineGross: calc.productNet,
        inclusive: true,
        rate: 0.18,
      });

      // Taxable = 100 / 1.18 = 84.75, Tax = 15.25
      expect(taxed.lineTotal.toFixed(2)).toBe('84.75');
      expect(taxed.taxAmount.toFixed(2)).toBe('15.25');
      expect(taxed.lineTotal.add(taxed.taxAmount).toFixed(2)).toBe('100.00');
    });
  });

  describe('Historical Snapshot & Return / Refund Integrity (Rules 12, 13, 16)', () => {
    it('refunds returned item using original order snapshot without double discount', () => {
      // Sold 5 pcs @ Selling Price ₹189.05 (Net ₹945.25, Tax ₹0) with ₹45.25 bill discount
      // Total order paid: ₹900.00
      const refundCalc = computeReturnRefundFromOriginal({
        orderSubtotal: 945.25,
        orderTaxTotal: 0,
        orderDiscountTotal: 45.25, // Bill discount
        soldItems: [
          {
            stockLevelId: 'stock-1',
            quantity: 5,
            unitPrice: 189.05,
            lineTotal: 945.25,
            taxAmount: 0,
          },
        ],
        returnItems: [
          {
            stockLevelId: 'stock-1',
            quantity: 2, // Returning 2 out of 5
          },
        ],
      });

      // 2 pcs merchandise share = 189.05 * 2 = 378.10
      // Allocated bill discount for 2 pcs = 45.25 * (378.10 / 945.25) = 18.10
      // Refund amount = 378.10 - 18.10 = 360.00
      expect(refundCalc.lines[0].netShare).toBe(378.1);
      expect(refundCalc.lines[0].discountShare).toBe(18.1);
      expect(refundCalc.lines[0].refundShare).toBe(360);
      expect(refundCalc.amount).toBe(360);
    });
  });
});
