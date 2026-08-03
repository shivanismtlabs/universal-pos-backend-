/** Shared role codes for RBAC (FR-USR) */
export const Role = {
  admin: 'admin',
  manager: 'manager',
  cashier: 'cashier',
  fitter: 'fitter',
  inventory: 'inventory',
} as const;

export type RoleCode = (typeof Role)[keyof typeof Role];

/** Role groups used on controllers — keep in sync with frontend `lib/roles.ts` */
export const RoleGroup = {
  /** Everything */
  all: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
    Role.inventory,
  ] as string[],

  /** Shop owner / manager */
  lead: [Role.admin, Role.manager] as string[],

  /** Counter: take money, bag, hand over */
  pos: [Role.admin, Role.manager, Role.cashier] as string[],

  /** Returns desk */
  returns: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.inventory,
  ] as string[],

  /** Customers, parties, fittings day-to-day (no stock-only staff) */
  studio: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
  ] as string[],

  /** Orders list/detail — counter + fitter + stock */
  orders: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
    Role.inventory,
  ] as string[],

  /** Appointments / fittings focus */
  fittings: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
  ] as string[],

  /** Read catalog (styles/units) for scanning / picking */
  catalogRead: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
    Role.inventory,
  ] as string[],

  /** Create/edit inventory, retail, suppliers */
  catalogWrite: [Role.admin, Role.manager, Role.inventory] as string[],

  /** Financial reports, invoices, fees, layaway, refunds */
  finance: [Role.admin, Role.manager] as string[],

  /** Staff invite / deactivate */
  staff: [Role.admin, Role.manager] as string[],

  /** SaaS plan / tenant settings */
  ownerOnly: [Role.admin] as string[],

  /** WhatsApp / notify */
  notify: [
    Role.admin,
    Role.manager,
    Role.cashier,
    Role.fitter,
  ] as string[],
} as const;
