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
  { code: 'reports.sales.read', moduleCode: 'reports', description: 'View sales reports' },
  { code: 'reports.profit.read', moduleCode: 'reports', description: 'View profit / P&L' },
  { code: 'reports.finance.read', moduleCode: 'reports', description: 'View finance, AP/AR, cash' },
  { code: 'catalog.cost.read', moduleCode: 'catalog', description: 'View product cost' },
  { code: 'refund.create', moduleCode: 'payments', description: 'Request a refund' },
  { code: 'refund.approve', moduleCode: 'payments', description: 'Approve a refund' },
  { code: 'discount.create', moduleCode: 'pos', description: 'Apply discount within cap' },
  { code: 'discount.approve', moduleCode: 'pos', description: 'Approve over-limit discount' },
  { code: 'inventory.adjust', moduleCode: 'inventory', description: 'Adjust stock qty' },
  { code: 'inventory.transfer', moduleCode: 'inventory', description: 'Transfer stock (same tenant)' },
  { code: 'inventory.transfer.approve', moduleCode: 'inventory', description: 'Approve stock transfer' },
  { code: 'purchase.create', moduleCode: 'purchases', description: 'Create purchase orders' },
  { code: 'purchase.approve', moduleCode: 'purchases', description: 'Approve purchase orders' },
  { code: 'price.change', moduleCode: 'pos', description: 'Change sell price at counter' },
  { code: 'price.change.approve', moduleCode: 'pos', description: 'Approve price change' },
  { code: 'cash.adjust', moduleCode: 'pos', description: 'Adjust register cash' },
  { code: 'cash.approve', moduleCode: 'pos', description: 'Approve cash adjustment' },
  { code: 'expenses.manage', moduleCode: 'expenses', description: 'Record expenses' },
  { code: 'suppliers.manage', moduleCode: 'purchases', description: 'Suppliers & POs' },
  { code: 'settings.manage', moduleCode: 'core', description: 'Shop settings' },
  { code: 'plan.manage', moduleCode: 'core', description: 'Subscription plan' },
  { code: 'accounting.view', moduleCode: 'accounting', description: 'View ledger, reports, and journals' },
  { code: 'accounting.create', moduleCode: 'accounting', description: 'Create draft journals and accounts' },
  { code: 'accounting.edit', moduleCode: 'accounting', description: 'Edit accounts, mappings, and drafts' },
  { code: 'accounting.post', moduleCode: 'accounting', description: 'Post draft journal entries' },
  { code: 'accounting.reverse', moduleCode: 'accounting', description: 'Reverse posted journals' },
  { code: 'accounting.close_period', moduleCode: 'accounting', description: 'Close or reopen accounting periods' },
  { code: 'accounting.export', moduleCode: 'accounting', description: 'Export accounting data' },
  { code: 'accounting.integrations.manage', moduleCode: 'accounting', description: 'Connect external accounting systems' },
  { code: 'accounting.sync', moduleCode: 'accounting', description: 'Trigger external accounting sync' },
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
    'reports.sales.read',
    'refund.create',
    'refund.approve',
    'discount.create',
    'discount.approve',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.transfer.approve',
    'purchase.create',
    'purchase.approve',
    'price.change',
    'cash.adjust',
    'expenses.manage',
    'suppliers.manage',
    'settings.manage',
    'accounting.view',
    'accounting.create',
    'accounting.edit',
    'accounting.post',
    'accounting.reverse',
    'accounting.close_period',
    'accounting.export',
    'accounting.integrations.manage',
    'accounting.sync',
  ],
  cashier: [
    'attendance.self',
    'catalog.read',
    'orders.read',
    'orders.write',
    'pos.checkout',
    'payments.take',
    'discount.create',
    'refund.create',
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
    'catalog.cost.read',
    'inventory.read',
    'inventory.write',
    'inventory.adjust',
    'inventory.transfer',
    'orders.read',
    'purchase.create',
    'suppliers.manage',
  ],
  accountant: [
    'attendance.self',
    'orders.read',
    'reports.read',
    'reports.sales.read',
    'reports.profit.read',
    'reports.finance.read',
    'catalog.cost.read',
    'refund.approve',
    'expenses.manage',
    'payments.take',
    'accounting.view',
    'accounting.create',
    'accounting.edit',
    'accounting.post',
    'accounting.reverse',
    'accounting.close_period',
    'accounting.export',
    'accounting.integrations.manage',
    'accounting.sync',
  ],
  staff: ['attendance.self', 'catalog.read', 'orders.read'],
};

/**
 * If user lacks a required *role code*, still allow when they hold any of these permissions
 * (supports custom roles built from permission matrix).
 */
export const ROLE_PERMISSION_FALLBACK: Record<string, string[]> = {
  admin: ['plan.manage'],
  manager: [
    'users.manage',
    'roles.manage',
    'settings.manage',
    'attendance.manage',
    'shifts.manage',
  ],
  cashier: ['pos.checkout'],
  fitter: ['appointments.manage', 'rental.manage'],
  inventory: ['inventory.write', 'catalog.write'],
  accountant: ['reports.read', 'expenses.manage', 'accounting.view'],
  staff: ['attendance.self', 'attendance.manage'],
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
