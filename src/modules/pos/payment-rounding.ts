import { PaymentMethod } from '@prisma/client';

/** Half-up to nearest rupee (Indian POS cash round-off). */
export function roundToNearestRupee(amount: number): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/** Delta to nearest rupee: positive adds a round-off fee, negative a write-off. */
export function cashRoundOffDelta(exactAmount: number): number {
  const exact = Math.max(0, Number(exactAmount) || 0);
  const rounded = roundToNearestRupee(exact);
  return Number((rounded - exact).toFixed(2));
}

export function isSoleCashPayment(
  payments: Array<{ method: PaymentMethod }> | undefined,
): boolean {
  return (
    (payments?.length ?? 0) === 1 &&
    payments![0]!.method === PaymentMethod.cash
  );
}

/**
 * Cash-only nearest-rupee round-off.
 * Digital / split tenders: reject non-zero roundOffAmount; return undefined.
 */
export function resolveCashRoundOffAmount(
  roundOffAmount: number | undefined,
  payments: Array<{ method: PaymentMethod }> | undefined,
  exactBalanceDue: number,
): number | undefined {
  const soleCash = isSoleCashPayment(payments);
  const expected = cashRoundOffDelta(exactBalanceDue);
  const sent = Number(roundOffAmount ?? 0);
  const hasSent = Number.isFinite(sent) && Math.abs(sent) >= 0.005;

  if (!soleCash) {
    if (hasSent) {
      throw new Error('Round off applies only when the full payment is cash');
    }
    return undefined;
  }

  if (hasSent) {
    if (Math.abs(sent) > 0.99) {
      throw new Error('Round off must be within ±0.99');
    }
    if (Math.abs(sent - expected) > 0.011) {
      throw new Error(
        `Round off ${sent.toFixed(2)} does not match expected ${expected.toFixed(2)} for balance ${Number(exactBalanceDue).toFixed(2)}`,
      );
    }
    return Number(sent.toFixed(2));
  }

  if (Math.abs(expected) >= 0.005) {
    return expected;
  }
  return undefined;
}
