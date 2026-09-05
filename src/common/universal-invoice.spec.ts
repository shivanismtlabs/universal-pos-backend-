import {
  mapTransactionToUniversalInvoice,
  renderUniversalInvoiceThermalHtml,
  renderUniversalInvoiceA4Html,
} from './universal-invoice';

describe('Universal Invoice / Receipt Document Engine', () => {
  const sampleShop = {
    name: 'Universal Superstore',
    tagline: 'All in One POS',
    address: '123 Commercial Plaza, Connaught Place, New Delhi',
    phone: '+91 9876543210',
    email: 'billing@universalpos.com',
    taxId: '07AAAAA0000A1Z5',
    taxLabel: 'GSTIN',
    upiVpa: 'universal@upi',
    upiPayee: 'Universal Store',
  };

  describe('1. Retail Sale (Fractional & Packaging UOM)', () => {
    it('maps fractional weight: 5 g Broken Wheat @ ₹65/kg -> ₹0.33 with equivalent 0.005 kg', () => {
      const order = {
        id: 'ord-retail-1',
        orderNumber: 'POS-RET-001',
        createdAt: '2026-09-05T10:30:00Z',
        subtotal: 0.33,
        taxTotal: 0.02,
        total: 0.35,
        items: [
          {
            name: 'Broken Wheat',
            orderedQuantity: 5,
            orderedUnitSymbol: 'g',
            baseQuantity: 0.005,
            baseUnitSymbol: 'kg',
            unitPrice: 65,
            lineTotal: 0.33,
            taxAmount: 0.02,
            taxRatePercent: 5,
            hsnOrSac: '1103',
            meta: { priceUnitSymbol: 'kg' },
          },
        ],
        payments: [{ method: 'cash', amount: 0.35, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });

      expect(doc.header.orderNumber).toBe('POS-RET-001');
      expect(doc.header.taxRegistration?.value).toBe('07AAAAA0000A1Z5');
      expect(doc.items).toHaveLength(1);

      const item = doc.items[0]!;
      expect(item.name).toBe('Broken Wheat');
      expect(item.quantity).toBe(5);
      expect(item.unitSymbol).toBe('g');
      expect(item.equivalentBaseQuantity).toBe(0.005);
      expect(item.equivalentBaseUnitSymbol).toBe('kg');
      expect(item.unitPrice).toBe(65);
      expect(item.lineTotal).toBe(0.33);
      expect(item.taxClassification?.code).toBe('1103');
      expect(item.taxClassification?.type).toBe('HSN');

      expect(doc.totals.subtotalNet).toBe(0.33);
      expect(doc.totals.taxTotal).toBe(0.02);
      expect(doc.totals.netPayable).toBe(0.35);
      expect(doc.payment.status).toBe('PAID');
    });

    it('maps packaging count: 0.5 dozen Eggs @ ₹72/dozen -> ₹36.00 with equivalent 6 pcs', () => {
      const order = {
        id: 'ord-retail-2',
        orderNumber: 'POS-RET-002',
        createdAt: '2026-09-05T11:00:00Z',
        subtotal: 36.0,
        taxTotal: 0,
        total: 36.0,
        items: [
          {
            name: 'Farm Fresh Eggs',
            orderedQuantity: 0.5,
            orderedUnitSymbol: 'dozen',
            baseQuantity: 6,
            baseUnitSymbol: 'pcs',
            unitPrice: 72,
            lineTotal: 36.0,
          },
        ],
        payments: [{ method: 'upi', amount: 36.0, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });

      const item = doc.items[0]!;
      expect(item.quantity).toBe(0.5);
      expect(item.unitSymbol).toBe('dozen');
      expect(item.equivalentBaseQuantity).toBe(6);
      expect(item.equivalentBaseUnitSymbol).toBe('pcs');
      expect(item.lineTotal).toBe(36.0);
    });
  });

  describe('2. Service Commerce', () => {
    it('maps service: Private Coaching - 8 Session Pack @ ₹10,000 with 8 sessions duration', () => {
      const order = {
        id: 'ord-service-1',
        orderNumber: 'SRV-2026-001',
        kind: 'service',
        subtotal: 10000,
        taxTotal: 1800,
        total: 11800,
        items: [
          {
            name: 'Private Swimming Coaching - 8 Session Pack',
            orderedQuantity: 1,
            orderedUnitSymbol: 'service',
            unitPrice: 10000,
            lineTotal: 10000,
            taxAmount: 1800,
            taxRatePercent: 18,
            hsnOrSac: '9992',
            meta: { sessionsCount: 8, durationLabel: '8 sessions' },
          },
        ],
        payments: [{ method: 'card', amount: 11800, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });

      expect(doc.config.documentTitle).toBe('SERVICE INVOICE');
      const item = doc.items[0]!;
      expect(item.quantity).toBe(1);
      expect(item.unitSymbol).toBe('service');
      expect(item.commerceMetadata?.sessionsCount).toBe(8);
      expect(item.commerceMetadata?.durationLabel).toBe('8 sessions');
      expect(item.taxClassification?.type).toBe('SAC');
      expect(doc.totals.netPayable).toBe(11800);
    });
  });

  describe('3. Rental Commerce', () => {
    it('maps rental: Projector, 3 days @ ₹1,500/day -> ₹4,500 + security deposit ₹2,000', () => {
      const order = {
        id: 'ord-rental-1',
        orderNumber: 'RNT-2026-001',
        kind: 'rental',
        subtotal: 4500,
        taxTotal: 810,
        depositTotal: 2000,
        total: 7310,
        rentalWindow: {
          pickupDate: '2026-09-05T09:00:00Z',
          returnDueDate: '2026-09-08T18:00:00Z',
          lifecycle: 'checked_out',
        },
        items: [
          {
            name: 'Epson 4K Projector',
            orderedQuantity: 1,
            orderedUnitSymbol: 'unit',
            unitPrice: 1500,
            lineTotal: 4500,
            taxAmount: 810,
            taxRatePercent: 18,
            meta: { rentalDuration: '3 days' },
          },
        ],
        payments: [{ method: 'upi', amount: 7310, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });

      expect(doc.config.documentTitle).toBe('RENTAL INVOICE');
      expect(doc.commerceMetadata?.rentalStartDate).toBe('2026-09-05T09:00:00Z');
      expect(doc.commerceMetadata?.rentalEndDate).toBe('2026-09-08T18:00:00Z');
      expect(doc.totals.securityDepositTotal).toBe(2000);
      expect(doc.totals.netPayable).toBe(7310);
    });
  });

  describe('4. Subscription Commerce', () => {
    it('maps subscription: Annual Pool Membership 05-Sep-2026 -> 05-Sep-2027 @ ₹15,000/year', () => {
      const order = {
        id: 'ord-sub-1',
        orderNumber: 'SUB-2026-001',
        kind: 'subscription',
        subtotal: 15000,
        taxTotal: 2700,
        total: 17700,
        items: [
          {
            name: 'Annual Olympic Pool Membership',
            orderedQuantity: 1,
            orderedUnitSymbol: 'year',
            unitPrice: 15000,
            lineTotal: 15000,
            taxAmount: 2700,
            taxRatePercent: 18,
            validityStartDate: '2026-09-05',
            validityEndDate: '2027-09-05',
            planName: 'Annual Gold Tier',
          },
        ],
        payments: [{ method: 'bank_transfer', amount: 17700, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });

      expect(doc.config.documentTitle).toBe('SUBSCRIPTION INVOICE');
      const item = doc.items[0]!;
      expect(item.unitSymbol).toBe('year');
      expect(item.commerceMetadata?.validityStartDate).toBe('2026-09-05');
      expect(item.commerceMetadata?.validityEndDate).toBe('2027-09-05');
    });
  });

  describe('5. Restaurant Commerce', () => {
    it('maps restaurant: Paneer Butter Masala @ Table 12 (Dine-in)', () => {
      const order = {
        id: 'ord-rest-1',
        orderNumber: 'REST-042',
        kind: 'restaurant',
        subtotal: 500,
        taxTotal: 25,
        total: 525,
        fulfillment: {
          resourceId: 'Table 12',
          orderType: 'dine_in',
        },
        items: [
          {
            name: 'Paneer Butter Masala',
            orderedQuantity: 2,
            orderedUnitSymbol: 'plate',
            unitPrice: 250,
            lineTotal: 500,
            taxAmount: 25,
            taxRatePercent: 5,
          },
        ],
        payments: [{ method: 'cash', amount: 525, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });

      expect(doc.config.documentTitle).toBe('RESTAURANT RECEIPT');
      expect(doc.commerceMetadata?.tableNumber).toBe('Table 12');
      expect(doc.commerceMetadata?.orderType).toBe('dine_in');
      expect(doc.items[0]?.unitSymbol).toBe('plate');
    });
  });

  describe('6. Split Payments, Credit & Balance Due', () => {
    it('maps split payment: ₹500 paid via Cash (₹200) + UPI (₹300)', () => {
      const order = {
        id: 'ord-split',
        orderNumber: 'POS-SPLIT-1',
        subtotal: 500,
        taxTotal: 0,
        total: 500,
        items: [{ name: 'Assorted Goods', quantity: 1, unitPrice: 500, lineTotal: 500 }],
        payments: [
          { method: 'cash', amount: 200, status: 'succeeded' },
          { method: 'upi', amount: 300, status: 'succeeded' },
        ],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });

      expect(doc.payment.payments).toHaveLength(2);
      expect(doc.payment.totalPaid).toBe(500);
      expect(doc.payment.balanceDue).toBe(0);
      expect(doc.payment.status).toBe('PAID');
    });

    it('maps credit / partial payment with balance due and payment status', () => {
      const order = {
        id: 'ord-due',
        orderNumber: 'POS-DUE-1',
        subtotal: 1000,
        taxTotal: 50,
        total: 1050,
        items: [{ name: 'Hardware Parts', quantity: 1, unitPrice: 1000, lineTotal: 1000, taxAmount: 50 }],
        payments: [{ method: 'cash', amount: 400, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });

      expect(doc.payment.totalPaid).toBe(400);
      expect(doc.payment.balanceDue).toBe(650);
      expect(doc.payment.status).toBe('PARTIALLY_PAID');
      expect(doc.payment.upiPaymentQr?.amount).toBe(650);
    });
  });

  describe('7. Return / Credit Memo Document', () => {
    it('maps return transaction snapshot correctly', () => {
      const order = {
        id: 'ord-orig',
        orderNumber: 'POS-001',
        subtotal: 100,
        taxTotal: 5,
        total: 105,
      };
      const returnEvent = {
        id: 'ret-event-99',
        status: 'completed',
        reasonCode: 'defective',
        notes: 'Customer returned damaged wheat pack',
      };
      const returnItems = [
        {
          name: 'Broken Wheat',
          quantity: 5,
          orderedUnitSymbol: 'g',
          baseQuantity: 0.005,
          baseUnitSymbol: 'kg',
          unitPrice: 65,
          lineTotal: 0.33,
          taxAmount: 0.02,
          condition: 'damaged',
        },
      ];

      const doc = mapTransactionToUniversalInvoice({
        order,
        returnEvent,
        items: returnItems,
        shop: sampleShop,
      });

      expect(doc.config.documentTitle).toBe('CREDIT MEMO / RETURN RECEIPT');
      expect(doc.payment.status).toBe('REFUNDED');
      expect(doc.commerceMetadata?.returnReason).toBe('defective');
      expect(doc.items[0]?.commerceMetadata?.itemCondition).toBe('damaged');
    });
  });

  describe('8. HTML Document Renderers (Thermal 80mm & Full A4)', () => {
    it('generates valid Thermal 80mm HTML', () => {
      const order = {
        id: 'ord-thm',
        orderNumber: 'THM-001',
        subtotal: 100,
        taxTotal: 5,
        total: 105,
        items: [{ name: 'Rice Bag', quantity: 1, unitSymbol: 'pack', unitPrice: 100, lineTotal: 100, taxAmount: 5 }],
        payments: [{ method: 'cash', amount: 105, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });
      const html = renderUniversalInvoiceThermalHtml(doc);

      expect(html).toContain('Universal Superstore');
      expect(html).toContain('THM-001');
      expect(html).toContain('Rice Bag');
      expect(html).toContain('105.00');
    });

    it('generates valid Full A4 HTML', () => {
      const order = {
        id: 'ord-a4',
        orderNumber: 'A4-001',
        subtotal: 500,
        taxTotal: 25,
        total: 525,
        items: [{ name: 'Desk Chair', quantity: 2, unitSymbol: 'pcs', unitPrice: 250, lineTotal: 500, taxAmount: 25 }],
        payments: [{ method: 'upi', amount: 525, status: 'succeeded' }],
      };

      const doc = mapTransactionToUniversalInvoice({ order, shop: sampleShop });
      const html = renderUniversalInvoiceA4Html(doc);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('A4-001');
      expect(html).toContain('Desk Chair');
      expect(html).toContain('525.00');
    });
  });
});
