import { computeReturnRefundFromOriginal } from './sale-return-math';

describe('computeReturnRefundFromOriginal', () => {
  it('full return includes tax and subtracts proportional discount', () => {
    const r = computeReturnRefundFromOriginal({
      orderSubtotal: 100,
      orderTaxTotal: 5,
      orderDiscountTotal: 10.5,
      soldItems: [
        {
          stockLevelId: 'a',
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          taxAmount: 5,
        },
      ],
      returnItems: [{ stockLevelId: 'a', quantity: 1, condition: 'good' }],
    });
    // merchandise 105, discount 10.5 → full return refund 94.50
    expect(r.amount).toBe(94.5);
    expect(r.lines[0]?.taxShare).toBe(5);
    expect(r.lines[0]?.discountShare).toBe(10.5);
  });

  it('partial return scales net+tax and discount share', () => {
    const r = computeReturnRefundFromOriginal({
      orderSubtotal: 200,
      orderTaxTotal: 10,
      orderDiscountTotal: 21,
      soldItems: [
        {
          stockLevelId: 'a',
          quantity: 2,
          unitPrice: 100,
          lineTotal: 200,
          taxAmount: 10,
        },
      ],
      returnItems: [{ stockLevelId: 'a', quantity: 1 }],
    });
    // half of 210 = 105; half of discount 21 = 10.5 → 94.5
    expect(r.amount).toBe(94.5);
    expect(r.lines[0]?.quantity).toBe(1);
  });

  it('rejects oversold return qty', () => {
    expect(() =>
      computeReturnRefundFromOriginal({
        orderSubtotal: 100,
        orderTaxTotal: 0,
        orderDiscountTotal: 0,
        soldItems: [
          {
            stockLevelId: 'a',
            quantity: 1,
            unitPrice: 100,
            lineTotal: 100,
            taxAmount: 0,
          },
        ],
        returnItems: [{ stockLevelId: 'a', quantity: 2 }],
      }),
    ).toThrow(/Cannot return/);
  });

  it('same-value multi-line preserves totals', () => {
    const r = computeReturnRefundFromOriginal({
      orderSubtotal: 1000,
      orderTaxTotal: 0,
      orderDiscountTotal: 0,
      soldItems: [
        {
          stockLevelId: 'a',
          quantity: 1,
          unitPrice: 400,
          lineTotal: 400,
          taxAmount: 0,
        },
        {
          stockLevelId: 'b',
          quantity: 1,
          unitPrice: 600,
          lineTotal: 600,
          taxAmount: 0,
        },
      ],
      returnItems: [
        { stockLevelId: 'a', quantity: 1 },
        { stockLevelId: 'b', quantity: 1 },
      ],
    });
    expect(r.amount).toBe(1000);
  });

  it('line discount already in unitPrice is not double-counted', () => {
    // List ₹100, 10% line discount → sold at ₹90; no bill discount
    const r = computeReturnRefundFromOriginal({
      orderSubtotal: 180,
      orderTaxTotal: 0,
      orderDiscountTotal: 0,
      soldItems: [
        {
          stockLevelId: 'a',
          quantity: 2,
          unitPrice: 90,
          lineTotal: 180,
          taxAmount: 0,
        },
      ],
      returnItems: [{ stockLevelId: 'a', quantity: 1 }],
    });
    expect(r.amount).toBe(90);
    expect(r.lines[0]?.discountShare).toBe(0);
  });

  it('different line discounts: returning B uses B only', () => {
    // A: ₹100 → 10% → ₹90; B: ₹200 → 20% → ₹160
    const r = computeReturnRefundFromOriginal({
      orderSubtotal: 250,
      orderTaxTotal: 0,
      orderDiscountTotal: 0,
      soldItems: [
        {
          stockLevelId: 'a',
          quantity: 1,
          unitPrice: 90,
          lineTotal: 90,
          taxAmount: 0,
        },
        {
          stockLevelId: 'b',
          quantity: 1,
          unitPrice: 160,
          lineTotal: 160,
          taxAmount: 0,
        },
      ],
      returnItems: [{ stockLevelId: 'b', quantity: 1 }],
    });
    expect(r.amount).toBe(160);
  });

  it('order-level discount allocates by merchandise share (not full discount to cheap line)', () => {
    // A ₹100, B ₹900, order discount ₹100 → return A only
    const r = computeReturnRefundFromOriginal({
      orderSubtotal: 1000,
      orderTaxTotal: 0,
      orderDiscountTotal: 100,
      soldItems: [
        {
          stockLevelId: 'a',
          quantity: 1,
          unitPrice: 100,
          lineTotal: 100,
          taxAmount: 0,
        },
        {
          stockLevelId: 'b',
          quantity: 1,
          unitPrice: 900,
          lineTotal: 900,
          taxAmount: 0,
        },
      ],
      returnItems: [{ stockLevelId: 'a', quantity: 1 }],
    });
    // A share of discount = 100 * (100/1000) = 10 → refund 90
    expect(r.amount).toBe(90);
    expect(r.lines[0]?.discountShare).toBe(10);
  });

  it('partial qty of discounted multi-unit line (5 of 25)', () => {
    // Stored invoice: lineTotal 3577.50 + tax 178.88 for 25 units after line discount
    const r = computeReturnRefundFromOriginal({
      orderSubtotal: 3577.5,
      orderTaxTotal: 178.88,
      orderDiscountTotal: 0,
      soldItems: [
        {
          stockLevelId: 'milk',
          quantity: 25,
          unitPrice: 143.1,
          lineTotal: 3577.5,
          taxAmount: 178.88,
        },
      ],
      returnItems: [{ stockLevelId: 'milk', quantity: 5 }],
    });
    // 5/25 of (3577.50 + 178.88) = 751.276 → 751.28
    expect(r.amount).toBe(751.28);
    expect(r.lines[0]?.quantity).toBe(5);
  });

  it('rejects unknown stock line', () => {
    expect(() =>
      computeReturnRefundFromOriginal({
        orderSubtotal: 100,
        orderTaxTotal: 0,
        orderDiscountTotal: 0,
        soldItems: [
          {
            stockLevelId: 'a',
            quantity: 1,
            unitPrice: 100,
            lineTotal: 100,
            taxAmount: 0,
          },
        ],
        returnItems: [{ stockLevelId: 'missing', quantity: 1 }],
      }),
    ).toThrow(/was not on this sale/);
  });
});
