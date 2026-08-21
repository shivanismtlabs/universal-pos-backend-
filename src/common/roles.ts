/** Shared role codes for RBAC (FR-USR) */
export const Role = {
  admin: 'admin',
  manager: 'manager',
  cashier: 'cashier',
  fitter: 'fitter',
  inventory: 'inventory',
  accountant: 'accountant',
  captain: 'captain',
  kitchen: 'kitchen',
} as const;

export type RoleCode = (typeof Role)[keyof typeof Role];

/** Role groups used on controllers — keep in sync with frontend `lib/roles.ts` */
export const RoleGroup = {
  all: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
    Role.inventory,
    Role.accountant,
    Role.captain,
    Role.kitchen,
  ] as string[],

  lead: [Role.admin, Role.manager] as string[],

  pos: [Role.admin, Role.manager, Role.cashier, Role.captain] as string[],

  diningFloor: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.captain,
  ] as string[],

  kitchenOps: [
    Role.admin,
    Role.manager,
    Role.captain,
    Role.kitchen,
  ] as string[],

  returns: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.inventory,
  ] as string[],

  studio: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
  ] as string[],

  orders: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
    Role.inventory,
    Role.accountant,
    Role.captain,
    Role.kitchen,
  ] as string[],

  fittings: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
  ] as string[],

  catalogRead: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
    Role.inventory,
    Role.accountant,
    Role.captain,
    Role.kitchen,
  ] as string[],

  catalogWrite: [Role.admin, Role.manager, Role.inventory] as string[],

  finance: [Role.admin, Role.manager, Role.accountant] as string[],

  accounting: [Role.admin, Role.manager, Role.accountant] as string[],

  staff: [Role.admin, Role.manager] as string[],

  ownerOnly: [Role.admin] as string[],

  notify: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
    Role.captain,
  ] as string[],
} as const;
