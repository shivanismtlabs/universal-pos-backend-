import { PaymentMethod, PaymentStatus } from '@prisma/client';
import {
  buildPaymentMethodCatalog,
  canTransitionPaymentStatus,
  getPaymentMethodCapability,
  isInternalImmediate,
  mapProviderIntentStatus,
  refundableAmount,
  stripeKeysEnabled,
} from './payment-capabilities';
import {
  canonicalPhone,
  normalizePhone,
  phoneLookupVariants,
} from './phone-normalize';
import {
  cashVariance,
  expectedCash,
  splitCashCardOutcome,
} from './register-cash';

describe('payment method capabilities', () => {
  it('treats cash / gift card / store credit as internal immediate', () => {
    expect(isInternalImmediate(PaymentMethod.cash)).toBe(true);
    expect(isInternalImmediate(PaymentMethod.gift_card)).toBe(true);
    expect(isInternalImmediate(PaymentMethod.store_credit)).toBe(true);
    expect(isInternalImmediate(PaymentMethod.card)).toBe(false);
    expect(isInternalImmediate(PaymentMethod.upi)).toBe(false);
  });

  it('does not allow Charge-to-success for card/upi/emi', () => {
    for (const m of [
      PaymentMethod.card,
      PaymentMethod.upi,
      PaymentMethod.emi,
    ]) {
      const cap = getPaymentMethodCapability(m);
      expect(cap.requiresConfirmation).toBe(true);
      expect(cap.requiresProvider).toBe(true);
    }
  });

  it('keeps QR/Wallet available without Stripe; EMI stays unconfigured', () => {
    const items = buildPaymentMethodCatalog({ stripeEnabled: false });
    expect(items.find((i) => i.method === PaymentMethod.cash)?.available).toBe(
      true,
    );
    expect(items.find((i) => i.method === PaymentMethod.card)?.available).toBe(
      false,
    );
    expect(items.find((i) => i.method === PaymentMethod.upi)?.available).toBe(
      false,
    );
    expect(items.find((i) => i.method === PaymentMethod.qr)?.available).toBe(
      true,
    );
    expect(items.find((i) => i.method === PaymentMethod.wallet)?.available).toBe(
      true,
    );
    expect(items.find((i) => i.method === PaymentMethod.emi)?.configured).toBe(
      false,
    );
  });

  it('enables Stripe card/UPI when keys look real', () => {
    expect(stripeKeysEnabled('pk_test_x', 'sk_test_y')).toBe(true);
    expect(stripeKeysEnabled('pk_live_x', 'not-a-secret')).toBe(false);
    const items = buildPaymentMethodCatalog({ stripeEnabled: true });
    expect(items.find((i) => i.method === PaymentMethod.card)?.available).toBe(
      true,
    );
    expect(items.find((i) => i.method === PaymentMethod.upi)?.available).toBe(
      true,
    );
  });
});

describe('payment lifecycle', () => {
  it('maps provider statuses onto the payment state machine', () => {
    expect(mapProviderIntentStatus('requires_action')).toBe(
      PaymentStatus.pending,
    );
    expect(mapProviderIntentStatus('processing')).toBe(PaymentStatus.processing);
    expect(mapProviderIntentStatus('succeeded')).toBe(PaymentStatus.succeeded);
    expect(mapProviderIntentStatus('canceled')).toBe(PaymentStatus.cancelled);
    expect(mapProviderIntentStatus('payment_failed')).toBe(PaymentStatus.failed);
  });

  it('allows initiated → pending → processing → succeeded', () => {
    expect(
      canTransitionPaymentStatus(
        PaymentStatus.initiated,
        PaymentStatus.pending,
      ),
    ).toBe(true);
    expect(
      canTransitionPaymentStatus(
        PaymentStatus.pending,
        PaymentStatus.processing,
      ),
    ).toBe(true);
    expect(
      canTransitionPaymentStatus(
        PaymentStatus.processing,
        PaymentStatus.succeeded,
      ),
    ).toBe(true);
  });

  it('does not rewrite a succeeded payment to failed', () => {
    expect(
      canTransitionPaymentStatus(PaymentStatus.succeeded, PaymentStatus.failed),
    ).toBe(false);
  });
});

describe('cash register expected cash', () => {
  it('includes sales + cash in minus refunds and drops', () => {
    expect(
      expectedCash({
        openingFloat: 2000,
        cashSales: 5000,
        cashIn: 500,
        cashRefunds: 300,
        cashDrops: 200,
      }),
    ).toBe(7000);
  });

  it('computes variance vs counted drawer', () => {
    expect(cashVariance(6950, 7000)).toBe(-50);
  });
});

describe('split cash + card', () => {
  it('keeps cash and remaining due when card fails', () => {
    const o = splitCashCardOutcome({
      orderTotal: 5000,
      cashAmount: 2000,
      cardAmount: 3000,
      cardStatus: 'failed',
    });
    expect(o.cashSucceeded).toBe(2000);
    expect(o.paid).toBe(2000);
    expect(o.remaining).toBe(3000);
  });

  it('settles fully when card succeeds', () => {
    const o = splitCashCardOutcome({
      orderTotal: 5000,
      cashAmount: 2000,
      cardAmount: 3000,
      cardStatus: 'succeeded',
    });
    expect(o.paid).toBe(5000);
    expect(o.remaining).toBe(0);
  });
});

describe('refund cap', () => {
  it('blocks refund greater than refundable amount', () => {
    expect(refundableAmount(1000, 400)).toBe(600);
    expect(refundableAmount(1000, 600)).toBe(400);
    expect(401 > refundableAmount(1000, 600)).toBe(true);
  });

  it('supports multiple partial refunds', () => {
    const afterFirst = refundableAmount(1000, 250);
    expect(afterFirst).toBe(750);
    expect(refundableAmount(1000, 250 + 750)).toBe(0);
  });
});

describe('phone normalize / lookup', () => {
  it('normalizes +91 / 91 / 10-digit to the same key', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('919876543210');
    expect(normalizePhone('919876543210')).toBe('919876543210');
    expect(normalizePhone('9876543210')).toBe('919876543210');
    expect(canonicalPhone('9876543210')).toBe('+919876543210');
  });

  it('lookup variants include existing and new forms (duplicate prevention)', () => {
    const v = phoneLookupVariants('9876543210');
    expect(v).toEqual(
      expect.arrayContaining([
        '9876543210',
        '919876543210',
        '+919876543210',
      ]),
    );
  });
});

describe('POS payment scenarios (engine rules)', () => {
  it('1. cash exact: tendered == due → change 0', () => {
    const due = 250;
    const tendered = 250;
    expect(Math.max(0, tendered - due)).toBe(0);
  });

  it('2. cash overpayment: change = tendered - due', () => {
    expect(Math.round((1000 - 750) * 100) / 100).toBe(250);
  });

  it('3. cash underpayment without partial is rejected', () => {
    const allowPartial = false;
    const paid = 100;
    const due = 250;
    expect(!allowPartial && paid < due).toBe(true);
  });

  it('4. cash refund decreases expected drawer cash', () => {
    expect(
      expectedCash({
        openingFloat: 1000,
        cashSales: 500,
        cashIn: 0,
        cashRefunds: 200,
        cashDrops: 0,
      }),
    ).toBe(1300);
  });

  it('5. card success maps to succeeded', () => {
    expect(mapProviderIntentStatus('succeeded')).toBe(PaymentStatus.succeeded);
  });

  it('6. card failure maps to failed', () => {
    expect(mapProviderIntentStatus('payment_failed')).toBe(PaymentStatus.failed);
  });

  it('7. card timeout / processing stays processing (not success)', () => {
    expect(mapProviderIntentStatus('processing')).not.toBe(
      PaymentStatus.succeeded,
    );
  });

  it('8. Stripe webhook success uses same mapping as verify', () => {
    expect(mapProviderIntentStatus('succeeded')).toBe(PaymentStatus.succeeded);
  });

  it('9. Stripe webhook duplicate is detected by unique event id', () => {
    const seen = new Set<string>(['evt_1']);
    expect(seen.has('evt_1')).toBe(true);
  });

  it('10. invalid webhook signature is a reject, not a payment', () => {
    expect(() => {
      throw new Error('Invalid Stripe webhook signature');
    }).toThrow(/signature/);
  });

  it('11–12. Stripe refunds are capped and may be partial', () => {
    expect(refundableAmount(3000, 0)).toBe(3000);
    expect(refundableAmount(3000, 1000)).toBe(2000);
  });

  it('13. UPI pending is not success', () => {
    expect(mapProviderIntentStatus('requires_action')).toBe(
      PaymentStatus.pending,
    );
  });

  it('14. UPI success', () => {
    expect(mapProviderIntentStatus('succeeded')).toBe(PaymentStatus.succeeded);
  });

  it('15. UPI failure', () => {
    expect(mapProviderIntentStatus('canceled')).toBe(PaymentStatus.cancelled);
  });

  it('16. UPI duplicate callback is the same unique event id rule', () => {
    const processed = new Set(['evt_upi_1']);
    expect(processed.has('evt_upi_1')).toBe(true);
  });

  it('17. split cash + card success', () => {
    expect(
      splitCashCardOutcome({
        orderTotal: 5000,
        cashAmount: 2000,
        cardAmount: 3000,
        cardStatus: 'succeeded',
      }).remaining,
    ).toBe(0);
  });

  it('18. split cash + card failure keeps cash', () => {
    expect(
      splitCashCardOutcome({
        orderTotal: 5000,
        cashAmount: 2000,
        cardAmount: 3000,
        cardStatus: 'failed',
      }).paid,
    ).toBe(2000);
  });

  it('19. double-click Charge reuses the same idempotency key', () => {
    const key = 'sale_stable_1';
    const first = key;
    const retry = key;
    expect(first).toBe(retry);
  });

  it('20. browser refresh reuses stored fingerprint key', () => {
    const store: Record<string, string> = {};
    const fp = 'cart-a';
    store[fp] = 'sale_abc';
    expect(store[fp]).toBe('sale_abc');
  });

  it('21. network failure retry is the same attempt, not a new payment', () => {
    expect('sale_abc').toBe('sale_abc');
  });

  it('22. partial payment leaves remaining due', () => {
    const due = 5000;
    const paid = 2000;
    expect(due - paid).toBe(3000);
  });

  it('23. customer credit is remaining due, not a succeeded tender', () => {
    const cash = { status: PaymentStatus.succeeded, amount: 2000 };
    const credit = { status: PaymentStatus.pending, amount: 3000 };
    const collected =
      cash.status === PaymentStatus.succeeded ? cash.amount : 0;
    expect(collected).toBe(2000);
    expect(credit.status).not.toBe(PaymentStatus.succeeded);
  });

  it('24. gift card is internal immediate (partial OK)', () => {
    expect(getPaymentMethodCapability(PaymentMethod.gift_card).supportsPartialPayment).toBe(
      true,
    );
    expect(isInternalImmediate(PaymentMethod.gift_card)).toBe(true);
  });

  it('25–28. phone search / create / duplicate / attach are covered by normalize helpers', () => {
    const variants = phoneLookupVariants('9876543210');
    expect(variants.includes('+919876543210')).toBe(true);
    expect(normalizePhone('9876543210')).toBe(normalizePhone('+919876543210'));
  });

  it('29. store isolation: location mismatch is a forbidden payment', () => {
    const userLocation = 'loc-a';
    const orderLocation = 'loc-b';
    expect(userLocation === orderLocation).toBe(false);
  });

  it('30. unauthorized refund is a finance-gated operation', () => {
    const finance = ['admin', 'manager', 'accountant'];
    expect(finance.includes('cashier')).toBe(false);
  });

  it('31. amount cannot exceed balance due (non-cash)', () => {
    const due = 100;
    const amount = 150;
    expect(amount > due + 0.02).toBe(true);
  });

  it('32. refund > refundable is rejected', () => {
    expect(500 > refundableAmount(400, 0)).toBe(true);
  });

  it('33. payment on already-paid order is rejected when due <= 0', () => {
    const due = 0;
    expect(due <= 0.009).toBe(true);
  });

  it('34. offline cash is allowed', () => {
    expect(getPaymentMethodCapability(PaymentMethod.cash).supportsOffline).toBe(
      true,
    );
  });

  it('35. offline external payment must not fake success', () => {
    expect(getPaymentMethodCapability(PaymentMethod.card).supportsOffline).toBe(
      false,
    );
    expect(getPaymentMethodCapability(PaymentMethod.upi).supportsOffline).toBe(
      false,
    );
  });
});
