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
});
