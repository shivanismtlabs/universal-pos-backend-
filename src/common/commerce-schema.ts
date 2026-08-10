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
  'Accessories',
  'Apparel',
  'Consumables',
  'Equipment',
  'General merchandise',
  'Services',
] as const;

export const SALE_PRODUCT_FIELDS: CommerceFieldKey[] = [
  {
    key: 'title',
    label: 'Product name',
    required: true,
    type: 'string',
    hint: 'Display name shown on the counter and receipts',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    type: 'text',
    hint: 'Optional details for staff (not required for sale)',
  },
  {
    key: 'categoryId',
    label: 'Category',
    required: true,
    type: 'category',
    hint: 'Group this item with similar products',
  },
  {
    key: 'sku',
    label: 'SKU',
    required: true,
    type: 'string',
    hint: '15–18 characters · letters, numbers, and . _ - /',
  },
  {
    key: 'sellUnit',
    label: 'Unit of measure',
    required: true,
    type: 'select',
    hint: 'Use pcs/pack for countable items · kg, g, L, or ml for measured goods',
    options: SELL_UNIT_OPTIONS.map((o) => ({
      value: o.value,
      label: o.label,
    })),
  },
  {
    key: 'price',
    label: 'Selling price',
    required: true,
    type: 'number',
    hint: 'Price charged per unit of measure',
  },
  {
    key: 'qty',
    label: 'Quantity on hand',
    required: true,
    type: 'number',
    hint: 'Whole numbers for pcs/pack · up to three decimals for kg/L',
  },
  {
    key: 'image',
    label: 'Product images',
    required: false,
    type: 'image',
    hint: 'Optional · up to eight photos · first image is the cover',
  },
];

export const RENTAL_PRODUCT_FIELDS: CommerceFieldKey[] = [
  {
    key: 'title',
    label: 'Item name',
    required: true,
    type: 'string',
    hint: 'Name shown when staffing rentals and on order documents',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    type: 'text',
    hint: 'Optional notes for staff',
  },
  {
    key: 'categoryId',
    label: 'Category',
    required: true,
    type: 'category',
    hint: 'Group similar rental inventory',
  },
  {
    key: 'sku',
    label: 'Style / SKU',
    required: true,
    type: 'string',
    hint: '15–18 characters · unique within your shop',
  },
  {
    key: 'rentalPrice',
    label: 'Rental price',
    required: true,
    type: 'number',
    hint: 'Charge per rental period (day, event, or your own rules)',
  },
  {
    key: 'deposit',
    label: 'Security deposit',
    required: false,
    type: 'number',
    hint: 'Optional amount held and settled on return',
  },
  {
    key: 'barcode',
    label: 'Unit barcode',
    required: true,
    type: 'string',
    hint: 'Unique barcode for this physical unit',
  },
  {
    key: 'variant',
    label: 'Variant',
    required: false,
    type: 'string',
    hint: 'Size, colour, model, or other variant label',
  },
  {
    key: 'image',
    label: 'Product image',
    required: false,
    type: 'image',
    hint: 'Optional photograph of the item',
  },
];

/** Bookable / billable services (salon, clinic, consulting). */
export const SERVICE_PRODUCT_FIELDS: CommerceFieldKey[] = [
  {
    key: 'title',
    label: 'Service name',
    required: true,
    type: 'string',
    hint: 'Name customers see when booking or paying',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    type: 'text',
    hint: 'Optional details for staff or customers',
  },
  {
    key: 'categoryId',
    label: 'Category',
    required: true,
    type: 'category',
    hint: 'Group related services',
  },
  {
    key: 'sku',
    label: 'Service code',
    required: true,
    type: 'string',
    hint: '15–18 characters · unique within your shop',
  },
  {
    key: 'price',
    label: 'Price',
    required: true,
    type: 'number',
    hint: 'Standard charge for this service',
  },
  {
    key: 'durationMinutes',
    label: 'Duration (minutes)',
    required: false,
    type: 'number',
    hint: 'Optional scheduled length for appointments',
  },
  {
    key: 'image',
    label: 'Image',
    required: false,
    type: 'image',
    hint: 'Optional image for the service menu',
  },
];

/** Recurring plans / memberships. */
export const SUBSCRIPTION_PRODUCT_FIELDS: CommerceFieldKey[] = [
  {
    key: 'title',
    label: 'Plan name',
    required: true,
    type: 'string',
    hint: 'Membership or plan name shown to customers',
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    type: 'text',
    hint: 'Optional benefits summary',
  },
  {
    key: 'categoryId',
    label: 'Category',
    required: true,
    type: 'category',
    hint: 'Group related plans',
  },
  {
    key: 'sku',
    label: 'Plan code',
    required: true,
    type: 'string',
    hint: '15–18 characters · unique within your shop',
  },
  {
    key: 'price',
    label: 'Price per period',
    required: true,
    type: 'number',
    hint: 'Amount billed for each billing period',
  },
  {
    key: 'billingPeriod',
    label: 'Billing period (days)',
    required: true,
    type: 'number',
    hint: 'Length of one period in days (for example, 30 for monthly)',
  },
  {
    key: 'image',
    label: 'Image',
    required: false,
    type: 'image',
    hint: 'Optional image for the plan catalog',
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
    label: 'Product sales',
    description:
      'Product catalogue with categories, pricing, and quantity stock for counter sales',
    fields: SALE_PRODUCT_FIELDS,
    categoryExamples: UNIVERSAL_CATEGORY_EXAMPLES,
    moduleStack: SALE_MODULE_STACK,
  },
  rental: {
    mode: 'rental',
    label: 'Equipment rental',
    description:
      'Serialized inventory with deposits, checkout, and returns',
    fields: RENTAL_PRODUCT_FIELDS,
    categoryExamples: UNIVERSAL_CATEGORY_EXAMPLES,
    lifecycle: RENTAL_LIFECYCLE_STATES,
    moduleStack: RENTAL_MODULE_STACK,
  },
  service: {
    mode: 'service',
    label: 'Services',
    description:
      'Bookable and billable services with optional appointments',
    fields: SERVICE_PRODUCT_FIELDS,
    categoryExamples: UNIVERSAL_CATEGORY_EXAMPLES,
    lifecycle: SERVICE_LIFECYCLE_STATES,
    moduleStack: SERVICE_MODULE_STACK,
  },
  subscription: {
    mode: 'subscription',
    label: 'Customer memberships',
    description:
      'Membership plans you sell to your customers (enroll, renew, bill) — not the SaaS fee for Universal POS',
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
