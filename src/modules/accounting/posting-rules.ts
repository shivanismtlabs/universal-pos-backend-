import { Prisma } from '@prisma/client';
import { MAP, PAYMENT_METHOD_MAP, type MappingKey } from './constants';
import { D, assertDoubleEntry, isZero, money2, type Money } from './money';

export type DraftLine = {
  mappingKey: MappingKey;
  debit: string;
  credit: string;
  description?: string;
  customerId?: string | null;
  supplierId?: string | null;
  locationId?: string | null;
  taxId?: string | null;
};

export type TaxFactDraft = {
  direction: 'OUTPUT' | 'INPUT';
  taxType: string;
  taxRate: string;
  taxableValue: string;
  taxAmount: string;
  hsnSac?: string | null;
  placeOfSupply?: string | null;
  partyType?: string | null;
};

export type BuiltJournal = {
  sourceType: string;
  description: string;
  lines: DraftLine[];
  taxFacts: TaxFactDraft[];
};

function push(
  lines: DraftLine[],
  mappingKey: MappingKey,
  side: 'debit' | 'credit',
  amount: Money,
  extra?: Partial<DraftLine>,
) {
  if (isZero(amount)) return;
  const amt = money2(amount);
  lines.push({
    mappingKey,
    debit: side === 'debit' ? amt : '0.00',
    credit: side === 'credit' ? amt : '0.00',
    ...extra,
  });
}

function tenderKey(method: string): MappingKey {
  return PAYMENT_METHOD_MAP[method] ?? MAP.other_tender;
}

export type RevenueSplit = {
  sales: Money;
  service: Money;
  rental: Money;
  subscription: Money;
};

export type GstSplit = {
  cgst: Money;
  sgst: Money;
  igst: Money;
  cess: Money;
  other: Money;
};

function gstLines(
  lines: DraftLine[],
  split: GstSplit,
  direction: 'output' | 'input',
) {
  const keys =
    direction === 'output'
      ? {
          cgst: MAP.output_cgst,
          sgst: MAP.output_sgst,
          igst: MAP.output_igst,
          cess: MAP.output_cess,
          other: MAP.output_gst,
        }
      : {
          cgst: MAP.input_cgst,
          sgst: MAP.input_sgst,
          igst: MAP.input_igst,
          cess: MAP.input_gst,
          other: MAP.input_gst,
        };
  const side = direction === 'output' ? 'credit' : 'debit';
  const detailed = !isZero(split.cgst) || !isZero(split.sgst) || !isZero(split.igst);
  if (detailed) {
    push(lines, keys.cgst, side, split.cgst);
    push(lines, keys.sgst, side, split.sgst);
    push(lines, keys.igst, side, split.igst);
    push(lines, keys.cess, side, split.cess);
    push(lines, keys.other, side, split.other);
  } else {
    push(lines, keys.other, side, split.other);
    push(lines, keys.cess, side, split.cess);
  }
}

function gstFacts(
  split: GstSplit,
  direction: 'OUTPUT' | 'INPUT',
  taxable: Money,
  extra?: Partial<TaxFactDraft>,
): TaxFactDraft[] {
  const facts: TaxFactDraft[] = [];
  const add = (taxType: string, amount: Money, rateHint?: string) => {
    if (isZero(amount)) return;
    facts.push({
      direction,
      taxType,
      taxRate: rateHint ?? '0',
      taxableValue: money2(taxable),
      taxAmount: money2(amount),
      ...extra,
    });
  };
  add('CGST', split.cgst);
  add('SGST', split.sgst);
  add('IGST', split.igst);
  add('CESS', split.cess);
  add(direction === 'OUTPUT' ? 'GST' : 'GST', split.other);
  return facts;
}

export function emptyGst(): GstSplit {
  const z = new Prisma.Decimal(0);
  return { cgst: z, sgst: z, igst: z, cess: z, other: z };
}

export function gstFromBreakdown(
  taxTotal: Money,
  breakdown?: {
    cgst?: number | string | null;
    sgst?: number | string | null;
    igst?: number | string | null;
    cess?: number | string | null;
  } | null,
): GstSplit {
  const split = emptyGst();
  split.cgst = D(breakdown?.cgst);
  split.sgst = D(breakdown?.sgst);
  split.igst = D(breakdown?.igst);
  split.cess = D(breakdown?.cess);
  const allocated = split.cgst.add(split.sgst).add(split.igst).add(split.cess);
  split.other = D(taxTotal).sub(allocated);
  if (split.other.lt(0) && split.other.abs().lessThan('0.02')) {
    split.other = new Prisma.Decimal(0);
  }
  if (isZero(allocated) && !isZero(taxTotal)) {
    split.other = D(taxTotal);
  }
  return split;
}

export function buildSaleJournal(input: {
  basis: 'cash' | 'accrual';
  orderKind: string;
  subtotal: Money;
  discountTotal: Money;
  taxTotal: Money;
  balanceDue: Money;
  revenue: RevenueSplit;
  gst: GstSplit;
  payments: Array<{ method: string; type: string; amount: Money }>;
  customerId?: string | null;
  locationId?: string | null;
  orderNumber: string;
}): BuiltJournal {
  const lines: DraftLine[] = [];
  const loc = { locationId: input.locationId, customerId: input.customerId };
  const merch = D(input.subtotal).sub(D(input.discountTotal));
  const tax = D(input.taxTotal);
  const paySale = input.payments
    .filter((p) => p.type === 'payment' || p.type === 'deposit_refund')
    .reduce((s, p) => s.add(D(p.amount)), new Prisma.Decimal(0));
  const deposits = input.payments
    .filter((p) => p.type === 'deposit')
    .reduce((s, p) => s.add(D(p.amount)), new Prisma.Decimal(0));

  const invoiceTotal = merch.add(tax);
  let recognizedMerch = merch;
  let recognizedTax = tax;
  let recognizedRev = { ...input.revenue };
  let recognizedGst = { ...input.gst };

  if (input.basis === 'cash') {
    const ratio = invoiceTotal.gt(0) ? D(paySale).div(invoiceTotal) : new Prisma.Decimal(0);
    recognizedMerch = merch.mul(ratio).toDecimalPlaces(2);
    recognizedTax = tax.mul(ratio).toDecimalPlaces(2);
    recognizedRev = {
      sales: input.revenue.sales.mul(ratio).toDecimalPlaces(2),
      service: input.revenue.service.mul(ratio).toDecimalPlaces(2),
      rental: input.revenue.rental.mul(ratio).toDecimalPlaces(2),
      subscription: input.revenue.subscription.mul(ratio).toDecimalPlaces(2),
    };
    const taxRatio = tax.gt(0) ? recognizedTax.div(tax) : new Prisma.Decimal(0);
    recognizedGst = {
      cgst: input.gst.cgst.mul(taxRatio).toDecimalPlaces(2),
      sgst: input.gst.sgst.mul(taxRatio).toDecimalPlaces(2),
      igst: input.gst.igst.mul(taxRatio).toDecimalPlaces(2),
      cess: input.gst.cess.mul(taxRatio).toDecimalPlaces(2),
      other: input.gst.other.mul(taxRatio).toDecimalPlaces(2),
    };
  }

  for (const p of input.payments) {
    if (p.type === 'refund' || p.type === 'deposit_refund') continue;
    push(lines, tenderKey(p.method), 'debit', D(p.amount), loc);
  }

  if (input.basis === 'accrual') {
    const ar = D(input.balanceDue);
    push(lines, MAP.ar, 'debit', ar, loc);
  }

  push(lines, MAP.sales, 'credit', recognizedRev.sales, loc);
  push(lines, MAP.service_revenue, 'credit', recognizedRev.service, loc);
  push(lines, MAP.rental_revenue, 'credit', recognizedRev.rental, loc);
  push(lines, MAP.subscription_revenue, 'credit', recognizedRev.subscription, loc);
  const postedRev = recognizedRev.sales
    .add(recognizedRev.service)
    .add(recognizedRev.rental)
    .add(recognizedRev.subscription);
  const remainder = recognizedMerch.sub(postedRev);
  push(lines, MAP.sales, 'credit', remainder, loc);

  gstLines(lines, recognizedGst, 'output');
  push(lines, MAP.customer_advances, 'credit', deposits, loc);

  // Rounding residue → AR or cash so debit always equals credit
  const d = lines.reduce((s, l) => s.add(D(l.debit)), new Prisma.Decimal(0));
  const c = lines.reduce((s, l) => s.add(D(l.credit)), new Prisma.Decimal(0));
  const gap = d.sub(c);
  if (gap.gt(0)) push(lines, MAP.sales, 'credit', gap, loc);
  else if (gap.lt(0)) {
    const plug = input.basis === 'accrual' ? MAP.ar : MAP.cash;
    push(lines, plug, 'debit', gap.abs(), loc);
  }

  assertDoubleEntry(lines, 'Sale journal');

  const sourceType =
    input.orderKind === 'rental'
      ? 'RENTAL'
      : input.orderKind === 'subscription'
        ? 'SUBSCRIPTION'
        : input.basis === 'accrual' && D(input.balanceDue).gt(0)
          ? 'CREDIT_SALE'
          : 'SALE';

  return {
    sourceType,
    description: `Sale ${input.orderNumber}`,
    lines,
    taxFacts: gstFacts(recognizedGst, 'OUTPUT', recognizedMerch),
  };
}

export function buildCustomerPaymentJournal(input: {
  basis: 'cash' | 'accrual';
  method: string;
  amount: Money;
  customerId?: string | null;
  locationId?: string | null;
  orderNumber?: string;
  /** Remaining invoice (merch+tax) still unrecognized on cash basis */
  unrecognizedRevenue?: RevenueSplit;
  unrecognizedGst?: GstSplit;
  unrecognizedMerch?: Money;
}): BuiltJournal {
  const lines: DraftLine[] = [];
  const loc = { locationId: input.locationId, customerId: input.customerId };
  push(lines, tenderKey(input.method), 'debit', D(input.amount), loc);
  if (input.basis === 'accrual') {
    push(lines, MAP.ar, 'credit', D(input.amount), loc);
  } else {
    const rev = input.unrecognizedRevenue;
    if (rev) {
      push(lines, MAP.sales, 'credit', rev.sales, loc);
      push(lines, MAP.service_revenue, 'credit', rev.service, loc);
      push(lines, MAP.rental_revenue, 'credit', rev.rental, loc);
      push(lines, MAP.subscription_revenue, 'credit', rev.subscription, loc);
    }
    if (input.unrecognizedGst) gstLines(lines, input.unrecognizedGst, 'output');
    const d = lines.reduce((s, l) => s.add(D(l.debit)), new Prisma.Decimal(0));
    const c = lines.reduce((s, l) => s.add(D(l.credit)), new Prisma.Decimal(0));
    const gap = d.sub(c);
    if (gap.gt(0)) push(lines, MAP.sales, 'credit', gap, loc);
    else if (gap.lt(0)) push(lines, MAP.ar, 'debit', gap.abs(), loc);
  }
  assertDoubleEntry(lines, 'Customer payment journal');
  return {
    sourceType: 'CUSTOMER_PAYMENT',
    description: `Customer payment${input.orderNumber ? ` ${input.orderNumber}` : ''}`,
    lines,
    taxFacts:
      input.basis === 'cash' && input.unrecognizedGst
        ? gstFacts(
            input.unrecognizedGst,
            'OUTPUT',
            D(input.unrecognizedMerch ?? 0),
          )
        : [],
  };
}

export function buildExpenseJournal(input: {
  net: Money;
  tax: Money;
  gst: GstSplit;
  method: string;
  expenseNumber?: string | null;
  locationId?: string | null;
  expenseAccountKey?: MappingKey;
}): BuiltJournal {
  const lines: DraftLine[] = [];
  const loc = { locationId: input.locationId };
  push(lines, input.expenseAccountKey ?? MAP.expense_default, 'debit', D(input.net), loc);
  gstLines(lines, input.gst, 'input');
  if (isZero(input.gst.cgst) && isZero(input.gst.sgst) && isZero(input.gst.igst)) {
    // gstLines already posted `other` as input_gst
  }
  const gross = D(input.net).add(D(input.tax));
  push(lines, tenderKey(input.method), 'credit', gross, loc);
  const d = lines.reduce((s, l) => s.add(D(l.debit)), new Prisma.Decimal(0));
  const c = lines.reduce((s, l) => s.add(D(l.credit)), new Prisma.Decimal(0));
  const gap = d.sub(c);
  if (gap.gt(0)) push(lines, tenderKey(input.method), 'credit', gap, loc);
  else if (gap.lt(0)) {
    push(lines, input.expenseAccountKey ?? MAP.expense_default, 'debit', gap.abs(), loc);
  }
  assertDoubleEntry(lines, 'Expense journal');
  return {
    sourceType: 'EXPENSE',
    description: `Expense ${input.expenseNumber ?? ''}`.trim(),
    lines,
    taxFacts: gstFacts(input.gst, 'INPUT', D(input.net)),
  };
}

export function buildPurchaseJournal(input: {
  subtotal: Money;
  taxTotal: Money;
  gst: GstSplit;
  isReturn: boolean;
  inventoryAccounting: boolean;
  supplierId?: string | null;
  locationId?: string | null;
  invoiceNumber: string;
}): BuiltJournal {
  const loc = { locationId: input.locationId, supplierId: input.supplierId };
  const purchaseKey = input.inventoryAccounting ? MAP.inventory : MAP.purchase;
  if (input.isReturn) {
    const rebuilt: DraftLine[] = [];
    push(rebuilt, MAP.ap, 'debit', D(input.subtotal).add(D(input.taxTotal)), loc);
    push(rebuilt, MAP.purchase_return, 'credit', D(input.subtotal), loc);
    const g = input.gst;
    const detailed = !isZero(g.cgst) || !isZero(g.sgst) || !isZero(g.igst);
    if (detailed) {
      push(rebuilt, MAP.input_cgst, 'credit', g.cgst, loc);
      push(rebuilt, MAP.input_sgst, 'credit', g.sgst, loc);
      push(rebuilt, MAP.input_igst, 'credit', g.igst, loc);
      push(rebuilt, MAP.input_gst, 'credit', g.other.add(g.cess), loc);
    } else {
      push(rebuilt, MAP.input_gst, 'credit', D(input.taxTotal), loc);
    }
    const d = rebuilt.reduce((s, l) => s.add(D(l.debit)), new Prisma.Decimal(0));
    const c = rebuilt.reduce((s, l) => s.add(D(l.credit)), new Prisma.Decimal(0));
    const gap = d.sub(c);
    if (gap.gt(0)) push(rebuilt, MAP.purchase_return, 'credit', gap, loc);
    else if (gap.lt(0)) push(rebuilt, MAP.ap, 'debit', gap.abs(), loc);
    assertDoubleEntry(rebuilt, 'Purchase return journal');
    return {
      sourceType: 'PURCHASE_RETURN',
      description: `Purchase return ${input.invoiceNumber}`,
      lines: rebuilt,
      taxFacts: gstFacts(input.gst, 'INPUT', D(input.subtotal)).map((f) => ({
        ...f,
        taxAmount: money2(D(f.taxAmount).neg()),
        taxableValue: money2(D(f.taxableValue).neg()),
      })),
    };
  }

  const lines: DraftLine[] = [];
  push(lines, purchaseKey, 'debit', D(input.subtotal), loc);
  gstLines(lines, input.gst, 'input');
  if (isZero(input.gst.cgst) && isZero(input.gst.sgst) && isZero(input.gst.igst)) {
    // other already posted
  }
  push(lines, MAP.ap, 'credit', D(input.subtotal).add(D(input.taxTotal)), loc);
  const d = lines.reduce((s, l) => s.add(D(l.debit)), new Prisma.Decimal(0));
  const c = lines.reduce((s, l) => s.add(D(l.credit)), new Prisma.Decimal(0));
  const gap = d.sub(c);
  if (gap.gt(0)) push(lines, MAP.ap, 'credit', gap, loc);
  else if (gap.lt(0)) push(lines, purchaseKey, 'debit', gap.abs(), loc);
  assertDoubleEntry(lines, 'Purchase journal');
  return {
    sourceType: 'PURCHASE',
    description: `Purchase ${input.invoiceNumber}`,
    lines,
    taxFacts: gstFacts(input.gst, 'INPUT', D(input.subtotal)),
  };
}

export function buildSupplierPaymentJournal(input: {
  amount: Money;
  method: string;
  kind: 'payment' | 'refund';
  supplierId?: string | null;
  locationId?: string | null;
  reference?: string | null;
}): BuiltJournal {
  const lines: DraftLine[] = [];
  const loc = { locationId: input.locationId, supplierId: input.supplierId };
  if (input.kind === 'refund') {
    push(lines, tenderKey(input.method), 'debit', D(input.amount), loc);
    push(lines, MAP.ap, 'credit', D(input.amount), loc);
  } else {
    push(lines, MAP.ap, 'debit', D(input.amount), loc);
    push(lines, tenderKey(input.method), 'credit', D(input.amount), loc);
  }
  assertDoubleEntry(lines, 'Supplier payment journal');
  return {
    sourceType: 'SUPPLIER_PAYMENT',
    description: `Supplier ${input.kind}${input.reference ? ` ${input.reference}` : ''}`,
    lines,
    taxFacts: [],
  };
}

export function buildSaleReturnJournal(input: {
  net: Money;
  tax: Money;
  gst: GstSplit;
  refundMethod: string;
  customerId?: string | null;
  locationId?: string | null;
  orderNumber: string;
}): BuiltJournal {
  const lines: DraftLine[] = [];
  const loc = { locationId: input.locationId, customerId: input.customerId };
  push(lines, MAP.sales_return, 'debit', D(input.net), loc);
  const g = input.gst;
  const detailed = !isZero(g.cgst) || !isZero(g.sgst) || !isZero(g.igst);
  if (detailed) {
    push(lines, MAP.output_cgst, 'debit', g.cgst, loc);
    push(lines, MAP.output_sgst, 'debit', g.sgst, loc);
    push(lines, MAP.output_igst, 'debit', g.igst, loc);
    push(lines, MAP.output_gst, 'debit', g.other.add(g.cess), loc);
  } else {
    push(lines, MAP.output_gst, 'debit', D(input.tax), loc);
  }
  push(lines, tenderKey(input.refundMethod), 'credit', D(input.net).add(D(input.tax)), loc);
  const d = lines.reduce((s, l) => s.add(D(l.debit)), new Prisma.Decimal(0));
  const c = lines.reduce((s, l) => s.add(D(l.credit)), new Prisma.Decimal(0));
  const gap = d.sub(c);
  if (gap.gt(0)) push(lines, tenderKey(input.refundMethod), 'credit', gap, loc);
  else if (gap.lt(0)) push(lines, MAP.sales_return, 'debit', gap.abs(), loc);
  assertDoubleEntry(lines, 'Sales return journal');
  return {
    sourceType: 'SALE_RETURN',
    description: `Sales return ${input.orderNumber}`,
    lines,
    taxFacts: gstFacts(input.gst, 'OUTPUT', D(input.net)).map((f) => ({
      ...f,
      taxAmount: money2(D(f.taxAmount).neg()),
      taxableValue: money2(D(f.taxableValue).neg()),
    })),
  };
}

export function buildCogsJournal(input: {
  cogsAmount: Money;
  locationId?: string | null;
  orderNumber: string;
}): BuiltJournal | null {
  if (isZero(input.cogsAmount)) return null;
  const lines: DraftLine[] = [];
  const loc = { locationId: input.locationId };
  push(lines, MAP.cogs, 'debit', D(input.cogsAmount), loc);
  push(lines, MAP.inventory, 'credit', D(input.cogsAmount), loc);
  assertDoubleEntry(lines, 'COGS journal');
  return {
    sourceType: 'INVENTORY_COGS',
    description: `COGS ${input.orderNumber}`,
    lines,
    taxFacts: [],
  };
}

export function reverseDraftLines(lines: DraftLine[]): DraftLine[] {
  return lines.map((l) => ({
    ...l,
    debit: l.credit,
    credit: l.debit,
    description: l.description ? `Reversal: ${l.description}` : 'Reversal',
  }));
}
