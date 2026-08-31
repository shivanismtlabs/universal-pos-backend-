/** Purchase-order qty, totals, and status rules — shared by service + tests. */

export const QTY_EPS = 1e-8;

export function roundMoney(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function roundQty(n: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e8) / 1e8;
}

export function parsePositiveQty(n: unknown, label = 'Quantity'): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v) || v <= QTY_EPS) {
    throw new Error(`${label} must be greater than 0`);
  }
  return v;
}

export function remainingQty(ordered: number, received: number): number {
  const rem = Number(ordered) - Number(received);
  return rem <= QTY_EPS ? 0 : roundQty(rem);
}

export function assertReceiveFits(
  qty: number,
  remaining: number,
  sku?: string,
): void {
  if (qty > remaining + QTY_EPS) {
    const where = sku ? ` (${sku})` : '';
    throw new Error(
      `Cannot receive ${roundQty(qty)}${where}; only ${roundQty(remaining)} remaining on this PO line`,
    );
  }
}

export function computePoTotals(input: {
  lines: Array<{ qtyOrdered: number; unitCost?: number | null }>;
  discountAmount?: number | null;
  taxPercent?: number | null;
  /** Used when there are no stock lines (service / expense PO). */
  serviceSubtotal?: number | null;
}): {
  subtotal: number;
  discountAmount: number;
  taxPercent: number;
  taxTotal: number;
  grandTotal: number;
} {
  const taxPercent = Math.min(40, Math.max(0, Number(input.taxPercent) || 0));
  const subtotal = input.lines.length
    ? roundMoney(
        input.lines.reduce(
          (s, l) =>
            s + Number(l.qtyOrdered || 0) * Number(l.unitCost || 0),
          0,
        ),
      )
    : roundMoney(Math.max(0, Number(input.serviceSubtotal) || 0));
  const discountAmount = Math.min(
    Math.max(0, roundMoney(Number(input.discountAmount) || 0)),
    subtotal,
  );
  const taxable = Math.max(0, roundMoney(subtotal - discountAmount));
  const taxTotal = roundMoney(taxable * (taxPercent / 100));
  const grandTotal = roundMoney(taxable + taxTotal);
  return { subtotal, discountAmount, taxPercent, taxTotal, grandTotal };
}

export function canMarkOrdered(status: string): boolean {
  return status === 'draft';
}

export function canCancelPo(status: string, anyReceived: boolean): boolean {
  if (anyReceived || status === 'partial' || status === 'received') {
    return false;
  }
  return status === 'draft' || status === 'ordered';
}

export function assertPoStatusChange(
  current: string,
  next: string,
  anyReceived: boolean,
): void {
  if (!next || next === current) return;
  if (next === 'received' || next === 'partial') {
    throw new Error('Use receive to update stock — status is set from goods received');
  }
  if (next === 'draft') {
    throw new Error('Cannot reopen a PO as draft');
  }
  if (next === 'ordered' && !canMarkOrdered(current)) {
    throw new Error('Only a draft PO can be marked ordered');
  }
  if (next === 'cancelled' && !canCancelPo(current, anyReceived)) {
    throw new Error(
      'Cannot cancel after goods have been received — return to vendor first',
    );
  }
}
