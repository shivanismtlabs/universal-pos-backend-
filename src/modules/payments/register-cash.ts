export type RegisterExpectedCashInput = {
  openingFloat: number;
  cashSales: number;
  cashIn: number;
  cashRefunds: number;
  cashDrops: number;
};

export function expectedCash(input: RegisterExpectedCashInput): number {
  const n =
    input.openingFloat +
    input.cashSales +
    input.cashIn -
    input.cashRefunds -
    input.cashDrops;
  return Math.round(n * 100) / 100;
}

export function cashVariance(actual: number, expected: number): number {
  return Math.round((actual - expected) * 100) / 100;
}

export type SplitTenderOutcome = {
  cashSucceeded: number;
  cardStatus: 'succeeded' | 'failed' | 'cancelled' | 'pending';
  cardAmount: number;
  paid: number;
  remaining: number;
};

/** Independent tenders: failed card does not unwind succeeded cash. */
export function splitCashCardOutcome(args: {
  orderTotal: number;
  cashAmount: number;
  cardAmount: number;
  cardStatus: SplitTenderOutcome['cardStatus'];
}): SplitTenderOutcome {
  const cashSucceeded = Math.max(0, args.cashAmount);
  const cardCollected =
    args.cardStatus === 'succeeded' ? Math.max(0, args.cardAmount) : 0;
  const paid = Math.round((cashSucceeded + cardCollected) * 100) / 100;
  const remaining = Math.max(
    0,
    Math.round((args.orderTotal - paid) * 100) / 100,
  );
  return {
    cashSucceeded,
    cardStatus: args.cardStatus,
    cardAmount: args.cardAmount,
    paid,
    remaining,
  };
}
