import { Prisma } from '@prisma/client';

/** Platform module catalog — Phase 2 seed / register */
export const PLATFORM_MODULES: Array<{
  code: string;
  name: string;
  description: string;
  dependsOn: string[];
  permissions: string[];
  isCore: boolean;
  navSchema: Prisma.InputJsonValue;
}> = [
  {
    code: 'core',
    name: 'Core',
    description: 'Platform foundation',
    dependsOn: [],
    permissions: [],
    isCore: true,
    navSchema: [],
  },
  {
    code: 'iam',
    name: 'Identity & Access',
    description: 'Users, roles, locations',
    dependsOn: ['core'],
    permissions: ['users.manage', 'roles.manage'],
    isCore: true,
    navSchema: [
      { label: 'Staff', path: '/staff', icon: 'users' },
    ],
  },
  {
    code: 'catalog',
    name: 'Catalog',
    description: 'Products and categories',
    dependsOn: ['core'],
    permissions: ['catalog.read', 'catalog.write'],
    isCore: false,
    navSchema: [
      { label: 'Catalog', path: '/inventory', icon: 'box' },
    ],
  },
  {
    code: 'inventory',
    name: 'Inventory',
    description: 'Stock levels and serial units',
    dependsOn: ['catalog'],
    permissions: ['inventory.read', 'inventory.write'],
    isCore: false,
    navSchema: [],
  },
  {
    code: 'orders',
    name: 'Orders',
    description: 'Generic orders',
    dependsOn: ['core'],
    permissions: ['orders.read', 'orders.write'],
    isCore: false,
    navSchema: [
      { label: 'Orders', path: '/orders', icon: 'list' },
    ],
  },
  {
    code: 'pos',
    name: 'POS',
    description: 'Point of sale checkout',
    dependsOn: ['orders', 'payments'],
    permissions: ['pos.checkout'],
    isCore: false,
    navSchema: [
      { label: 'POS', path: '/pos', icon: 'terminal' },
    ],
  },
  {
    code: 'payments',
    name: 'Payments',
    description: 'Payments and refunds',
    dependsOn: ['orders'],
    permissions: ['payments.take', 'refund'],
    isCore: false,
    navSchema: [],
  },
  {
    code: 'rental',
    name: 'Rental',
    description: 'Rental lifecycle extensions',
    dependsOn: ['catalog', 'inventory', 'orders', 'payments'],
    permissions: ['rental.manage'],
    isCore: false,
    navSchema: [
      { label: 'Fittings', path: '/appointments', icon: 'calendar' },
    ],
  },
  {
    code: 'appointments',
    name: 'Appointments',
    description: 'Generic booking',
    dependsOn: ['core'],
    permissions: ['appointments.manage'],
    isCore: false,
    navSchema: [],
  },
  {
    code: 'notify',
    name: 'Notifications',
    description: 'WhatsApp / SMS / email',
    dependsOn: ['core'],
    permissions: ['notify.send'],
    isCore: false,
    navSchema: [
      { label: 'WhatsApp', path: '/notify', icon: 'message' },
    ],
  },
  {
    code: 'reports',
    name: 'Reports',
    description: 'Analytics and reports',
    dependsOn: ['core'],
    permissions: ['reports.read'],
    isCore: false,
    navSchema: [
      { label: 'Reports', path: '/reports', icon: 'chart' },
    ],
  },
];

export const DEFAULT_ROLES = [
  'admin',
  'manager',
  'cashier',
  'fitter',
  'inventory',
  'staff',
] as const;

export const DEFAULT_PERMISSION_CODES = [
  'refund',
  'discount_override',
  'price_change',
  'users.manage',
  'roles.manage',
  'catalog.read',
  'catalog.write',
  'inventory.read',
  'inventory.write',
  'orders.read',
  'orders.write',
  'pos.checkout',
  'payments.take',
  'rental.manage',
  'appointments.manage',
  'notify.send',
  'reports.read',
] as const;

/** Modules enabled for a new tenant by default (IAM foundation). */
export const DEFAULT_TENANT_MODULE_CODES = [
  'core',
  'iam',
] as const;
