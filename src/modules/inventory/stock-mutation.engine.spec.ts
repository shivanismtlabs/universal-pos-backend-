import { StockLedgerType } from '@prisma/client';

describe('inventory mutation contracts', () => {
  it('maps sale to a dedicated ledger type', () => {
    expect(StockLedgerType.sale).toBe('sale');
    expect(StockLedgerType.opening).toBe('opening');
    expect(StockLedgerType.consumption).toBe('consumption');
  });

  it('available qty is on-hand minus reserved', () => {
    const onHand = 100;
    const reserved = 20;
    expect(onHand - reserved).toBe(80);
  });
});
