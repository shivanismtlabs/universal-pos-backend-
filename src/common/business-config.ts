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
import {
  BUSINESS_TYPE_CAPABILITY_DEFAULTS,
  type CapabilityCode,
} from './capabilities';

/** Profile label for setup — not a separate monorepo per industry */
export type BusinessTypeId =
  | 'retail'
  | 'grocery'
  | 'restaurant'
  | 'salon'
  | 'service'
  | 'general'
  | 'other'
  | 'gym'
  | 'rental'
  | 'repair'
  | 'pharmacy'
  | 'furniture'
  | 'coaching'
  | 'spa'
  | 'event'
  | 'laundry'
  | 'pet_grooming'
  | 'photography'
  | 'car_wash'
  | 'coworking';

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
  | 'resources'
  | 'memberships'
  | 'jobs'
  | 'kitchen'
  | 'restaurant'
  | 'check_in'
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
  /**
   * Setup recommendation only — runtime uses tenant.settings.capabilities.
   * Never branch core engines on businessType; use hasCapability().
   */
  defaultCapabilities?: CapabilityCode[];
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
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.general,
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
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.other,
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
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.retail,
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
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.grocery,
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
      'resources',
      'kitchen',
      'restaurant',
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
        entity: 'item',
        key: 'stockClass',
        label: 'Stock class',
        type: 'select',
        required: false,
        options: [
          { value: 'finished', label: 'Finished / menu item' },
          { value: 'ingredient', label: 'Ingredient' },
          { value: 'raw_material', label: 'Raw material' },
          { value: 'semi_finished', label: 'Semi-finished' },
          { value: 'packaging', label: 'Packaging' },
          { value: 'consumable', label: 'Consumable' },
        ],
      },
      {
        entity: 'item',
        key: 'dineInPrice',
        label: 'Dine-in price',
        type: 'number',
        required: false,
      },
      {
        entity: 'item',
        key: 'takeawayPrice',
        label: 'Takeaway price',
        type: 'number',
        required: false,
      },
      {
        entity: 'item',
        key: 'deliveryPrice',
        label: 'Delivery price',
        type: 'number',
        required: false,
      },
      {
        entity: 'item',
        key: 'prepNotes',
        label: 'Prep notes',
        type: 'text',
        required: false,
      },
      {
        entity: 'item',
        key: 'soldOut',
        label: '86 / sold out',
        type: 'boolean',
        required: false,
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
      'Enable Tables + KOT in Capabilities, then open Dining floor',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.restaurant,
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
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.salon,
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
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.service,
  },
  gym: {
    id: 'gym',
    label: 'Gym / fitness',
    description:
      'Retail items + training services + memberships (sale, service, subscription)',
    defaultCommerceModes: ['sale', 'service', 'subscription'],
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
      'memberships',
      'check_in',
      'appointments',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'customer',
        key: 'membershipId',
        label: 'Membership ID',
        type: 'string',
        required: false,
      },
      {
        entity: 'customer',
        key: 'fitnessGoal',
        label: 'Fitness goal',
        type: 'string',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Create membership plans as subscription products',
      'Enable check-in for active members',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.gym,
  },
  rental: {
    id: 'rental',
    label: 'Rental business',
    description: 'Issue / return assets with deposits — not permanent sale',
    defaultCommerceModes: ['rental', 'sale'],
    billing: {
      style: 'rental_checkout',
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
      'inventory',
      'resources',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'customer',
        key: 'idProof',
        label: 'ID proof ref',
        type: 'string',
        required: false,
      },
      {
        entity: 'order',
        key: 'rentalEndsAt',
        label: 'Rental end',
        type: 'datetime',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Enable rental mode and track units as available / rented / damaged',
      'Collect deposits separately from rental charges',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.rental,
  },
  repair: {
    id: 'repair',
    label: 'Repair / service shop',
    description: 'Customer assets + work jobs + parts/labor',
    defaultCommerceModes: ['service', 'sale'],
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
      'jobs',
      'inventory',
      'appointments',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'customer',
        key: 'preferredContact',
        label: 'Preferred contact',
        type: 'string',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Register customer assets (IMEI / serial)',
      'Open a repair job, add parts + labor, then collect payment',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.repair,
  },
  pharmacy: {
    id: 'pharmacy',
    label: 'Pharmacy / medical retail',
    description: 'Retail with batch and expiry capabilities',
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
        key: 'rxRequired',
        label: 'Rx required',
        type: 'boolean',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Enable batch and expiry on tracked medicines',
      'Use stock alerts for near-expiry items',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.pharmacy,
  },
  furniture: {
    id: 'furniture',
    label: 'Furniture / large goods',
    description: 'Catalog + advance / balance payments',
    defaultCommerceModes: ['sale'],
    billing: {
      style: 'counter',
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
      'inventory',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'item',
        key: 'dimensions',
        label: 'Dimensions',
        type: 'string',
        required: false,
      },
      {
        entity: 'order',
        key: 'deliveryNote',
        label: 'Delivery note',
        type: 'text',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Take advance at booking and collect balance on delivery',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.furniture,
  },
  coaching: {
    id: 'coaching',
    label: 'Coaching / training center',
    description: 'Courses, batches, and fee plans via subscription/service',
    defaultCommerceModes: ['subscription', 'service'],
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
      'memberships',
      'appointments',
      'reports',
      'settings',
    ],
    metaFields: [],
    gettingStartedHints: [
      'Sell course fees as subscription or service items',
      'Track students as customers with enrollment notes',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.coaching,
  },
  spa: {
    id: 'spa',
    label: 'Spa / wellness',
    description: 'Rooms + therapists + packages (service mode)',
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
      'resources',
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
    ],
    gettingStartedHints: [
      'Create treatment rooms as Resources',
      'Book services against staff and rooms',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.spa,
  },
  event: {
    id: 'event',
    label: 'Event / venue',
    description: 'Bookable halls and packages with deposits',
    defaultCommerceModes: ['service', 'rental'],
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
      'resources',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'order',
        key: 'guestCount',
        label: 'Guest count',
        type: 'number',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Define venues as Resources with capacity',
      'Collect booking deposit then final balance',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.event,
  },
  laundry: {
    id: 'laundry',
    label: 'Laundry / dry clean',
    description: 'Intake tickets as jobs + service pricing',
    defaultCommerceModes: ['service', 'sale'],
    billing: {
      style: 'counter',
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
      'jobs',
      'reports',
      'settings',
    ],
    metaFields: [],
    gettingStartedHints: [
      'Open a job per bag/ticket, add services, collect on pickup',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.laundry,
  },
  pet_grooming: {
    id: 'pet_grooming',
    label: 'Pet grooming',
    description: 'Appointments + optional retail products',
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
      'resources',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'customer',
        key: 'petName',
        label: 'Pet name',
        type: 'string',
        required: false,
      },
      {
        entity: 'customer',
        key: 'petBreed',
        label: 'Breed',
        type: 'string',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Book grooming slots and sell pet products from the same catalog',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.pet_grooming,
  },
  photography: {
    id: 'photography',
    label: 'Photography studio',
    description: 'Sessions + optional gear rental',
    defaultCommerceModes: ['service', 'rental'],
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
      'resources',
      'inventory',
      'reports',
      'settings',
    ],
    metaFields: [],
    gettingStartedHints: [
      'Sell session packages as services; rent gear via rental mode',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.photography,
  },
  car_wash: {
    id: 'car_wash',
    label: 'Car wash / detailing',
    description: 'Vehicle services with optional packages',
    defaultCommerceModes: ['service', 'sale'],
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
      'jobs',
      'reports',
      'settings',
    ],
    metaFields: [
      {
        entity: 'customer',
        key: 'vehiclePlate',
        label: 'Vehicle plate',
        type: 'string',
        required: false,
      },
    ],
    gettingStartedHints: [
      'Register vehicles as customer assets when needed; book wash slots',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.car_wash,
  },
  coworking: {
    id: 'coworking',
    label: 'Coworking space',
    description: 'Desk/room memberships and resource bookings',
    defaultCommerceModes: ['subscription', 'service'],
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
      'memberships',
      'resources',
      'check_in',
      'appointments',
      'reports',
      'settings',
    ],
    metaFields: [],
    gettingStartedHints: [
      'Sell desk memberships; book meeting rooms as resources',
    ],
    defaultCapabilities: BUSINESS_TYPE_CAPABILITY_DEFAULTS.coworking,
  },
};

const FOOD_SETUP_ALIASES: Record<string, string> = {
  cafe: 'restaurant',
  bakery: 'restaurant',
  qsr: 'restaurant',
  cloud_kitchen: 'restaurant',
  food_truck: 'restaurant',
};

export function listBusinessConfigs(): BusinessConfig[] {
  return Object.values(BUSINESS_CONFIG_REGISTRY);
}

export function getBusinessConfig(id: string | null | undefined): BusinessConfig {
  const raw = id?.trim().toLowerCase() ?? '';
  const mapped = FOOD_SETUP_ALIASES[raw] ?? raw;
  if (mapped && BUSINESS_CONFIG_REGISTRY[mapped]) {
    const base = BUSINESS_CONFIG_REGISTRY[mapped];
    if (mapped !== raw && raw) {
      return { ...base, id: raw, label: raw.replaceAll('_', ' ') };
    }
    return base;
  }
  return BUSINESS_CONFIG_REGISTRY.general;
}

export function isBusinessTypeId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const key = value.trim().toLowerCase();
  return key in BUSINESS_CONFIG_REGISTRY || key in FOOD_SETUP_ALIASES;
}

/**
 * Org setup: listed ids are templates. Unknown / blank → Other (universal core).
 * Never reject a shop because swimming / bakery / coaching isn’t in the picker.
 */
export function resolveSetupBusinessProfile(raw: string | null | undefined): {
  profile: BusinessConfig;
  unknown: boolean;
  requested: string;
} {
  const requested = (raw ?? '').trim();
  const key = requested.toLowerCase().replace(/[\s-]+/g, '_');
  if (isBusinessTypeId(key)) {
    return { profile: getBusinessConfig(key), unknown: false, requested };
  }
  return {
    profile: getBusinessConfig('other'),
    unknown: requested.length > 0 && requested.toLowerCase() !== 'other',
    requested,
  };
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
    defaultCapabilities: c.defaultCapabilities ?? [],
    billingStyle: c.billing.style,
    screens: c.screens,
  }));
}
