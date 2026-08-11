/**
 * BusinessConfig — Zoho-style “one engine, many verticals via config”.
 *
 * Hard rules:
 * - Core stays generic: Item · Order · Payment · Customer · Inventory
 * - Extra fields live on `meta` JSON (entities already have meta columns)
 * - New business type = new entry in BUSINESS_CONFIG_REGISTRY — no core if/else
 * - Commerce modes (sale|rental|service|subscription) stay capability layers
 *
 * UI / billing should read resolved BusinessConfig, not hardcode “restaurant”.
 */

import { isCommerceMode } from './commerce-schema';

/** Profile label for setup — not a separate monorepo per industry */
export type BusinessTypeId =
  | 'retail'
  | 'grocery'
  | 'restaurant'
  | 'salon'
  | 'service'
  | 'general'
  | 'other';

export type BillingStyle =
  | 'counter' // sell → pay at till
  | 'table' // order linked to seat / table
  | 'appointment' // time-booked services
  | 'rental_checkout'; // deposit + return cycle

export type ScreenId =
  | 'home'
  | 'items'
  | 'counter'
  | 'orders'
  | 'customers'
  | 'inventory'
  | 'appointments'
  | 'reports'
  | 'settings';

export type MetaFieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'datetime';

/** Dynamic attribute — stored under entity.meta[field.key] */
export type MetaFieldDef = {
  key: string;
  label: string;
  type: MetaFieldType;
  required?: boolean;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  /** Which core entity this extends */
  entity: 'item' | 'order' | 'customer' | 'payment' | 'inventory';
};

export type BusinessConfig = {
  /** Registry id — add new vertical by adding another object only */
  id: BusinessTypeId | string;
  label: string;
  description: string;
  /** Default commerce mode(s) when this profile is chosen at setup */
  defaultCommerceModes: string[];
  billing: {
    style: BillingStyle;
    allowSplitTender: boolean;
    allowParkCart: boolean;
    requireCustomer: boolean;
  };
  /** Screens visible in shell (config-driven nav / gates) */
  screens: ScreenId[];
  /** Extra fields on Item/Order/… via meta — no hardcoded columns per vertical */
  metaFields: MetaFieldDef[];
  /** Soft UX copy for Getting Started */
  gettingStartedHints?: string[];
};

/**
 * Built-in profiles. Adding “pharmacy” later = append here (+ optional modes),
 * not a new Items microservice.
 */
export const BUSINESS_CONFIG_REGISTRY: Record<string, BusinessConfig> = {
  general: {
    id: 'general',
    label: 'General business',
    description: 'Any shop — universal catalog, counter, and stock',
    defaultCommerceModes: ['sale'],
    billing: {
      style: 'counter',
      allowSplitTender: true,
      allowParkCart: true,
      requireCustomer: false,
    },
    screens: [
      'home',
      'items',
      'counter',
      'orders',
      'customers',
      'inventory',
      'reports',
      'settings',
    ],
    metaFields: [],
    gettingStartedHints: [
      'Add categories and items',
      'Open the counter and take your first sale',
    ],
  },
  /** Same engine as general — preferred UI id for "Other" */
  other: {
    id: 'other',
    label: 'Other / general',
    description:
      'Any industry — start universal, add your own item fields',
    defaultCommerceModes: ['sale'],
    billing: {
      style: 'counter',
      allowSplitTender: true,
      allowParkCart: true,
      requireCustomer: false,
    },
    screens: [
      'home',
      'items',
      'counter',
      'orders',
      'customers',
      'inventory',
      'reports',
      'settings',
    ],
    metaFields: [],
    gettingStartedHints: [
      'Add custom item fields if your catalog needs them',
      'Open the counter and take your first sale',
    ],
  },
  retail: {
    id: 'retail',
    label: 'Retail',
    description: 'Apparel, electronics, gift shops — catalog + counter',
    defaultCommerceModes: ['sale'],
    billing: {
      style: 'counter',
      allowSplitTender: true,
      allowParkCart: true,
      requireCustomer: false,
    },
    screens: [
      'home',
      'items',
      'counter',
      'orders',
      'customers',
      'inventory',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'item',
        key: 'brand',
        label: 'Brand',
        type: 'string',
        required: false,
      },
      {
        entity: 'item',
        key: 'size',
        label: 'Size / variant',
        type: 'string',
        required: false,
        hint: 'Optional size, colour, or pack label',
      },
      {
        entity: 'item',
        key: 'color',
        label: 'Colour',
        type: 'string',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Import items or add SKUs with optional size/colour',
      'Sell at the counter with stock on hand',
    ],
  },
  grocery: {
    id: 'grocery',
    label: 'Grocery / F&B retail',
    description: 'Measured and packed goods — unit-heavy stock',
    defaultCommerceModes: ['sale'],
    billing: {
      style: 'counter',
      allowSplitTender: true,
      allowParkCart: true,
      requireCustomer: false,
    },
    screens: [
      'home',
      'items',
      'counter',
      'orders',
      'customers',
      'inventory',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'item',
        key: 'packSize',
        label: 'Pack size',
        type: 'string',
        required: false,
      },
      {
        entity: 'item',
        key: 'expiryTracked',
        label: 'Track expiry',
        type: 'boolean',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Prefer kg/g/L/ml sell units where needed',
      'Use low-stock filters on Items',
    ],
  },
  restaurant: {
    id: 'restaurant',
    label: 'Restaurant / café',
    description: 'Menu items + table billing style (still same Order engine)',
    defaultCommerceModes: ['sale'],
    billing: {
      style: 'table',
      allowSplitTender: true,
      allowParkCart: true,
      requireCustomer: false,
    },
    screens: [
      'home',
      'items',
      'counter',
      'orders',
      'customers',
      'inventory',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'item',
        key: 'kitchenStation',
        label: 'Kitchen station',
        type: 'select',
        required: false,
        options: [
          { value: 'hot', label: 'Hot kitchen' },
          { value: 'cold', label: 'Cold / prep' },
          { value: 'bar', label: 'Bar' },
          { value: 'none', label: 'No kitchen ticket' },
        ],
      },
      {
        entity: 'order',
        key: 'tableNumber',
        label: 'Table number',
        type: 'string',
        required: false,
        hint: 'Optional seat / table for dine-in',
      },
      {
        entity: 'order',
        key: 'covers',
        label: 'Covers (guests)',
        type: 'number',
        required: false,
      },
      {
        entity: 'order',
        key: 'courseNote',
        label: 'Service note',
        type: 'text',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Build menu Items (same catalog engine)',
      'Use table number on orders via meta — no separate restaurant codebase',
    ],
  },
  salon: {
    id: 'salon',
    label: 'Salon / spa',
    description: 'Services + appointments over shared service mode',
    defaultCommerceModes: ['service', 'sale'],
    billing: {
      style: 'appointment',
      allowSplitTender: true,
      allowParkCart: false,
      requireCustomer: true,
    },
    screens: [
      'home',
      'items',
      'counter',
      'orders',
      'customers',
      'appointments',
      'inventory',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'item',
        key: 'durationMinutes',
        label: 'Duration (minutes)',
        type: 'number',
        required: false,
      },
      {
        entity: 'item',
        key: 'staffSkill',
        label: 'Skill / role tag',
        type: 'string',
        required: false,
      },
      {
        entity: 'order',
        key: 'stylistUserId',
        label: 'Assigned staff',
        type: 'string',
        required: false,
      },
      {
        entity: 'order',
        key: 'appointmentAt',
        label: 'Appointment time',
        type: 'datetime',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Add services as Items under service mode',
      'Require customer on billing when appointment style is active',
    ],
  },
  service: {
    id: 'service',
    label: 'Service business',
    description: 'Generic billable services without industry pack',
    defaultCommerceModes: ['service'],
    billing: {
      style: 'appointment',
      allowSplitTender: true,
      allowParkCart: true,
      requireCustomer: true,
    },
    screens: [
      'home',
      'items',
      'counter',
      'orders',
      'customers',
      'appointments',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'item',
        key: 'durationMinutes',
        label: 'Duration (minutes)',
        type: 'number',
        required: false,
      },
      {
        entity: 'order',
        key: 'jobRef',
        label: 'Job / ticket ref',
        type: 'string',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Define services in catalog',
      'Capture customer before bill when required',
    ],
  },
};

export function listBusinessConfigs(): BusinessConfig[] {
  return Object.values(BUSINESS_CONFIG_REGISTRY);
}

export function getBusinessConfig(id: string | null | undefined): BusinessConfig {
  if (id && BUSINESS_CONFIG_REGISTRY[id]) {
    return BUSINESS_CONFIG_REGISTRY[id];
  }
  return BUSINESS_CONFIG_REGISTRY.general;
}

export function isBusinessTypeId(value: unknown): value is string {
  return typeof value === 'string' && value in BUSINESS_CONFIG_REGISTRY;
}

/** Read tenant.settings.businessType / businessConfigId */
export function parseBusinessType(settings: unknown): string {
  const s = (settings ?? {}) as Record<string, unknown>;
  const raw = s.businessType ?? s.businessConfigId;
  if (isBusinessTypeId(raw)) return raw;
  return 'general';
}

/**
 * Merge: registry profile + optional tenant.settings.businessConfigOverrides
 * (merchant can turn fields off later without forking code).
 */
export function resolveBusinessConfig(settings: unknown): BusinessConfig {
  const base = getBusinessConfig(parseBusinessType(settings));
  const s = (settings ?? {}) as Record<string, unknown>;
  const overrides = s.businessConfigOverrides as
    | Partial<BusinessConfig>
    | undefined;
  if (!overrides || typeof overrides !== 'object') {
    return base;
  }

  return {
    ...base,
    ...overrides,
    id: base.id,
    billing: { ...base.billing, ...(overrides.billing ?? {}) },
    screens: overrides.screens ?? base.screens,
    metaFields: overrides.metaFields ?? base.metaFields,
    defaultCommerceModes: (
      overrides.defaultCommerceModes ?? base.defaultCommerceModes
    ).filter(isCommerceMode),
  };
}

export function metaFieldsFor(
  config: BusinessConfig,
  entity: MetaFieldDef['entity'],
): MetaFieldDef[] {
  return config.metaFields.filter((f) => f.entity === entity);
}

/** Shape stored in business_configs rows (matches ERD BUSINESS_CONFIG) */
export type BusinessConfigRowPayload = {
  businessType: string;
  itemFields: MetaFieldDef[];
  orderFields: MetaFieldDef[];
  uiFlow: {
    screens: ScreenId[];
    billingStyle: BillingStyle;
    gettingStartedHints?: string[];
  };
  billing: BusinessConfig['billing'];
};

export function registryToDbPayload(config: BusinessConfig): BusinessConfigRowPayload {
  return {
    businessType: config.id,
    itemFields: metaFieldsFor(config, 'item'),
    orderFields: metaFieldsFor(config, 'order'),
    uiFlow: {
      screens: config.screens as ScreenId[],
      billingStyle: config.billing.style,
      gettingStartedHints: config.gettingStartedHints,
    },
    billing: config.billing,
  };
}

/** Build runtime BusinessConfig from DB row (overrides registry defaults) */
export function configFromDbRow(row: {
  businessType: string;
  itemFields: unknown;
  orderFields: unknown;
  uiFlow: unknown;
  billing: unknown;
}): BusinessConfig {
  const base = getBusinessConfig(row.businessType);
  const itemFields = Array.isArray(row.itemFields)
    ? (row.itemFields as MetaFieldDef[])
    : metaFieldsFor(base, 'item');
  const orderFields = Array.isArray(row.orderFields)
    ? (row.orderFields as MetaFieldDef[])
    : metaFieldsFor(base, 'order');
  const ui = (row.uiFlow ?? {}) as Record<string, unknown>;
  const billing = {
    ...base.billing,
    ...((row.billing as object) ?? {}),
  } as BusinessConfig['billing'];

  return {
    ...base,
    id: row.businessType || base.id,
    billing,
    screens: Array.isArray(ui.screens)
      ? (ui.screens as ScreenId[])
      : base.screens,
    metaFields: [
      ...itemFields.map((f) => ({ ...f, entity: 'item' as const })),
      ...orderFields.map((f) => ({ ...f, entity: 'order' as const })),
    ],
    gettingStartedHints: Array.isArray(ui.gettingStartedHints)
      ? (ui.gettingStartedHints as string[])
      : base.gettingStartedHints,
  };
}

/** Public form schema for FE dynamic renderer */
export function formSchemaFromConfig(config: BusinessConfig) {
  return {
    businessType: config.id,
    label: config.label,
    item_fields: metaFieldsFor(config, 'item'),
    order_fields: metaFieldsFor(config, 'order'),
    ui_flow: {
      screens: config.screens,
      billingStyle: config.billing.style,
      requireCustomer: config.billing.requireCustomer,
      allowParkCart: config.billing.allowParkCart,
      allowSplitTender: config.billing.allowSplitTender,
    },
    core_entities: ['item', 'order', 'payment', 'customer', 'inventory'] as const,
    /** Values persist into products.meta / orders.meta (= ERD extra_fields) */
    storage: {
      itemExtraFieldsColumn: 'products.meta',
      orderExtraFieldsColumn: 'orders.meta',
    },
  };
}

/** Public catalog for setup UI (no private internals) */
export function businessConfigCatalog() {
  return listBusinessConfigs().map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    defaultCommerceModes: c.defaultCommerceModes,
    billingStyle: c.billing.style,
    screens: c.screens,
  }));
}
