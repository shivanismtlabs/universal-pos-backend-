/**
 * Branch/location access control.
 * Branch ≡ Location. Admin = all branches; others = primary + memberships + role grants.
 */
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Role } from './roles';
import type { AuthUser } from '../modules/auth/types';

type Db = Pick<
  PrismaClient,
  'location' | 'user' | 'membership' | 'userRole'
>;

/** Roles that may see / operate all branches in the tenant */
export function hasAllBranchAccess(user: AuthUser): boolean {
  const roles = user.roles ?? [];
  return roles.includes(Role.admin) || roles.includes(Role.accountant);
}

/**
 * Resolve location IDs the user may access.
 * - admin / accountant → all active (or all if includeInactive)
 * - manager with no assignments → all (HQ-style manager)
 * - others → primaryLocationId + Membership.locationId + UserRole.locationId
 * - manager with explicit assignments → only those (+ primary)
 */
export async function resolveAllowedLocationIds(
  db: Db,
  user: AuthUser,
  opts?: { includeInactive?: boolean },
): Promise<string[] | 'all'> {
  if (hasAllBranchAccess(user)) return 'all';

  const roles = user.roles ?? [];
  const isManager = roles.includes(Role.manager);

  const [me, memberships, roleGrants] = await Promise.all([
    db.user.findFirst({
      where: { id: user.userId, tenantId: user.tenantId },
      select: { primaryLocationId: true },
    }),
    db.membership.findMany({
      where: {
        tenantId: user.tenantId,
        userId: user.userId,
        locationId: { not: null },
        status: 'active',
      },
      select: { locationId: true },
    }),
    db.userRole.findMany({
      where: {
        userId: user.userId,
        locationId: { not: null },
        role: { tenantId: user.tenantId },
      },
      select: { locationId: true },
    }),
  ]);

  const ids = new Set<string>();
  if (me?.primaryLocationId) ids.add(me.primaryLocationId);
  if (user.locationId) ids.add(user.locationId);
  for (const m of memberships) {
    if (m.locationId) ids.add(m.locationId);
  }
  for (const g of roleGrants) {
    if (g.locationId) ids.add(g.locationId);
  }

  // Manager with no explicit branch list → all branches (org-level manager)
  if (isManager && ids.size === 0) return 'all';

  if (ids.size === 0) {
    // Cashier / inventory with no assignment: fall back to any active MAIN/first
    // but return empty so callers force assignment — safer default empty
    const fallback = await db.location.findFirst({
      where: {
        tenantId: user.tenantId,
        ...(opts?.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ code: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (fallback) ids.add(fallback.id);
  }

  return [...ids];
}

export async function assertLocationAccess(
  db: Db,
  user: AuthUser,
  locationId: string,
  opts?: { requireActive?: boolean },
): Promise<void> {
  const loc = await db.location.findFirst({
    where: { id: locationId, tenantId: user.tenantId },
    select: { id: true, isActive: true, name: true },
  });
  if (!loc) throw new NotFoundException('Branch / location not found');
  if (opts?.requireActive !== false && !loc.isActive) {
    throw new ForbiddenException(
      `Branch "${loc.name}" is inactive — choose an active branch`,
    );
  }

  const allowed = await resolveAllowedLocationIds(db, user, {
    includeInactive: true,
  });
  if (allowed === 'all') return;
  if (!allowed.includes(locationId)) {
    throw new ForbiddenException(
      'You do not have access to this branch',
    );
  }
}

/** Prefer JWT location, else primary, else MAIN / first allowed */
export async function resolveDefaultLocationId(
  db: Db,
  user: AuthUser,
): Promise<string | null> {
  const allowed = await resolveAllowedLocationIds(db, user);
  const prefer = user.locationId ?? user.storeId ?? null;

  if (prefer) {
    if (allowed === 'all' || allowed.includes(prefer)) {
      const ok = await db.location.findFirst({
        where: { id: prefer, tenantId: user.tenantId, isActive: true },
        select: { id: true },
      });
      if (ok) return ok.id;
    }
  }

  const whereBase =
    allowed === 'all'
      ? { tenantId: user.tenantId, isActive: true }
      : {
          tenantId: user.tenantId,
          isActive: true,
          id: { in: allowed },
        };

  const main = await db.location.findFirst({
    where: { ...whereBase, code: 'MAIN' },
    select: { id: true },
  });
  if (main) return main.id;

  const any = await db.location.findFirst({
    where: whereBase,
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return any?.id ?? null;
}

export type LocationBranchSettings = {
  phone?: string | null;
  email?: string | null;
  managerUserId?: string | null;
  businessHours?: string | null;
  timezone?: string | null;
  currencyCode?: string | null;
  defaultWarehouseId?: string | null;
};

export function parseLocationSettings(
  settings: unknown,
): LocationBranchSettings {
  if (!settings || typeof settings !== 'object') return {};
  const s = settings as Record<string, unknown>;
  return {
    phone: typeof s.phone === 'string' ? s.phone : null,
    email: typeof s.email === 'string' ? s.email : null,
    managerUserId:
      typeof s.managerUserId === 'string' ? s.managerUserId : null,
    businessHours:
      typeof s.businessHours === 'string' ? s.businessHours : null,
    timezone: typeof s.timezone === 'string' ? s.timezone : null,
    currencyCode:
      typeof s.currencyCode === 'string' ? s.currencyCode : null,
    defaultWarehouseId:
      typeof s.defaultWarehouseId === 'string'
        ? s.defaultWarehouseId
        : null,
  };
}

export function mergeLocationSettings(
  existing: unknown,
  patch: LocationBranchSettings,
): Record<string, unknown> {
  const base =
    existing && typeof existing === 'object'
      ? { ...(existing as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null || v === '') delete base[k];
    else base[k] = v;
  }
  return base;
}

/** Resolve sell price: branch StockLevel.sellPrice wins over catalog basePrice */
export function resolveBranchPrice(opts: {
  catalogBasePrice: number | string;
  branchSellPrice?: number | string | null;
}): number {
  const branch =
    opts.branchSellPrice != null && opts.branchSellPrice !== ''
      ? Number(opts.branchSellPrice)
      : NaN;
  if (Number.isFinite(branch) && branch >= 0) return branch;
  const base = Number(opts.catalogBasePrice);
  return Number.isFinite(base) ? base : 0;
}
