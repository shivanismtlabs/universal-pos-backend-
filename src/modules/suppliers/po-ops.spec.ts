import {
  assertPoStatusChange,
  assertReceiveFits,
  canCancelPo,
  canMarkOrdered,
  computePoTotals,
  parsePositiveQty,
  remainingQty,
} from './po-ops';

describe('po-ops', () => {
  it('allows decimal qty (kg / litre / hour)', () => {
    expect(parsePositiveQty(0.5)).toBe(0.5);
    expect(parsePositiveQty('2.25')).toBe(2.25);
    expect(() => parsePositiveQty(0)).toThrow(/greater than 0/);
    expect(() => parsePositiveQty(-1)).toThrow(/greater than 0/);
  });

  it('caps receive to remaining ordered qty', () => {
    expect(remainingQty(4, 2)).toBe(2);
    expect(remainingQty(4, 4)).toBe(0);
    expect(() => assertReceiveFits(10, 2, 'APPLE')).toThrow(/only 2 remaining/);
    expect(() => assertReceiveFits(2, 2)).not.toThrow();
  });

  it('computes tax and discount on line subtotal', () => {
    const t = computePoTotals({
      lines: [
        { qtyOrdered: 2, unitCost: 50 },
        { qtyOrdered: 0.5, unitCost: 100 },
      ],
      discountAmount: 10,
      taxPercent: 18,
    });
    expect(t.subtotal).toBe(150);
    expect(t.discountAmount).toBe(10);
    expect(t.taxTotal).toBe(25.2);
    expect(t.grandTotal).toBe(165.2);
  });

  it('uses service amount when there are no stock lines', () => {
    const t = computePoTotals({
      lines: [],
      serviceSubtotal: 2000,
      taxPercent: 18,
    });
    expect(t.subtotal).toBe(2000);
    expect(t.grandTotal).toBe(2360);
  });

  it('blocks cancel after receive and ordered except from draft', () => {
    expect(canMarkOrdered('draft')).toBe(true);
    expect(canMarkOrdered('partial')).toBe(false);
    expect(canCancelPo('ordered', false)).toBe(true);
    expect(canCancelPo('partial', true)).toBe(false);
    expect(() => assertPoStatusChange('received', 'cancelled', true)).toThrow(
      /return to vendor/,
    );
    expect(() => assertPoStatusChange('draft', 'ordered', false)).not.toThrow();
  });
});
