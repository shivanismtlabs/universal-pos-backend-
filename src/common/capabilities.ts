/**
 * Tenant capability registry — Zoho-style Universal POS.
 *
 * Rules:
 * - businessType is a setup template only (defaults + copy).
 * - Runtime gates use hasCapability(code), never if (businessType === 'restaurant').
 * - Commerce modes and optional modules may imply capabilities; tenants can override.
 */

export const CAPABILITY_CODES = [
  'INVENTORY',
  'BARCODE',
  'VARIANTS',
  'BATCH',
  'EXPIRY',
  'SERIAL',
  'BOOKING',
  'RESOURCE',
  'STAFF_ASSIGNMENT',
  'MEMBERSHIP',
  'ATTENDANCE',
  'SUBSCRIPTION',
  'DEPOSIT',
  'PARTIAL_PAYMENT',
  'CUSTOM_FIELDS',
  'KITCHEN',
  'KOT',
  'KDS',
  'TABLE',
  'DELIVERY',
  'RECIPE',
  'QR_ORDER',
  'TOKEN',
  'DINING_RESERVATION',
  'CAPTAIN',
  'WASTAGE',
  'REPAIR_JOB',
  'ASSET',
  'PACKAGE',
  'LOYALTY',
  'STORE_CREDIT',
  'MULTI_LOCATION',
  'WAREHOUSE',
  'PURCHASE',
  'EXPENSE',
  'ADVANCED_REPORTING',
  'MODIFIERS',
  'AVAILABILITY',
  'DAMAGE',
  'CHECK_IN',
] as const;

export type CapabilityCode = (typeof CAPABILITY_CODES)[number];

export type CapabilityDef = {
  code: CapabilityCode;
  label: string;
  description: string;
  /** Optional platform module that usually backs this capability */
  moduleHint?: string;
  /** Commerce modes that typically imply this capability */
  modeHints?: Array<'sale' | 'rental' | 'service' | 'subscription'>;
};

export const CAPABILITY_REGISTRY: Record<CapabilityCode, CapabilityDef> = {
  INVENTORY: {
    code: 'INVENTORY',
    label: 'Inventory',
    description: 'Stock on hand, adjustments, transfers',
    moduleHint: 'inventory',
    modeHints: ['sale', 'rental'],
  },
  BARCODE: {
    code: 'BARCODE',
    label: 'Barcode / SKU scan',
    description: 'Scan and lookup by barcode at counter',
    modeHints: ['sale'],
  },
  VARIANTS: {
    code: 'VARIANTS',
    label: 'Product variants',
    description: 'Size, colour, and other variant axes',
    modeHints: ['sale'],
  },
  BATCH: {
    code: 'BATCH',
    label: 'Batch / lot tracking',
    description: 'Track inventory by batch or lot',
    moduleHint: 'inventory',
  },
  EXPIRY: {
    code: 'EXPIRY',
    label: 'Expiry tracking',
    description: 'Expiry dates on batches / items',
    moduleHint: 'inventory',
  },
  SERIAL: {
    code: 'SERIAL',
    label: 'Serial numbers',
    description: 'Serialized unit tracking',
    moduleHint: 'inventory',
  },
  BOOKING: {
    code: 'BOOKING',
    label: 'Bookings / appointments',
    description: 'Time-based bookings for services and resources',
    moduleHint: 'appointments',
    modeHints: ['service'],
  },
  RESOURCE: {
    code: 'RESOURCE',
    label: 'Resources',
    description: 'Tables, rooms, vehicles, equipment, halls',
    moduleHint: 'resources',
  },
  STAFF_ASSIGNMENT: {
    code: 'STAFF_ASSIGNMENT',
    label: 'Staff assignment',
    description: 'Assign stylists, technicians, trainers to work',
  },
  MEMBERSHIP: {
    code: 'MEMBERSHIP',
    label: 'Memberships',
    description: 'Customer membership plans (not SaaS billing)',
    modeHints: ['subscription'],
  },
  ATTENDANCE: {
    code: 'ATTENDANCE',
    label: 'Staff attendance',
    description: 'Employee attendance and shifts',
  },
  SUBSCRIPTION: {
    code: 'SUBSCRIPTION',
    label: 'Subscriptions',
    description: 'Recurring customer plans',
    modeHints: ['subscription'],
  },
  DEPOSIT: {
    code: 'DEPOSIT',
    label: 'Deposits',
    description: 'Collect and refund deposits',
    modeHints: ['rental'],
  },
  PARTIAL_PAYMENT: {
    code: 'PARTIAL_PAYMENT',
    label: 'Partial / advance payment',
    description: 'Advance, balance due, multi-tender',
  },
  CUSTOM_FIELDS: {
    code: 'CUSTOM_FIELDS',
    label: 'Custom fields',
    description: 'Tenant-defined metadata on entities',
  },
  KITCHEN: {
    code: 'KITCHEN',
    label: 'Kitchen',
    description: 'Kitchen / prep station workflow',
  },
  KOT: {
    code: 'KOT',
    label: 'KOT',
    description: 'Kitchen order tickets',
  },
  KDS: {
    code: 'KDS',
    label: 'Kitchen display',
    description: 'Live kitchen display for ticket status',
  },
  TABLE: {
    code: 'TABLE',
    label: 'Tables',
    description: 'Dine-in table / seat resources',
  },
  DELIVERY: {
    code: 'DELIVERY',
    label: 'Delivery',
    description: 'Delivery order type and tracking',
  },
  RECIPE: {
    code: 'RECIPE',
    label: 'Recipes / BOM',
    description: 'Ingredient recipes for menu items (Phase 2)',
  },
  QR_ORDER: {
    code: 'QR_ORDER',
    label: 'QR ordering',
    description: 'Guest QR menu ordering (Phase 3)',
  },
  TOKEN: {
    code: 'TOKEN',
    label: 'Token / QSR',
    description: 'Token numbers for counter / QSR queues (Phase 3)',
  },
  DINING_RESERVATION: {
    code: 'DINING_RESERVATION',
    label: 'Dining reservations',
    description: 'Table reservations for dine-in (Phase 3)',
  },
  CAPTAIN: {
    code: 'CAPTAIN',
    label: 'Captain ordering',
    description: 'Waiter/captain floor ordering without finance access',
  },
  WASTAGE: {
    code: 'WASTAGE',
    label: 'Wastage',
    description: 'Spoilage / complimentary / staff meal write-offs (Phase 2)',
  },
  REPAIR_JOB: {
    code: 'REPAIR_JOB',
    label: 'Repair / service jobs',
    description: 'Work orders against customer assets',
    moduleHint: 'jobs',
  },
  ASSET: {
    code: 'ASSET',
    label: 'Customer assets',
    description: 'Devices, vehicles, equipment owned by customers',
    moduleHint: 'jobs',
  },
  PACKAGE: {
    code: 'PACKAGE',
    label: 'Packages',
    description: 'Bundled services or product packages',
  },
  LOYALTY: {
    code: 'LOYALTY',
    label: 'Loyalty',
    description: 'Points and loyalty ledger',
  },
  STORE_CREDIT: {
    code: 'STORE_CREDIT',
    label: 'Store credit',
    description: 'Customer store credit balances',
  },
  MULTI_LOCATION: {
    code: 'MULTI_LOCATION',
    label: 'Multi-location',
    description: 'Multiple branches / warehouses',
  },
  WAREHOUSE: {
    code: 'WAREHOUSE',
    label: 'Warehouse',
    description: 'Warehouse location type and transfers',
    moduleHint: 'inventory',
  },
  PURCHASE: {
    code: 'PURCHASE',
    label: 'Purchases',
    description: 'Purchase orders and receiving',
  },
  EXPENSE: {
    code: 'EXPENSE',
    label: 'Expenses',
    description: 'Business expense tracking',
  },
  ADVANCED_REPORTING: {
    code: 'ADVANCED_REPORTING',
    label: 'Advanced reporting',
    description: 'Extra report packs by enabled capabilities',
  },
  MODIFIERS: {
    code: 'MODIFIERS',
    label: 'Modifiers / add-ons',
    description: 'Item modifiers at order time',
  },
  AVAILABILITY: {
    code: 'AVAILABILITY',
    label: 'Availability calendar',
    description: 'Resource / unit availability windows',
    modeHints: ['rental', 'service'],
  },
  DAMAGE: {
    code: 'DAMAGE',
    label: 'Damage tracking',
    description: 'Damage and maintenance states',
    modeHints: ['rental'],
  },
  CHECK_IN: {
    code: 'CHECK_IN',
    label: 'Member check-in',
    description: 'Customer / member attendance gate',
    modeHints: ['subscription'],
  },
};

/** Always-on platform capabilities for any shop */
export const CORE_CAPABILITIES: CapabilityCode[] = [
  'PARTIAL_PAYMENT',
  'STORE_CREDIT',
  'CUSTOM_FIELDS',
];

/** Capabilities recommended by commerce mode */
export const MODE_CAPABILITY_DEFAULTS: Record<string, CapabilityCode[]> = {
  sale: ['INVENTORY', 'BARCODE', 'PURCHASE'],
  rental: [
    'INVENTORY',
    'SERIAL',
    'DEPOSIT',
    'AVAILABILITY',
    'DAMAGE',
    'RESOURCE',
  ],
  service: ['BOOKING', 'STAFF_ASSIGNMENT'],
  subscription: ['SUBSCRIPTION', 'MEMBERSHIP', 'CHECK_IN'],
};

/**
 * Setup templates only — never used as runtime if (businessType) in core engines.
 * Owner can toggle any capability after setup.
 */
export const BUSINESS_TYPE_CAPABILITY_DEFAULTS: Record<
  string,
  CapabilityCode[]
> = {
  general: ['INVENTORY', 'BARCODE'],
  other: ['CUSTOM_FIELDS'],
  retail: ['INVENTORY', 'BARCODE', 'VARIANTS', 'PURCHASE'],
  grocery: ['INVENTORY', 'BARCODE', 'BATCH', 'EXPIRY', 'PURCHASE'],
  restaurant: [
    'INVENTORY',
    'TABLE',
    'KITCHEN',
    'KOT',
    'KDS',
    'MODIFIERS',
    'RECIPE',
    'WASTAGE',
    'STAFF_ASSIGNMENT',
    'DELIVERY',
    'CAPTAIN',
    'QR_ORDER',
    'TOKEN',
    'DINING_RESERVATION',
  ],
  cafe: [
    'INVENTORY',
    'TABLE',
    'KITCHEN',
    'KOT',
    'MODIFIERS',
    'RECIPE',
    'WASTAGE',
    'DELIVERY',
  ],
  bakery: [
    'INVENTORY',
    'BARCODE',
    'BATCH',
    'KITCHEN',
    'KOT',
    'MODIFIERS',
    'RECIPE',
    'WASTAGE',
  ],
  qsr: [
    'INVENTORY',
    'KITCHEN',
    'KOT',
    'KDS',
    'TOKEN',
    'MODIFIERS',
    'RECIPE',
    'WASTAGE',
  ],
  cloud_kitchen: [
    'INVENTORY',
    'KITCHEN',
    'KOT',
    'KDS',
    'DELIVERY',
    'MODIFIERS',
    'RECIPE',
    'WASTAGE',
  ],
  food_truck: [
    'INVENTORY',
    'KITCHEN',
    'KOT',
    'TOKEN',
    'MODIFIERS',
    'RECIPE',
    'WASTAGE',
  ],
  salon: [
    'BOOKING',
    'STAFF_ASSIGNMENT',
    'RESOURCE',
    'PACKAGE',
    'MEMBERSHIP',
    'INVENTORY',
  ],
  service: ['BOOKING', 'STAFF_ASSIGNMENT'],
  gym: [
    'SUBSCRIPTION',
    'MEMBERSHIP',
    'CHECK_IN',
    'ATTENDANCE',
    'STAFF_ASSIGNMENT',
    'BOOKING',
    'INVENTORY',
  ],
  rental: [
    'INVENTORY',
    'SERIAL',
    'DEPOSIT',
    'AVAILABILITY',
    'DAMAGE',
    'RESOURCE',
  ],
  repair: [
    'REPAIR_JOB',
    'ASSET',
    'STAFF_ASSIGNMENT',
    'INVENTORY',
    'BOOKING',
  ],
  pharmacy: ['INVENTORY', 'BARCODE', 'BATCH', 'EXPIRY', 'PURCHASE', 'SERIAL'],
  furniture: ['INVENTORY', 'VARIANTS', 'PARTIAL_PAYMENT', 'DEPOSIT', 'PURCHASE'],
  coaching: [
    'SUBSCRIPTION',
    'MEMBERSHIP',
    'BOOKING',
    'STAFF_ASSIGNMENT',
    'CHECK_IN',
  ],
  spa: [
    'BOOKING',
    'RESOURCE',
    'STAFF_ASSIGNMENT',
    'PACKAGE',
    'MEMBERSHIP',
    'INVENTORY',
  ],
  event: ['BOOKING', 'RESOURCE', 'DEPOSIT', 'PARTIAL_PAYMENT', 'STAFF_ASSIGNMENT'],
  laundry: ['BOOKING', 'ASSET', 'REPAIR_JOB', 'STAFF_ASSIGNMENT'],
  pet_grooming: ['BOOKING', 'STAFF_ASSIGNMENT', 'RESOURCE', 'PACKAGE'],
  photography: ['BOOKING', 'RESOURCE', 'DEPOSIT', 'PACKAGE'],
  car_wash: ['BOOKING', 'STAFF_ASSIGNMENT', 'PACKAGE', 'ASSET'],
  coworking: ['MEMBERSHIP', 'SUBSCRIPTION', 'RESOURCE', 'CHECK_IN', 'DEPOSIT'],
};

export type OnboardingNeed =
  | 'inventory'
  | 'appointments'
  | 'bookings'
  | 'tables'
  | 'kitchen'
  | 'staff_assignment'
  | 'memberships'
  | 'attendance'
  | 'resources'
  | 'deposits'
  | 'serial'
  | 'batch_expiry'
  | 'repair_jobs'
  | 'delivery'
  | 'loyalty'
  | 'check_in';

export const NEED_TO_CAPABILITIES: Record<OnboardingNeed, CapabilityCode[]> = {
  inventory: ['INVENTORY'],
  appointments: ['BOOKING'],
  bookings: ['BOOKING', 'RESOURCE'],
  tables: ['TABLE', 'RESOURCE'],
  kitchen: ['KITCHEN', 'KOT'],
  staff_assignment: ['STAFF_ASSIGNMENT'],
  memberships: ['MEMBERSHIP', 'SUBSCRIPTION'],
  attendance: ['ATTENDANCE'],
  resources: ['RESOURCE'],
  deposits: ['DEPOSIT'],
  serial: ['SERIAL'],
  batch_expiry: ['BATCH', 'EXPIRY'],
  repair_jobs: ['REPAIR_JOB', 'ASSET'],
  delivery: ['DELIVERY'],
  loyalty: ['LOYALTY'],
  check_in: ['CHECK_IN'],
};

export type SellKind =
  | 'products'
  | 'services'
  | 'rentals'
  | 'subscriptions'
  | 'memberships'
  | 'packages';

export const SELL_TO_MODES: Record<SellKind, string[]> = {
  products: ['sale'],
  services: ['service'],
  rentals: ['rental'],
  subscriptions: ['subscription'],
  memberships: ['subscription'],
  packages: ['sale', 'service'],
};

export const SELL_TO_CAPABILITIES: Record<SellKind, CapabilityCode[]> = {
  products: ['INVENTORY', 'BARCODE'],
  services: ['BOOKING', 'STAFF_ASSIGNMENT'],
  rentals: ['INVENTORY', 'DEPOSIT', 'AVAILABILITY', 'DAMAGE'],
  subscriptions: ['SUBSCRIPTION', 'MEMBERSHIP'],
  memberships: ['MEMBERSHIP', 'SUBSCRIPTION', 'CHECK_IN'],
  packages: ['PACKAGE'],
};

export function isCapabilityCode(value: unknown): value is CapabilityCode {
  return (
    typeof value === 'string' &&
    (CAPABILITY_CODES as readonly string[]).includes(value)
  );
}

export function capabilityCatalog() {
  return CAPABILITY_CODES.map((code) => CAPABILITY_REGISTRY[code]);
}

function uniqCaps(list: CapabilityCode[]): CapabilityCode[] {
  return [...new Set(list)];
}

/** Merge template + modes + explicit needs into recommended set */
export function recommendCapabilities(input: {
  businessType?: string | null;
  commerceModes?: string[];
  sells?: SellKind[];
  needs?: OnboardingNeed[];
  extras?: CapabilityCode[];
}): CapabilityCode[] {
  const out: CapabilityCode[] = [...CORE_CAPABILITIES];
  const type = input.businessType?.trim().toLowerCase() || '';
  if (type && BUSINESS_TYPE_CAPABILITY_DEFAULTS[type]) {
    out.push(...BUSINESS_TYPE_CAPABILITY_DEFAULTS[type]);
  }
  for (const mode of input.commerceModes ?? []) {
    out.push(...(MODE_CAPABILITY_DEFAULTS[mode] ?? []));
  }
  for (const sell of input.sells ?? []) {
    out.push(...(SELL_TO_CAPABILITIES[sell] ?? []));
  }
  for (const need of input.needs ?? []) {
    out.push(...(NEED_TO_CAPABILITIES[need] ?? []));
  }
  if (input.extras?.length) out.push(...input.extras);
  return uniqCaps(out);
}

export function recommendCommerceModes(input: {
  businessType?: string | null;
  sells?: SellKind[];
  fallback?: string[];
}): string[] {
  const modes = new Set<string>();
  for (const sell of input.sells ?? []) {
    for (const m of SELL_TO_MODES[sell] ?? []) modes.add(m);
  }
  if (!modes.size && input.fallback?.length) {
    input.fallback.forEach((m) => modes.add(m));
  }
  if (!modes.size) modes.add('sale');
  return [...modes];
}

/**
 * Resolve effective capabilities for a tenant.
 * Explicit settings.capabilities wins when present (even empty after setup).
 * Otherwise derive from businessType + commerceModes.
 */
export function resolveTenantCapabilities(settings: unknown): CapabilityCode[] {
  const s = (settings ?? {}) as Record<string, unknown>;
  if (Array.isArray(s.capabilities)) {
    return uniqCaps(
      s.capabilities.filter(isCapabilityCode) as CapabilityCode[],
    );
  }
  const businessType =
    typeof s.businessType === 'string'
      ? s.businessType
      : typeof s.businessConfigId === 'string'
        ? s.businessConfigId
        : 'general';
  const modes = Array.isArray(s.commerceModes)
    ? (s.commerceModes as string[])
    : [];
  return recommendCapabilities({ businessType, commerceModes: modes });
}

export function hasCapability(
  settingsOrList: unknown,
  code: CapabilityCode | string,
): boolean {
  const list = Array.isArray(settingsOrList)
    ? (settingsOrList as string[])
    : resolveTenantCapabilities(settingsOrList);
  return list.includes(code);
}

/** Map capabilities → screens the shell should prefer */
export function screensForCapabilities(
  caps: CapabilityCode[],
): string[] {
  const screens = new Set<string>([
    'home',
    'items',
    'counter',
    'orders',
    'customers',
    'reports',
    'settings',
  ]);
  if (caps.includes('INVENTORY') || caps.includes('WAREHOUSE')) {
    screens.add('inventory');
  }
  if (caps.includes('BOOKING')) screens.add('appointments');
  if (caps.includes('RESOURCE') || caps.includes('TABLE')) {
    screens.add('resources');
  }
  if (caps.includes('MEMBERSHIP') || caps.includes('SUBSCRIPTION')) {
    screens.add('memberships');
  }
  if (caps.includes('REPAIR_JOB') || caps.includes('ASSET')) {
    screens.add('jobs');
  }
  if (caps.includes('KITCHEN') || caps.includes('KOT') || caps.includes('KDS')) {
    screens.add('kitchen');
  }
  if (caps.includes('TABLE') || caps.includes('KOT') || caps.includes('CAPTAIN') || caps.includes('RECIPE') || caps.includes('WASTAGE') || caps.includes('QR_ORDER') || caps.includes('TOKEN') || caps.includes('DINING_RESERVATION') || caps.includes('KDS')) {
    screens.add('restaurant');
  }
  if (caps.includes('CHECK_IN')) screens.add('check_in');
  return [...screens];
}
