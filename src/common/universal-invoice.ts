/**
 * Universal Invoice / Receipt Document Engine
 *
 * ONE unified canonical document model and renderer for all commerce types:
 * - Retail Sale (Weight, Volume, Length, Packaging, Fractional UOM)
 * - Service (Duration, Session Packs, Appointments)
 * - Subscription (Validity Periods, Plans, Memberships)
 * - Rental (Pickup/Return Dates, Duration, Deposits)
 * - Restaurant (Tables, Dine-in/Takeaway, KOT)
 * - Returns / Refunds (Credit Memos, Historical Snapshots)
 *
 * Formats:
 * - Thermal 80mm / 58mm
 * - Full A4
 * - Email / HTML
 * - Print / PDF
 */

export type UniversalInvoiceStatus =
  | 'PAID'
  | 'PARTIALLY_PAID'
  | 'DUE'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'DRAFT';

export type UniversalTaxClassification = {
  type?: string; // 'HSN' | 'SAC' | 'VAT' | 'CUSTOM' | string;
  code?: string;
  label?: string; // e.g. 'HSN', 'SAC', 'Tax Code'
};

export type UniversalInvoiceHeader = {
  businessName: string;
  tagline?: string | null;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  /** Generic registration / tax identifiers (e.g. GSTIN, VAT ID, Reg #) */
  taxRegistration?: {
    label: string; // e.g. 'GSTIN', 'VAT #', 'Tax ID'
    value: string;
  } | null;
  locationName?: string | null;
  invoiceNumber: string;
  orderNumber: string;
  issueDate: string | Date;
  cashierName?: string | null;
  salespersonName?: string | null;
};

export type UniversalInvoiceCustomer = {
  id?: string | null;
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxRegistrationNumber?: string | null;
};

export type UniversalCommerceMetadata = {
  // Retail metadata
  sku?: string | null;
  barcode?: string | null;
  batchNumber?: string | null;
  serialNumber?: string | null;

  // Service metadata
  durationLabel?: string | null; // e.g. '8 sessions', '60 minutes'
  sessionsCount?: number | null;
  appointmentRef?: string | null;
  staffName?: string | null;

  // Subscription metadata
  planName?: string | null;
  billingInterval?: string | null; // e.g. 'year', 'month'
  validityStartDate?: string | Date | null;
  validityEndDate?: string | Date | null;

  // Rental metadata
  rentalStartDate?: string | Date | null;
  rentalEndDate?: string | Date | null;
  rentalDuration?: string | null; // e.g. '3 days'
  assetIdentifier?: string | null;
  securityDepositHeld?: number | null;
  rentalStatus?: string | null;

  // Restaurant metadata
  tableNumber?: string | null;
  orderType?: 'dine_in' | 'takeaway' | 'delivery' | string | null;
  kotNumber?: string | null;

  // Return / Refund metadata
  returnEventNumber?: string | null;
  returnReason?: string | null;
  itemCondition?: string | null;
};

export type UniversalInvoiceLineItem = {
  lineNumber: number;
  name: string;
  description?: string | null;
  /** Preserved entered quantity */
  quantity: number;
  /** Preserved entered UOM symbol */
  unitSymbol?: string | null;
  unitName?: string | null;
  /** Equivalent base quantity (e.g. 0.005 kg for 5 g) */
  equivalentBaseQuantity?: number | null;
  equivalentBaseUnitSymbol?: string | null;
  /** Rate per unit (entered/pricing UOM) */
  unitPrice: number;
  pricingUnitSymbol?: string | null;
  grossMrp?: number | null;
  productDiscount?: number | null;
  taxableAmount?: number | null;
  taxRatePercent?: number | null;
  taxAmount?: number | null;
  taxClassification?: UniversalTaxClassification | null;
  lineTotal: number;
  commerceMetadata?: UniversalCommerceMetadata | null;
};

export type UniversalInvoiceTotals = {
  grossMrpTotal?: number | null;
  productDiscountTotal?: number | null;
  subtotalNet: number;
  billDiscountTotal?: number | null;
  couponDiscountTotal?: number | null;
  taxableValue?: number | null;
  taxTotal: number;
  taxBreakdown?: Array<{
    name: string; // e.g. 'CGST (2.5%)', 'SGST (2.5%)', 'VAT'
    ratePercent: number;
    amount: number;
  }>;
  securityDepositTotal?: number | null;
  roundOff?: number | null;
  netPayable: number;
};

export type UniversalPaymentEntry = {
  method: string; // e.g. 'cash', 'upi', 'card', 'wallet', 'store_credit', 'bank_transfer'
  label?: string; // e.g. 'Cash', 'UPI', 'Credit Card'
  amount: number;
  status?: string;
  transactionReference?: string | null;
  paidAt?: string | Date | null;
};

export type UniversalInvoicePayment = {
  payments: UniversalPaymentEntry[];
  totalPaid: number;
  balanceDue: number;
  changeReturned?: number | null;
  status: UniversalInvoiceStatus;
  upiPaymentQr?: {
    vpa: string;
    payeeName: string;
    amount: number;
  } | null;
};

export type UniversalInvoiceConfig = {
  currencySymbol: string; // e.g. '₹', '$', '€'
  currencyCode: string; // e.g. 'INR', 'USD'
  documentTitle?: string; // Default: auto-resolved (e.g. 'TAX INVOICE', 'SERVICE INVOICE', 'RENTAL INVOICE', 'RETURN RECEIPT')
  footerNote?: string | null;
  termsAndConditions?: string[] | string | null;
  returnPolicyNote?: string | null;
  showBarcode?: boolean;
};

export type UniversalInvoiceDocument = {
  header: UniversalInvoiceHeader;
  customer?: UniversalInvoiceCustomer | null;
  items: UniversalInvoiceLineItem[];
  commerceMetadata?: UniversalCommerceMetadata | null;
  totals: UniversalInvoiceTotals;
  payment: UniversalInvoicePayment;
  config: UniversalInvoiceConfig;
  notes?: string | null;
};

function formatMoney(amount: number, symbol = '₹'): string {
  return `${symbol}${amount.toFixed(2)}`;
}

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Universal Invoice Data Mapper:
 * Transforms any raw order/return transaction into the canonical UniversalInvoiceDocument.
 */
export function mapTransactionToUniversalInvoice(input: {
  order: any;
  shop?: any;
  customer?: any;
  items?: any[];
  payments?: any[];
  invoices?: any[];
  config?: Partial<UniversalInvoiceConfig>;
  returnEvent?: any;
}): UniversalInvoiceDocument {
  const o = input.order || {};
  const s = input.shop || {};
  const c = input.customer || o.customer;
  const items = input.items || o.items || [];
  const payments = input.payments || o.payments || [];
  const ret = input.returnEvent;

  // Header resolution
  const taxIdVal = s.taxId || s.gstin || o.meta?.taxId || o.meta?.gstin;
  const taxLabel = s.taxLabel || (taxIdVal ? 'GSTIN' : 'Tax ID');

  const invoiceNumber =
    o.activeInvoiceNumber ||
    input.invoices?.[input.invoices.length - 1]?.invoiceNumber ||
    o.invoices?.[o.invoices.length - 1]?.invoiceNumber ||
    (ret ? `RET-${ret.id?.slice(-6) || o.orderNumber}` : o.orderNumber || 'INV-0001');

  const header: UniversalInvoiceHeader = {
    businessName: s.name || s.shopName || 'Business Store',
    tagline: s.tagline || null,
    logoUrl: s.logoUrl || null,
    address: s.address || null,
    phone: s.phone || null,
    email: s.email || null,
    website: s.website || null,
    taxRegistration: taxIdVal ? { label: taxLabel, value: String(taxIdVal) } : null,
    locationName: s.locationName || o.location?.name || null,
    invoiceNumber,
    orderNumber: o.orderNumber || invoiceNumber,
    issueDate: o.createdAt || new Date(),
    cashierName: o.cashierName || o.createdBy?.name || null,
    salespersonName: o.salespersonName || null,
  };

  const customer: UniversalInvoiceCustomer | null = c
    ? {
        id: c.id || null,
        name: c.fullName || c.name || 'Walk-in Customer',
        phone: c.phone || null,
        email: c.email || null,
        address: c.address || null,
        taxRegistrationNumber: c.taxRegistrationNumber || c.gstin || null,
      }
    : null;

  // Items resolution
  const mappedItems: UniversalInvoiceLineItem[] = items.map((item: any, idx: number) => {
    const rawQty = Number(item.orderedQuantity ?? item.quantity ?? 1);
    const orderedUnitSymbol =
      item.orderedUnitSymbol ||
      item.unitSymbol ||
      (typeof item.meta === 'object' && item.meta?.orderedUnitSymbol) ||
      '';
    const baseUnitSymbol =
      item.baseUnitSymbol ||
      (typeof item.meta === 'object' && item.meta?.baseUnitSymbol) ||
      '';
    const baseQty =
      item.baseQuantity != null ? Number(item.baseQuantity) : null;

    const rate = Number(item.unitPrice ?? 0);
    const lineTotal =
      item.lineTotal !== undefined
        ? Number(item.lineTotal)
        : rate * rawQty;
    const taxAmt = Number(item.taxAmount ?? 0);
    const taxRate =
      item.taxRatePercent !== undefined
        ? Number(item.taxRatePercent)
        : taxAmt > 0 && lineTotal > 0
          ? Number(((taxAmt / lineTotal) * 100).toFixed(1))
          : 0;

    const rawTaxCode = (
      item.hsnOrSac ||
      item.taxCode ||
      (typeof item.meta === 'object' && item.meta?.hsn) ||
      ''
    ).trim();

    let taxClassification: UniversalTaxClassification | null = null;
    if (rawTaxCode) {
      const isSac =
        item.itemKind === 'service' ||
        item.itemType === 'service' ||
        /^99/i.test(rawTaxCode);
      taxClassification = {
        type: isSac ? 'SAC' : 'HSN',
        code: rawTaxCode,
        label: isSac ? 'SAC' : 'HSN',
      };
    }

    const itemMeta = typeof item.meta === 'object' ? item.meta : {};

    const commerceMeta: UniversalCommerceMetadata = {
      sku: item.sku || item.product?.skuCode || itemMeta?.sku || null,
      barcode: item.barcode || item.product?.barcode || itemMeta?.barcode || null,
      durationLabel:
        item.durationLabel ||
        itemMeta?.durationLabel ||
        (item.durationDays ? `${item.durationDays} day(s)` : null) ||
        (item.durationHours ? `${item.durationHours} hr(s)` : null),
      sessionsCount: item.sessionsCount ?? itemMeta?.sessionsCount ?? null,
      appointmentRef: item.appointmentRef || itemMeta?.appointmentRef || null,
      staffName: item.staffName || itemMeta?.staffName || null,
      planName: item.planName || itemMeta?.planName || null,
      billingInterval: item.billingInterval || itemMeta?.billingInterval || null,
      validityStartDate:
        item.validityStartDate || itemMeta?.validityStartDate || null,
      validityEndDate:
        item.validityEndDate || itemMeta?.validityEndDate || null,
      rentalStartDate:
        item.rentalStartDate || itemMeta?.rentalStartDate || null,
      rentalEndDate: item.rentalEndDate || itemMeta?.rentalEndDate || null,
      rentalDuration: item.rentalDuration || itemMeta?.rentalDuration || null,
      assetIdentifier: item.assetIdentifier || itemMeta?.assetIdentifier || null,
      securityDepositHeld:
        item.securityDepositHeld != null
          ? Number(item.securityDepositHeld)
          : null,
      itemCondition: item.condition || itemMeta?.condition || null,
    };

    return {
      lineNumber: idx + 1,
      name:
        item.name ||
        item.description ||
        item.product?.name ||
        item.itemType ||
        'Item',
      description: item.description !== item.name ? item.description : null,
      quantity: rawQty,
      unitSymbol: orderedUnitSymbol || null,
      equivalentBaseQuantity:
        baseQty != null &&
        orderedUnitSymbol &&
        baseUnitSymbol &&
        orderedUnitSymbol.toLowerCase() !== baseUnitSymbol.toLowerCase()
          ? baseQty
          : null,
      equivalentBaseUnitSymbol: baseUnitSymbol || null,
      unitPrice: rate,
      pricingUnitSymbol: itemMeta?.priceUnitSymbol || orderedUnitSymbol || null,
      grossMrp: item.grossMrp != null ? Number(item.grossMrp) : null,
      productDiscount:
        item.productDiscount != null ? Number(item.productDiscount) : null,
      taxableAmount: lineTotal,
      taxRatePercent: taxRate,
      taxAmount: taxAmt,
      taxClassification,
      lineTotal,
      commerceMetadata: commerceMeta,
    };
  });

  // Overall commerce metadata
  const orderMeta = typeof o.meta === 'object' ? o.meta : {};
  const commerceMetadata: UniversalCommerceMetadata = {
    tableNumber: o.fulfillment?.resourceId || o.tableNumber || orderMeta?.tableNumber || null,
    orderType: o.fulfillment?.orderType || o.orderType || orderMeta?.orderType || null,
    kotNumber: o.kotNumber || orderMeta?.kotNumber || null,
    rentalStartDate: o.rentalWindow?.pickupDate || o.rentalStartDate || null,
    rentalEndDate: o.rentalWindow?.returnDueDate || o.returnDueDate || null,
    rentalDuration: o.rentalDuration || null,
    securityDepositHeld:
      o.depositTotal != null
        ? Number(o.depositTotal)
        : o.totals?.depositTotal != null
          ? Number(o.totals.depositTotal)
          : null,
    returnEventNumber: ret?.id || null,
    returnReason: ret?.reasonCode || ret?.notes || null,
  };

  // Totals resolution
  const subtotalNet = Number(o.subtotal ?? o.totals?.subtotal ?? 0);
  const taxTotal = Number(o.taxTotal ?? o.totals?.taxTotal ?? 0);
  const grossMrpTotal =
    o.grossMrpTotal ??
    o.totals?.grossMrp ??
    mappedItems.reduce((s, i) => s + (i.grossMrp ? i.grossMrp * i.quantity : i.lineTotal), 0);
  const prodDiscountTotal =
    o.productDiscountTotal ??
    o.totals?.productDiscount ??
    mappedItems.reduce((s, i) => s + (i.productDiscount ? i.productDiscount * i.quantity : 0), 0);
  const billDiscountTotal = Number(
    o.billDiscountTotal ?? o.discountTotal ?? o.totals?.discountTotal ?? 0,
  );
  const securityDepositTotal =
    commerceMetadata.securityDepositHeld != null
      ? Number(commerceMetadata.securityDepositHeld)
      : 0;
  const roundOff = Number(o.roundOff ?? o.totals?.roundOff ?? 0);
  const netPayable =
    o.total !== undefined
      ? Number(o.total)
      : o.totals?.grandTotal !== undefined
        ? Number(o.totals.grandTotal)
        : Number(
            (
              subtotalNet -
              billDiscountTotal +
              taxTotal +
              securityDepositTotal +
              roundOff
            ).toFixed(2),
          );

  const totals: UniversalInvoiceTotals = {
    grossMrpTotal: grossMrpTotal > subtotalNet ? grossMrpTotal : null,
    productDiscountTotal: prodDiscountTotal > 0 ? prodDiscountTotal : null,
    subtotalNet,
    billDiscountTotal: billDiscountTotal > 0 ? billDiscountTotal : null,
    taxableValue: subtotalNet,
    taxTotal,
    securityDepositTotal: securityDepositTotal > 0 ? securityDepositTotal : null,
    roundOff: roundOff !== 0 ? roundOff : null,
    netPayable,
  };

  // Payments resolution
  const mappedPayments: UniversalPaymentEntry[] = payments.map((p: any) => ({
    method: p.method || 'cash',
    label: p.method ? String(p.method).toUpperCase() : 'CASH',
    amount: Number(p.amount ?? 0),
    status: p.status || 'succeeded',
    transactionReference: p.gatewayRef || p.referenceId || null,
    paidAt: p.createdAt || null,
  }));

  const totalPaid = mappedPayments
    .filter((p) => !p.status || p.status === 'succeeded')
    .reduce((s, p) => s + p.amount, 0);

  const balanceDue = Math.max(0, Number((netPayable - totalPaid).toFixed(2)));

  let status: UniversalInvoiceStatus = 'PAID';
  if (ret) {
    status = ret.status === 'completed' ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  } else if (balanceDue <= 0.009) {
    status = 'PAID';
  } else if (totalPaid > 0) {
    status = 'PARTIALLY_PAID';
  } else {
    status = 'DUE';
  }

  const payment: UniversalInvoicePayment = {
    payments: mappedPayments,
    totalPaid,
    balanceDue,
    changeReturned: o.change != null ? Number(o.change) : null,
    status,
    upiPaymentQr:
      s.upiVpa && balanceDue > 0
        ? {
            vpa: s.upiVpa,
            payeeName: s.upiPayee || s.name || 'Shop',
            amount: balanceDue,
          }
        : null,
  };

  const currencySymbol = input.config?.currencySymbol || '₹';
  const currencyCode = input.config?.currencyCode || 'INR';

  // Title Auto-Resolution if not explicitly configured
  let documentTitle = input.config?.documentTitle;
  if (!documentTitle) {
    if (ret) documentTitle = 'CREDIT MEMO / RETURN RECEIPT';
    else if (o.kind === 'rental' || commerceMetadata.rentalStartDate)
      documentTitle = 'RENTAL INVOICE';
    else if (o.kind === 'service' || mappedItems.some((i) => i.commerceMetadata?.sessionsCount))
      documentTitle = 'SERVICE INVOICE';
    else if (o.kind === 'subscription' || mappedItems.some((i) => i.commerceMetadata?.validityStartDate))
      documentTitle = 'SUBSCRIPTION INVOICE';
    else if (o.kind === 'restaurant' || commerceMetadata.tableNumber)
      documentTitle = 'RESTAURANT RECEIPT';
    else documentTitle = 'TAX INVOICE';
  }

  const config: UniversalInvoiceConfig = {
    currencySymbol,
    currencyCode,
    documentTitle,
    footerNote: input.config?.footerNote ?? 'Thank you for your business!',
    termsAndConditions: input.config?.termsAndConditions ?? null,
    returnPolicyNote: input.config?.returnPolicyNote ?? null,
    showBarcode: input.config?.showBarcode ?? true,
  };

  return {
    header,
    customer,
    items: mappedItems,
    commerceMetadata,
    totals,
    payment,
    config,
    notes: o.notes || null,
  };
}

/**
 * Render Universal Invoice as Thermal 80mm / 58mm HTML string
 */
export function renderUniversalInvoiceThermalHtml(doc: UniversalInvoiceDocument): string {
  const { header, customer, items, totals, payment, config, commerceMetadata } = doc;
  const curr = config.currencySymbol;

  const itemRowsHtml = items
    .map((item) => {
      const qtyStr =
        item.unitSymbol
          ? `${item.quantity} ${item.unitSymbol}`
          : item.quantity % 1 === 0
            ? String(item.quantity)
            : item.quantity.toFixed(2);
      const equivStr =
        item.equivalentBaseQuantity != null && item.equivalentBaseUnitSymbol
          ? `<div style="font-size:10px; color:#555;">(Eq: ${item.equivalentBaseQuantity} ${item.equivalentBaseUnitSymbol})</div>`
          : '';
      const taxClassStr = item.taxClassification?.code
        ? `<div style="font-size:10px; color:#666;">${esc(item.taxClassification.label || 'Tax Code')}: ${esc(item.taxClassification.code)}${item.taxRatePercent ? ` | Tax: ${item.taxRatePercent}%` : ''}</div>`
        : '';
      const serviceMeta = item.commerceMetadata?.durationLabel
        ? `<div style="font-size:10px; color:#444;">Duration: ${esc(item.commerceMetadata.durationLabel)}</div>`
        : item.commerceMetadata?.sessionsCount
          ? `<div style="font-size:10px; color:#444;">Sessions: ${item.commerceMetadata.sessionsCount}</div>`
          : '';

      return `
      <tr style="border-bottom: 1px dashed #ccc;">
        <td style="padding: 4px 0; text-align: left; vertical-align: top;">
          <div style="font-weight: 600;">${esc(item.name)}</div>
          ${serviceMeta}
          ${equivStr}
          ${taxClassStr}
        </td>
        <td style="padding: 4px 2px; text-align: center; vertical-align: top; font-family: monospace;">
          ${esc(qtyStr)}
        </td>
        <td style="padding: 4px 2px; text-align: right; vertical-align: top; font-family: monospace;">
          ${formatMoney(item.unitPrice, curr)}
        </td>
        <td style="padding: 4px 0; text-align: right; vertical-align: top; font-weight: 700; font-family: monospace;">
          ${formatMoney(item.lineTotal, curr)}
        </td>
      </tr>`;
    })
    .join('');

  const rentalBlock = commerceMetadata?.rentalStartDate
    ? `
    <div style="border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 4px 0; margin: 6px 0; font-size: 11px;">
      <div style="font-weight: bold; text-align: center;">RENTAL PERIOD</div>
      <div>Start: ${formatDate(commerceMetadata.rentalStartDate)}</div>
      <div>Due: ${formatDate(commerceMetadata.rentalEndDate)}</div>
      ${totals.securityDepositTotal ? `<div>Deposit Held: ${formatMoney(totals.securityDepositTotal, curr)}</div>` : ''}
    </div>`
    : '';

  const restaurantBlock = commerceMetadata?.tableNumber
    ? `
    <div style="font-size: 11px; margin: 4px 0; font-weight: bold; text-align: center;">
      Table: ${esc(commerceMetadata.tableNumber)} ${commerceMetadata.orderType ? `(${esc(commerceMetadata.orderType.toUpperCase())})` : ''}
    </div>`
    : '';

  return `
  <div style="width: 100%; max-width: 300px; font-family: monospace; font-size: 11px; line-height: 1.35; color: #000; margin: 0 auto; background: #fff; padding: 6px;">
    <div style="text-align: center;">
      <div style="font-size: 14px; font-weight: bold; text-transform: uppercase;">${esc(header.businessName)}</div>
      ${header.address ? `<div style="font-size: 10px;">${esc(header.address)}</div>` : ''}
      ${header.taxRegistration ? `<div style="font-size: 10px; font-weight: 600;">${esc(header.taxRegistration.label)}: ${esc(header.taxRegistration.value)}</div>` : ''}
      ${header.phone ? `<div style="font-size: 10px;">Ph: ${esc(header.phone)}</div>` : ''}
    </div>

    <div style="border-top: 1px solid #000; border-bottom: 1px solid #000; text-align: center; font-weight: bold; padding: 3px 0; margin: 6px 0; font-size: 12px;">
      ${esc(config.documentTitle || 'TAX INVOICE')}
    </div>

    <div style="display: flex; justify-content: space-between; font-size: 10px;">
      <span>Inv #: ${esc(header.invoiceNumber)}</span>
      <span>${formatDateTime(header.issueDate)}</span>
    </div>
    <div style="display: flex; justify-content: space-between; font-size: 10px;">
      <span>Order #: ${esc(header.orderNumber)}</span>
      ${header.cashierName ? `<span>Staff: ${esc(header.cashierName)}</span>` : ''}
    </div>
    ${customer ? `<div style="font-size: 10px;">Customer: ${esc(customer.name)}${customer.phone ? ` (${esc(customer.phone)})` : ''}</div>` : ''}

    ${rentalBlock}
    ${restaurantBlock}

    <table style="width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 11px;">
      <thead>
        <tr style="border-bottom: 1px solid #000; font-weight: bold;">
          <th style="text-align: left; padding: 2px 0;">Item</th>
          <th style="text-align: center; padding: 2px;">Qty</th>
          <th style="text-align: right; padding: 2px;">Rate</th>
          <th style="text-align: right; padding: 2px 0;">Amt</th>
        </tr>
      </thead>
      <tbody>
        ${itemRowsHtml}
      </tbody>
    </table>

    <div style="border-top: 1px solid #000; margin-top: 6px; padding-top: 4px; font-size: 11px;">
      ${totals.grossMrpTotal ? `<div style="display: flex; justify-content: space-between;"><span>Total MRP:</span><span>${formatMoney(totals.grossMrpTotal, curr)}</span></div>` : ''}
      ${totals.productDiscountTotal ? `<div style="display: flex; justify-content: space-between; color: #059669;"><span>Product Discount:</span><span>-${formatMoney(totals.productDiscountTotal, curr)}</span></div>` : ''}
      <div style="display: flex; justify-content: space-between;"><span>Subtotal:</span><span>${formatMoney(totals.subtotalNet, curr)}</span></div>
      ${totals.billDiscountTotal ? `<div style="display: flex; justify-content: space-between; color: #d97706;"><span>Bill Discount:</span><span>-${formatMoney(totals.billDiscountTotal, curr)}</span></div>` : ''}
      ${totals.taxTotal > 0 ? `<div style="display: flex; justify-content: space-between;"><span>Tax:</span><span>${formatMoney(totals.taxTotal, curr)}</span></div>` : ''}
      ${totals.securityDepositTotal ? `<div style="display: flex; justify-content: space-between;"><span>Security Deposit:</span><span>${formatMoney(totals.securityDepositTotal, curr)}</span></div>` : ''}
      ${totals.roundOff ? `<div style="display: flex; justify-content: space-between;"><span>Round Off:</span><span>${totals.roundOff > 0 ? '+' : ''}${formatMoney(totals.roundOff, curr)}</span></div>` : ''}

      <div style="border-top: 2px solid #000; border-bottom: 2px solid #000; font-weight: bold; font-size: 13px; display: flex; justify-content: space-between; padding: 3px 0; margin: 4px 0;">
        <span>NET PAYABLE</span>
        <span>${formatMoney(totals.netPayable, curr)}</span>
      </div>
    </div>

    <div style="font-size: 10px; margin-top: 4px;">
      <div style="font-weight: bold; text-transform: uppercase;">Payment</div>
      ${payment.payments.map((p) => `<div style="display: flex; justify-content: space-between;"><span>${esc(p.label || p.method)}:</span><span>${formatMoney(p.amount, curr)}</span></div>`).join('')}
      <div style="display: flex; justify-content: space-between; font-weight: bold;"><span>Paid:</span><span>${formatMoney(payment.totalPaid, curr)}</span></div>
      ${payment.balanceDue > 0 ? `<div style="display: flex; justify-content: space-between; font-weight: bold; color: #dc2626;"><span>Balance Due:</span><span>${formatMoney(payment.balanceDue, curr)}</span></div>` : ''}
      <div style="display: flex; justify-content: space-between; font-weight: bold;"><span>Status:</span><span>${esc(payment.status)}</span></div>
      ${payment.changeReturned ? `<div style="display: flex; justify-content: space-between;"><span>Change:</span><span>${formatMoney(payment.changeReturned, curr)}</span></div>` : ''}
    </div>

    ${config.footerNote ? `<div style="text-align: center; margin-top: 10px; font-size: 10px;">${esc(config.footerNote)}</div>` : ''}
  </div>`;
}

/**
 * Render Universal Invoice as Full A4 HTML string
 */
export function renderUniversalInvoiceA4Html(doc: UniversalInvoiceDocument): string {
  const { header, customer, items, totals, payment, config, commerceMetadata } = doc;
  const curr = config.currencySymbol;

  const itemRowsHtml = items
    .map((item, idx) => {
      const qtyStr =
        item.unitSymbol
          ? `${item.quantity} ${item.unitSymbol}`
          : item.quantity % 1 === 0
            ? String(item.quantity)
            : item.quantity.toFixed(2);
      const equivStr =
        item.equivalentBaseQuantity != null && item.equivalentBaseUnitSymbol
          ? `<div style="font-size:11px; color:#6b7280;">Equiv: ${item.equivalentBaseQuantity} ${item.equivalentBaseUnitSymbol}</div>`
          : '';
      const taxClassStr = item.taxClassification?.code
        ? `<div style="font-size:11px; color:#4b5563;">${esc(item.taxClassification.label || 'Code')}: ${esc(item.taxClassification.code)}</div>`
        : '';
      const serviceMeta = item.commerceMetadata?.durationLabel
        ? `<div style="font-size:11px; color:#1e40af; font-weight:500;">Duration: ${esc(item.commerceMetadata.durationLabel)}</div>`
        : item.commerceMetadata?.sessionsCount
          ? `<div style="font-size:11px; color:#1e40af; font-weight:500;">Sessions: ${item.commerceMetadata.sessionsCount}</div>`
          : '';
      const validityMeta = item.commerceMetadata?.validityStartDate
        ? `<div style="font-size:11px; color:#065f46; font-weight:500;">Validity: ${formatDate(item.commerceMetadata.validityStartDate)} &rarr; ${formatDate(item.commerceMetadata.validityEndDate)}</div>`
        : '';

      return `
      <tr style="border-bottom: 1px solid #e5e7eb;">
        <td style="padding: 10px 8px; text-align: center; color: #6b7280; font-family: monospace;">${idx + 1}</td>
        <td style="padding: 10px 8px; font-weight: 600; color: #111827;">
          <div>${esc(item.name)}</div>
          ${item.description ? `<div style="font-size: 11px; color: #6b7280; font-weight: normal;">${esc(item.description)}</div>` : ''}
          ${serviceMeta}
          ${validityMeta}
          ${equivStr}
        </td>
        <td style="padding: 10px 8px; text-align: center; font-family: monospace;">${taxClassStr || '—'}</td>
        <td style="padding: 10px 8px; text-align: center; font-family: monospace; font-weight: 600;">${esc(qtyStr)}</td>
        <td style="padding: 10px 8px; text-align: right; font-family: monospace;">${formatMoney(item.unitPrice, curr)}</td>
        <td style="padding: 10px 8px; text-align: right; font-family: monospace; color: #4b5563;">${item.taxRatePercent ? `${item.taxRatePercent}%` : '0%'}</td>
        <td style="padding: 10px 8px; text-align: right; font-weight: 700; font-family: monospace; color: #111827;">${formatMoney(item.lineTotal, curr)}</td>
      </tr>`;
    })
    .join('');

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>${esc(config.documentTitle || 'INVOICE')} - ${esc(header.invoiceNumber)}</title>
    <style>
      @page { size: A4; margin: 15mm; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; background: #fff; margin: 0; padding: 20px; font-size: 13px; }
      .box { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; background: #f9fafb; }
    </style>
  </head>
  <body>
    <!-- Header -->
    <div style="display: flex; justify-content: space-between; border-bottom: 2px solid #111827; padding-bottom: 16px;">
      <div>
        <h1 style="margin: 0; font-size: 22px; font-weight: 800; text-transform: uppercase;">${esc(header.businessName)}</h1>
        ${header.tagline ? `<p style="margin: 2px 0; font-size: 12px; color: #6b7280;">${esc(header.tagline)}</p>` : ''}
        ${header.address ? `<p style="margin: 4px 0; font-size: 12px; color: #4b5563; white-space: pre-wrap;">${esc(header.address)}</p>` : ''}
        ${header.taxRegistration ? `<p style="margin: 2px 0; font-size: 12px; font-weight: 600;">${esc(header.taxRegistration.label)}: ${esc(header.taxRegistration.value)}</p>` : ''}
        ${header.phone ? `<p style="margin: 2px 0; font-size: 12px; color: #4b5563;">Ph: ${esc(header.phone)}</p>` : ''}
        ${header.email ? `<p style="margin: 2px 0; font-size: 12px; color: #4b5563;">Email: ${esc(header.email)}</p>` : ''}
      </div>
      <div style="text-align: right;">
        <span style="display: inline-block; background: #111827; color: #fff; padding: 6px 14px; border-radius: 6px; font-weight: 800; font-size: 13px; text-transform: uppercase;">
          ${esc(config.documentTitle || 'TAX INVOICE')}
        </span>
        <p style="margin: 8px 0 2px 0; font-weight: 700; font-size: 13px;">Invoice #: <span style="font-family: monospace;">${esc(header.invoiceNumber)}</span></p>
        <p style="margin: 2px 0; color: #4b5563;">Order #: <span style="font-family: monospace;">${esc(header.orderNumber)}</span></p>
        <p style="margin: 2px 0; color: #4b5563;">Date: ${formatDateTime(header.issueDate)}</p>
        ${header.cashierName ? `<p style="margin: 2px 0; color: #4b5563;">Staff: ${esc(header.cashierName)}</p>` : ''}
      </div>
    </div>

    <!-- Bill To & Details -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0;">
      <div class="box">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin-bottom: 4px;">Billed To</div>
        <div style="font-weight: 700; font-size: 14px; color: #111827;">${esc(customer?.name || 'Walk-in Customer')}</div>
        ${customer?.phone ? `<div style="color: #4b5563; font-size: 12px;">Ph: ${esc(customer.phone)}</div>` : ''}
        ${customer?.email ? `<div style="color: #4b5563; font-size: 12px;">Email: ${esc(customer.email)}</div>` : ''}
        ${customer?.address ? `<div style="color: #4b5563; font-size: 12px;">${esc(customer.address)}</div>` : ''}
        ${customer?.taxRegistrationNumber ? `<div style="font-weight: 600; font-size: 12px; margin-top: 2px;">Tax ID: ${esc(customer.taxRegistrationNumber)}</div>` : ''}
      </div>

      <div class="box">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin-bottom: 4px;">Transaction Summary</div>
        <div style="font-size: 13px; font-weight: 700;">Status: <span style="color: ${payment.status === 'PAID' ? '#059669' : '#dc2626'};">${esc(payment.status)}</span></div>
        ${commerceMetadata?.rentalStartDate ? `<div style="font-size: 12px; margin-top: 4px;">Rental Period: <b>${formatDate(commerceMetadata.rentalStartDate)} &rarr; ${formatDate(commerceMetadata.rentalEndDate)}</b></div>` : ''}
        ${commerceMetadata?.tableNumber ? `<div style="font-size: 12px; margin-top: 4px;">Table: <b>${esc(commerceMetadata.tableNumber)}</b> ${commerceMetadata.orderType ? `(${esc(commerceMetadata.orderType)})` : ''}</div>` : ''}
        ${commerceMetadata?.returnReason ? `<div style="font-size: 12px; margin-top: 4px; color: #b91c1c;">Return Reason: <b>${esc(commerceMetadata.returnReason)}</b></div>` : ''}
      </div>
    </div>

    <!-- Item Table -->
    <table style="width: 100%; border-collapse: collapse; margin-top: 8px;">
      <thead>
        <tr style="background: #f3f4f6; border-top: 2px solid #111827; border-bottom: 2px solid #111827; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #374151;">
          <th style="padding: 8px; text-align: center;">#</th>
          <th style="padding: 8px; text-align: left;">Item Description</th>
          <th style="padding: 8px; text-align: center;">Tax Code</th>
          <th style="padding: 8px; text-align: center;">Qty</th>
          <th style="padding: 8px; text-align: right;">Rate</th>
          <th style="padding: 8px; text-align: right;">Tax %</th>
          <th style="padding: 8px; text-align: right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${itemRowsHtml}
      </tbody>
    </table>

    <!-- Totals & Payment Grid -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 20px;">
      <!-- Payment Breakdown -->
      <div class="box">
        <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #6b7280; margin-bottom: 8px;">Payment Details</div>
        ${payment.payments.map((p) => `<div style="display: flex; justify-content: space-between; padding: 2px 0; font-size: 12px;"><span>${esc(p.label || p.method)}</span><span style="font-family: monospace; font-weight: 600;">${formatMoney(p.amount, curr)}</span></div>`).join('')}
        <div style="border-top: 1px solid #e5e7eb; margin-top: 6px; padding-top: 6px; display: flex; justify-content: space-between; font-weight: 700; font-size: 13px;">
          <span>Total Paid:</span>
          <span style="font-family: monospace; color: #059669;">${formatMoney(payment.totalPaid, curr)}</span>
        </div>
        ${payment.balanceDue > 0 ? `<div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 13px; color: #dc2626; margin-top: 2px;"><span>Balance Due:</span><span style="font-family: monospace;">${formatMoney(payment.balanceDue, curr)}</span></div>` : ''}
      </div>

      <!-- Financial Totals -->
      <div style="font-size: 13px; space-y: 4px;">
        ${totals.grossMrpTotal ? `<div style="display: flex; justify-content: space-between; padding: 2px 0; color: #6b7280;"><span>Total MRP:</span><span style="font-family: monospace;">${formatMoney(totals.grossMrpTotal, curr)}</span></div>` : ''}
        ${totals.productDiscountTotal ? `<div style="display: flex; justify-content: space-between; padding: 2px 0; color: #059669; font-weight: 600;"><span>Product Discount:</span><span style="font-family: monospace;">-${formatMoney(totals.productDiscountTotal, curr)}</span></div>` : ''}
        <div style="display: flex; justify-content: space-between; padding: 2px 0; font-weight: 600;"><span>Subtotal (Net):</span><span style="font-family: monospace;">${formatMoney(totals.subtotalNet, curr)}</span></div>
        ${totals.billDiscountTotal ? `<div style="display: flex; justify-content: space-between; padding: 2px 0; color: #d97706; font-weight: 600;"><span>Bill Discount:</span><span style="font-family: monospace;">-${formatMoney(totals.billDiscountTotal, curr)}</span></div>` : ''}
        ${totals.taxTotal > 0 ? `<div style="display: flex; justify-content: space-between; padding: 2px 0; color: #4b5563;"><span>Tax:</span><span style="font-family: monospace;">${formatMoney(totals.taxTotal, curr)}</span></div>` : ''}
        ${totals.securityDepositTotal ? `<div style="display: flex; justify-content: space-between; padding: 2px 0; color: #1e40af; font-weight: 600;"><span>Security Deposit:</span><span style="font-family: monospace;">${formatMoney(totals.securityDepositTotal, curr)}</span></div>` : ''}
        ${totals.roundOff ? `<div style="display: flex; justify-content: space-between; padding: 2px 0; color: #6b7280;"><span>Round Off:</span><span style="font-family: monospace;">${totals.roundOff > 0 ? '+' : ''}${formatMoney(totals.roundOff, curr)}</span></div>` : ''}

        <div style="border-top: 2px solid #111827; border-bottom: 2px solid #111827; padding: 8px 0; margin-top: 8px; display: flex; justify-content: space-between; font-weight: 800; font-size: 16px;">
          <span>NET PAYABLE:</span>
          <span style="font-family: monospace;">${formatMoney(totals.netPayable, curr)}</span>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="margin-top: 36px; border-top: 1px solid #e5e7eb; padding-top: 12px; text-align: center; color: #6b7280; font-size: 11px;">
      ${config.footerNote ? `<p style="margin: 0; font-weight: 600; color: #374151;">${esc(config.footerNote)}</p>` : ''}
      <p style="margin: 4px 0 0 0;">This is a computer-generated invoice.</p>
    </div>
  </body>
  </html>`;
}
