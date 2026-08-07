/**
 * Universal POS — commerce mode registry.
 *
 * Adding a new business type = append a mode entry + field array here.
 * Controllers / React must read COMMERCE_SCHEMAS / isCommerceMode — not hardcode unions.
 */

import { SELL_UNIT_OPTIONS } from './sell-units';

export type CommerceFieldKey = {
  key: string;
  label: string;
  required: boolean;
  type: 'string' | 'text' | 'number' | 'category' | 'image' | 'select';
  hint?: string;
  options?: Array<{ value: string; label: string }>;
};

export type CommerceSchemaEntry = {
  mode: string;
  label: string;
  description: string;
  fields: CommerceFieldKey[];
  categoryExamples: readonly string[];
  /** Optional lifecycle states (rental / service booking, etc.) */
  lifecycle?: readonly string[];
  /** Module codes enabled when this mode is on */
  moduleStack: readonly string[];
};

/** Soft suggestions only — shops invent their own categories. */
export const UNIVERSAL_CATEGORY_EXAMPLES = [
  'Food',
  'Apparel',
  'Parts',
  'Services',
  'Accessories',
  'General',
] as const;

export const SALE_PRODUCT_FIELDS: CommerceFieldKey[] = [
  {
    key: 'title',
    label: 'Title',
    required: true,
    type: 'string',
    hint: 'Product name customers see (e.g. Basmati rice)',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    type: 'text',
  },
  {
    key: 'categoryId',
    label: 'Category',
    required: true,
    type: 'category',
    hint: 'You create categories for your business',
  },
  {
    key: 'sku',
    label: 'SKU / code',
    required: true,
    type: 'string',
    hint: 'Letters, numbers, . _ - / (e.g. RICE-1KG)',
  },
  {
    key: 'sellUnit',
    label: 'Sell unit',
    required: true,
    type: 'select',
    hint: 'Grocery: use kg / g / L. Packaged goods: pcs or pack',
    options: SELL_UNIT_OPTIONS.map((o) => ({
      value: o.value,
      label: o.label,
    })),
  },
  {
    key: 'price',
    label: 'Sell price',
    required: true,
    type: 'number',
    hint: 'Price per unit (per kg if unit is kg)',
  },
  {
    key: 'qty',
    label: 'Qty on hand',
    required: true,
    type: 'number',
    hint: 'kg/L allow decimals (2.5); pcs/pack must be whole numbers',
  },
  {
    key: 'image',
    label: 'Product image',
    required: false,
    type: 'image',
    hint: 'Optional photo for any product',
  },
];

export const RENTAL_PRODUCT_FIELDS: CommerceFieldKey[] = [
  {
    key: 'title',
    label: 'Title',
    required: true,
    type: 'string',
    hint: 'Item name customers see',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    type: 'text',
  },
  {
    key: 'categoryId',
    label: 'Category',
    required: true,
    type: 'category',
    hint: 'You invent categories for your business',
  },
  {
    key: 'sku',
    label: 'SKU / style code',
    required: true,
    type: 'string',
  },
  {
    key: 'rentalPrice',
    label: 'Rental price',
    required: true,
    type: 'number',
    hint: 'Per rental period (day/event — your pricing)',
  },
  {
    key: 'deposit',
    label: 'Deposit',
    required: false,
    type: 'number',
    hint: 'Security deposit when used',
  },
  {
    key: 'barcode',
    label: 'Unit barcode',
    required: true,
    type: 'string',
    hint: 'One physical unit',
  },
  {
    key: 'variant',
    label: 'Variant',
    required: false,
    type: 'string',
    hint: 'Size, colour, model, or any variant label',
  },
  {
    key: 'image',
    label: 'Product image',
    required: false,
    type: 'image',
    hint: 'Optional photo',
  },
];

/** Bookable / billable services (salon, clinic, consulting). */
export const SERVICE_PRODUCT_FIELDS: CommerceFieldKey[] = [
  {
    key: 'title',
    label: 'Service name',
    required: true,
    type: 'string',
    hint: 'What the customer books or buys',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    type: 'text',
  },
  {
    key: 'categoryId',
    label: 'Category',
    required: true,
    type: 'category',
    hint: 'e.g. Hair, Consult, Repair',
  },
  {
    key: 'sku',
    label: 'Service code',
    required: true,
    type: 'string',
  },
  {
    key: 'price',
    label: 'Price',
    required: true,
    type: 'number',
  },
  {
    key: 'durationMinutes',
    label: 'Duration (minutes)',
    required: false,
    type: 'number',
    hint: 'Optional booking length',
  },
  {
    key: 'image',
    label: 'Image',
    required: false,
    type: 'image',
  },
];

/** Recurring plans / memberships. */
export const SUBSCRIPTION_PRODUCT_FIELDS: CommerceFieldKey[] = [
  {
    key: 'title',
    label: 'Plan name',
    required: true,
    type: 'string',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    type: 'text',
  },
  {
    key: 'categoryId',
    label: 'Category',
    required: true,
    type: 'category',
  },
  {
    key: 'sku',
    label: 'Plan code',
    required: true,
    type: 'string',
  },
  {
    key: 'price',
    label: 'Price per period',
    required: true,
    type: 'number',
  },
  {
    key: 'billingPeriod',
    label: 'Billing period (days)',
    required: true,
    type: 'number',
    hint: 'e.g. 30 = monthly',
  },
  {
    key: 'image',
    label: 'Image',
    required: false,
    type: 'image',
  },
];

export const RENTAL_LIFECYCLE_STATES = [
  'quote',
  'reserved',
  'fitted',
  'ready',
  'checked_out',
  'returned',
  'inspected',
  'closed',
  'cancelled',
] as const;

export const SERVICE_LIFECYCLE_STATES = [
  'booked',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;

const SALE_MODULE_STACK = [
  'catalog',
  'inventory',
  'orders',
  'payments',
  'pos',
  'reports',
  'notify',
] as const;

const RENTAL_MODULE_STACK = [
  'catalog',
  'inventory',
  'orders',
  'payments',
  'pos',
  'rental',
] as const;

const SERVICE_MODULE_STACK = [
  'catalog',
  'orders',
  'payments',
  'pos',
  'appointments',
] as const;

const SUBSCRIPTION_MODULE_STACK = [
  'catalog',
  'orders',
  'payments',
  'pos',
] as const;

/**
 * Open registry — add a fifth mode by appending an entry.
 * Keys are mode codes stored on tenant.settings.commerceModes.
 */
export const COMMERCE_SCHEMAS: Record<string, CommerceSchemaEntry> = {
  sale: {
    mode: 'sale',
    label: 'Sell products',
    description:
      'Universal catalog — any business creates categories and sells with qty stock',
    fields: SALE_PRODUCT_FIELDS,
    categoryExamples: UNIVERSAL_CATEGORY_EXAMPLES,
    moduleStack: SALE_MODULE_STACK,
  },
  rental: {
    mode: 'rental',
    label: 'Rent items',
    description: 'Serialized units, deposits, checkout and returns',
    fields: RENTAL_PRODUCT_FIELDS,
    categoryExamples: UNIVERSAL_CATEGORY_EXAMPLES,
    lifecycle: RENTAL_LIFECYCLE_STATES,
    moduleStack: RENTAL_MODULE_STACK,
  },
  service: {
    mode: 'service',
    label: 'Bookable services',
    description: 'Appointments / timed services billed at the counter',
    fields: SERVICE_PRODUCT_FIELDS,
    categoryExamples: UNIVERSAL_CATEGORY_EXAMPLES,
    lifecycle: SERVICE_LIFECYCLE_STATES,
    moduleStack: SERVICE_MODULE_STACK,
  },
  subscription: {
    mode: 'subscription',
    label: 'Subscriptions',
    description: 'Recurring plans and memberships',
    fields: SUBSCRIPTION_PRODUCT_FIELDS,
    categoryExamples: UNIVERSAL_CATEGORY_EXAMPLES,
    moduleStack: SUBSCRIPTION_MODULE_STACK,
  },
};

/** Registered mode codes (derived — never maintain a parallel list). */
export const REGISTERED_COMMERCE_MODES = Object.keys(COMMERCE_SCHEMAS);

/** Extensible mode id — validated against COMMERCE_SCHEMAS, not a closed TS union. */
export type CommerceMode = string;

export function isCommerceMode(value: unknown): value is string {
  return typeof value === 'string' && value in COMMERCE_SCHEMAS;
}

export function getCommerceSchema(mode: string): CommerceSchemaEntry | null {
  return COMMERCE_SCHEMAS[mode] ?? null;
}

export function moduleStackForMode(mode: string): readonly string[] {
  return COMMERCE_SCHEMAS[mode]?.moduleStack ?? [];
}

/** Kept for API compatibility; same neutral list. */
export const RENTAL_CATEGORY_EXAMPLES = UNIVERSAL_CATEGORY_EXAMPLES;

export function parseCommerceModes(settings: unknown): {
  modes: string[];
  setupComplete: boolean;
} {
  const s = (settings ?? {}) as Record<string, unknown>;
  const raw = s.commerceModes;
  if (Array.isArray(raw)) {
    const modes = raw.filter(isCommerceMode);
    if (modes.length) {
      return { modes: [...new Set(modes)], setupComplete: true };
    }
  }
  return { modes: [], setupComplete: false };
}
