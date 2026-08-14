export const JOURNAL_SOURCE = {
  SALE: 'SALE',
  CREDIT_SALE: 'CREDIT_SALE',
  CUSTOMER_PAYMENT: 'CUSTOMER_PAYMENT',
  PURCHASE: 'PURCHASE',
  PURCHASE_RETURN: 'PURCHASE_RETURN',
  SALE_RETURN: 'SALE_RETURN',
  SUPPLIER_PAYMENT: 'SUPPLIER_PAYMENT',
  EXPENSE: 'EXPENSE',
  INVENTORY_COGS: 'INVENTORY_COGS',
  MANUAL: 'MANUAL',
  REVERSAL: 'REVERSAL',
  RENTAL: 'RENTAL',
  SUBSCRIPTION: 'SUBSCRIPTION',
  DEPOSIT: 'DEPOSIT',
} as const;

export type JournalSourceType =
  (typeof JOURNAL_SOURCE)[keyof typeof JOURNAL_SOURCE];

/** Configurable mapping keys — not industry names. */
export const MAP = {
  cash: 'cash',
  bank: 'bank',
  upi: 'upi',
  card: 'card',
  wallet: 'wallet',
  gift_card: 'gift_card',
  store_credit: 'store_credit',
  other_tender: 'other_tender',
  ar: 'ar',
  ap: 'ap',
  sales: 'sales',
  service_revenue: 'service_revenue',
  rental_revenue: 'rental_revenue',
  subscription_revenue: 'subscription_revenue',
  output_gst: 'output_gst',
  input_gst: 'input_gst',
  output_cgst: 'output_cgst',
  output_sgst: 'output_sgst',
  output_igst: 'output_igst',
  output_cess: 'output_cess',
  input_cgst: 'input_cgst',
  input_sgst: 'input_sgst',
  input_igst: 'input_igst',
  inventory: 'inventory',
  cogs: 'cogs',
  sales_return: 'sales_return',
  purchase: 'purchase',
  purchase_return: 'purchase_return',
  discounts: 'discounts',
  customer_advances: 'customer_advances',
  deposits: 'deposits',
  expense_default: 'expense_default',
  retained_earnings: 'retained_earnings',
} as const;

export type MappingKey = (typeof MAP)[keyof typeof MAP];

export const PAYMENT_METHOD_MAP: Record<string, MappingKey> = {
  cash: MAP.cash,
  card: MAP.card,
  upi: MAP.upi,
  bank_transfer: MAP.bank,
  gateway: MAP.bank,
  store_credit: MAP.store_credit,
  gift_card: MAP.gift_card,
  wallet: MAP.wallet,
  qr: MAP.upi,
  emi: MAP.bank,
  other: MAP.other_tender,
  petty_cash: MAP.cash,
  collect_later: MAP.ar,
};

export const INTEGRATION_PROVIDERS = [
  'TALLY',
  'QUICKBOOKS',
  'ZOHO_BOOKS',
] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
