/**
 * Universal POS RBAC — system roles, permission catalog, role→permission defaults.
 * Custom tenant roles store permissions via role_permissions; JWT guard resolves both.
 */

export const SYSTEM_ROLE_CODES = [
  'admin',
  'manager',
  'cashier',
  'fitter',
  'inventory',
  'accountant',
  'staff',
] as const;

export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

/** Stable permission codes (seeded into `permissions` table). */
export const PERMISSION_CATALOG: Array<{
  code: string;
  moduleCode: string;
  description: string;
}> = [
  { code: 'users.manage', moduleCode: 'iam', description: 'Invite and manage staff' },
  { code: 'roles.manage', moduleCode: 'iam', description: 'Create/edit roles & permissions' },
  { code: 'attendance.manage', moduleCode: 'iam', description: 'View/manage all attendance' },
  { code: 'attendance.self', moduleCode: 'iam', description: 'Clock in/out self' },
  { code: 'shifts.manage', moduleCode: 'iam', description: 'Define and assign shifts' },
  { code: 'catalog.read', moduleCode: 'catalog', description: 'View items' },
  { code: 'catalog.write', moduleCode: 'catalog', description: 'Create/edit items' },
  { code: 'inventory.read', moduleCode: 'inventory', description: 'View stock' },
  { code: 'inventory.write', moduleCode: 'inventory', description: 'Adjust stock' },
  { code: 'orders.read', moduleCode: 'orders', description: 'View orders' },
  { code: 'orders.write', moduleCode: 'orders', description: 'Change orders' },
  { code: 'pos.checkout', moduleCode: 'pos', description: 'Counter sell' },
  { code: 'payments.take', moduleCode: 'payments', description: 'Take payment' },
  { code: 'refund', moduleCode: 'payments', description: 'Issue refunds' },
  { code: 'discount_override', moduleCode: 'pos', description: 'Override discount caps' },
  { code: 'price_change', moduleCode: 'pos', description: 'Change sell price at counter' },
  { code: 'rental.manage', moduleCode: 'rental', description: 'Rental ops' },
  { code: 'appointments.manage', moduleCode: 'appointments', description: 'Bookings' },
  { code: 'notify.send', moduleCode: 'notify', description: 'Send notifications' },
  { code: 'reports.read', moduleCode: 'reports', description: 'View reports & CSV' },
  { code: 'expenses.manage', moduleCode: 'expenses', description: 'Record expenses' },
  { code: 'suppliers.manage', moduleCode: 'purchases', description: 'Suppliers & POs' },
  { code: 'settings.manage', moduleCode: 'core', description: 'Shop settings' },
  { code: 'plan.manage', moduleCode: 'core', description: 'Subscription plan' },
];

export const DEFAULT_PERMISSION_CODES = PERMISSION_CATALOG.map((p) => p.code);

/** Default permission set for each system role (* = all). */
export const SYSTEM_ROLE_PERMISSIONS: Record<string, string[] | ['*']> = {
  admin: ['*'],
  manager: [
    'users.manage',
    'roles.manage',
    'attendance.manage',
    'attendance.self',
    'shifts.manage',
    'catalog.read',
    'catalog.write',
    'inventory.read',
    'inventory.write',
    'orders.read',
    'orders.write',
    'pos.checkout',
    'payments.take',
    'refund',
    'discount_override',
    'price_change',
    'rental.manage',
    'appointments.manage',
    'notify.send',
    'reports.read',
    'expenses.manage',
    'suppliers.manage',
    'settings.manage',
  ],
  cashier: [
    'attendance.self',
    'catalog.read',
    'orders.read',
    'orders.write',
    'pos.checkout',
    'payments.take',
    'appointments.manage',
    'notify.send',
  ],
  fitter: [
    'attendance.self',
    'catalog.read',
    'orders.read',
    'appointments.manage',
    'rental.manage',
    'notify.send',
  ],
  inventory: [
    'attendance.self',
    'catalog.read',
    'catalog.write',
    'inventory.read',
    'inventory.write',
    'orders.read',
    'suppliers.manage',
  ],
  accountant: [
    'attendance.self',
    'orders.read',
    'reports.read',
    'expenses.manage',
    'payments.take',
  ],
  staff: ['attendance.self', 'catalog.read', 'orders.read'],
};

/**
 * If user lacks a required *role code*, still allow when they hold any of these permissions
 * (supports custom roles built from permission matrix).
 */
export const ROLE_PERMISSION_FALLBACK: Record<string, string[]> = {
  admin: ['plan.manage'],
  manager: ['users.manage', 'roles.manage', 'settings.manage'],
  cashier: ['pos.checkout'],
  fitter: ['appointments.manage', 'rental.manage'],
  inventory: ['inventory.write', 'catalog.write'],
  accountant: ['reports.read', 'expenses.manage'],
  staff: ['users.manage'],
};

export function expandPermissions(roleCodes: string[], fromDb: string[]): string[] {
  const set = new Set<string>(fromDb);
  for (const code of roleCodes) {
    const def = SYSTEM_ROLE_PERMISSIONS[code];
    if (!def) continue;
    if (def[0] === '*') {
      for (const p of DEFAULT_PERMISSION_CODES) set.add(p);
      set.add('*');
    } else {
      for (const p of def) set.add(p);
    }
  }
  return [...set];
}

export function hasPermission(
  permissions: string[] | undefined,
  code: string,
): boolean {
  if (!permissions?.length) return false;
  if (permissions.includes('*')) return true;
  return permissions.includes(code);
}
