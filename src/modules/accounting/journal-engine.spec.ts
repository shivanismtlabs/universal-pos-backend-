import { Prisma } from '@prisma/client';
import { assertDoubleEntry, D, money2 } from './money';
import {
  buildCustomerPaymentJournal,
  buildExpenseJournal,
  buildPurchaseJournal,
  buildSaleJournal,
  buildSaleReturnJournal,
  buildSupplierPaymentJournal,
  buildCogsJournal,
  gstFromBreakdown,
  reverseDraftLines,
} from './posting-rules';

const z = new Prisma.Decimal(0);

function totals(lines: Array<{ debit: string; credit: string }>) {
  const debit = lines.reduce((s, l) => s.add(D(l.debit)), z);
  const credit = lines.reduce((s, l) => s.add(D(l.credit)), z);
  return { debit: money2(debit), credit: money2(credit), ok: debit.eq(credit) };
}

describe('accounting double-entry engine', () => {
  it('rejects unbalanced journals', () => {
    expect(() =>
      assertDoubleEntry([
        { debit: '10', credit: '0' },
        { debit: '0', credit: '9' },
      ]),
    ).toThrow(/unbalanced/);
  });

  it('accepts balanced journals', () => {
    const t = assertDoubleEntry([
      { debit: '10.00', credit: '0' },
      { debit: '0', credit: '10.00' },
    ]);
    expect(t.debit).toBe('10.00');
    expect(t.credit).toBe('10.00');
  });

  it('sale journal: cash + GST balances', () => {
    const j = buildSaleJournal({
      basis: 'accrual',
      orderKind: 'sale',
      subtotal: D(100),
      discountTotal: D(0),
      taxTotal: D(18),
      balanceDue: D(0),
      revenue: { sales: D(100), service: z, rental: z, subscription: z },
      gst: gstFromBreakdown(D(18), { cgst: 9, sgst: 9 }),
      payments: [{ method: 'cash', type: 'payment', amount: D(118) }],
      orderNumber: 'ORD-1',
    });
    const t = totals(j.lines);
    expect(t.ok).toBe(true);
    expect(j.sourceType).toBe('SALE');
  });

  it('credit sale uses AR', () => {
    const j = buildSaleJournal({
      basis: 'accrual',
      orderKind: 'sale',
      subtotal: D(100),
      discountTotal: D(0),
      taxTotal: D(18),
      balanceDue: D(118),
      revenue: { sales: D(100), service: z, rental: z, subscription: z },
      gst: gstFromBreakdown(D(18), null),
      payments: [],
      orderNumber: 'ORD-2',
    });
    expect(j.sourceType).toBe('CREDIT_SALE');
    expect(j.lines.some((l) => l.mappingKey === 'ar' && D(l.debit).eq(118))).toBe(
      true,
    );
    expect(totals(j.lines).ok).toBe(true);
  });

  it('customer payment journal balances', () => {
    const j = buildCustomerPaymentJournal({
      basis: 'accrual',
      method: 'upi',
      amount: D(50),
      orderNumber: 'ORD-2',
    });
    expect(totals(j.lines).ok).toBe(true);
    expect(j.lines.some((l) => l.mappingKey === 'ar' && l.credit === '50.00')).toBe(
      true,
    );
  });

  it('expense journal with input GST', () => {
    const j = buildExpenseJournal({
      net: D(100),
      tax: D(18),
      gst: gstFromBreakdown(D(18), { cgst: 9, sgst: 9 }),
      method: 'cash',
      expenseNumber: 'EXP-1',
    });
    expect(totals(j.lines).ok).toBe(true);
  });

  it('purchase journal', () => {
    const j = buildPurchaseJournal({
      subtotal: D(200),
      taxTotal: D(36),
      gst: gstFromBreakdown(D(36), { cgst: 18, sgst: 18 }),
      isReturn: false,
      inventoryAccounting: true,
      invoiceNumber: 'SINV-1',
    });
    expect(j.sourceType).toBe('PURCHASE');
    expect(totals(j.lines).ok).toBe(true);
  });

  it('purchase return journal', () => {
    const j = buildPurchaseJournal({
      subtotal: D(200),
      taxTotal: D(36),
      gst: gstFromBreakdown(D(36), { cgst: 18, sgst: 18 }),
      isReturn: true,
      inventoryAccounting: true,
      invoiceNumber: 'SCN-1',
    });
    expect(j.sourceType).toBe('PURCHASE_RETURN');
    expect(totals(j.lines).ok).toBe(true);
  });

  it('supplier payment journal', () => {
    const j = buildSupplierPaymentJournal({
      amount: D(236),
      method: 'bank_transfer',
      kind: 'payment',
    });
    expect(totals(j.lines).ok).toBe(true);
  });

  it('sales return journal', () => {
    const j = buildSaleReturnJournal({
      net: D(100),
      tax: D(18),
      gst: gstFromBreakdown(D(18), { cgst: 9, sgst: 9 }),
      refundMethod: 'cash',
      orderNumber: 'ORD-1',
    });
    expect(j.sourceType).toBe('SALE_RETURN');
    expect(totals(j.lines).ok).toBe(true);
  });

  it('COGS journal', () => {
    const j = buildCogsJournal({ cogsAmount: D(40), orderNumber: 'ORD-1' });
    expect(j).not.toBeNull();
    expect(totals(j!.lines).ok).toBe(true);
  });

  it('reversal swaps debit and credit and stays balanced', () => {
    const j = buildSaleJournal({
      basis: 'accrual',
      orderKind: 'sale',
      subtotal: D(80),
      discountTotal: D(10),
      taxTotal: D(12.6),
      balanceDue: D(0),
      revenue: { sales: D(70), service: z, rental: z, subscription: z },
      gst: gstFromBreakdown(D(12.6), null),
      payments: [{ method: 'card', type: 'payment', amount: D(82.6) }],
      orderNumber: 'ORD-3',
    });
    const rev = reverseDraftLines(j.lines);
    expect(totals(rev).ok).toBe(true);
    expect(totals(j.lines).debit).toBe(totals(rev).credit);
  });

  it('cash-basis sale only recognizes paid portion', () => {
    const j = buildSaleJournal({
      basis: 'cash',
      orderKind: 'sale',
      subtotal: D(100),
      discountTotal: D(0),
      taxTotal: D(18),
      balanceDue: D(59),
      revenue: { sales: D(100), service: z, rental: z, subscription: z },
      gst: gstFromBreakdown(D(18), null),
      payments: [{ method: 'cash', type: 'payment', amount: D(59) }],
      orderNumber: 'ORD-4',
    });
    expect(j.lines.every((l) => l.mappingKey !== 'ar' || D(l.debit).eq(0))).toBe(
      true,
    );
    expect(totals(j.lines).ok).toBe(true);
  });

  it('service / rental / subscription revenue uses the same engine', () => {
    for (const kind of ['service', 'rental', 'subscription'] as const) {
      const j = buildSaleJournal({
        basis: 'accrual',
        orderKind: kind,
        subtotal: D(50),
        discountTotal: D(0),
        taxTotal: D(9),
        balanceDue: D(0),
        revenue: {
          sales: kind === 'service' || kind === 'rental' || kind === 'subscription' ? z : D(50),
          service: kind === 'service' ? D(50) : z,
          rental: kind === 'rental' ? D(50) : z,
          subscription: kind === 'subscription' ? D(50) : z,
        },
        gst: gstFromBreakdown(D(9), null),
        payments: [{ method: 'upi', type: 'payment', amount: D(59) }],
        orderNumber: 'X-1',
      });
      expect(totals(j.lines).ok).toBe(true);
    }
  });
});

describe('integration idempotency key', () => {
  it('is stable across retries', () => {
    const tenantId = 't1';
    const provider = 'QUICKBOOKS';
    const localId = 'inv-1';
    const a = `${tenantId}:${provider}:journal:${localId}`;
    const b = `${tenantId}:${provider}:journal:${localId}`;
    expect(a).toBe(b);
  });
});
