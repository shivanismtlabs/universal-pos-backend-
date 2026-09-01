import { PaymentMethod } from '@prisma/client';
import {
  cashRoundOffDelta,
  resolveCashRoundOffAmount,
  roundToNearestRupee,
} from './payment-rounding';

describe('payment-rounding', () => {
  it('rounds half-up to nearest rupee', () => {
    expect(roundToNearestRupee(100.75)).toBe(101);
    expect(roundToNearestRupee(100.49)).toBe(100);
    expect(cashRoundOffDelta(100.75)).toBe(0.25);
    expect(cashRoundOffDelta(100.49)).toBe(-0.49);
  });

  it('auto-computes cash round-off for sole cash', () => {
    const payments = [{ method: PaymentMethod.cash }];
    expect(resolveCashRoundOffAmount(undefined, payments, 100.75)).toBe(0.25);
    expect(resolveCashRoundOffAmount(0.25, payments, 100.75)).toBe(0.25);
  });

  it('rejects round-off for digital payments', () => {
    expect(() =>
      resolveCashRoundOffAmount(0.25, [{ method: PaymentMethod.upi }], 100.75),
    ).toThrow(/cash/i);
    expect(
      resolveCashRoundOffAmount(undefined, [{ method: PaymentMethod.card }], 100.75),
    ).toBeUndefined();
  });

  it('rejects mismatched round-off delta', () => {
    expect(() =>
      resolveCashRoundOffAmount(0.5, [{ method: PaymentMethod.cash }], 100.75),
    ).toThrow(/does not match expected/i);
  });
});
