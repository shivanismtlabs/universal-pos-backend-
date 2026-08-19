import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaxMode } from '@prisma/client';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateLocationDto,
  CreateOrganizationDto,
  UpdateLocationDto,
  UpdateTenantDto,
} from './dto/tenants.dto';
import { ensureTenantTaxSettings } from '../../common/tax-engine';
import {
  assertLocationAccess,
  mergeLocationSettings,
  parseLocationSettings,
  resolveAllowedLocationIds,
} from '../../common/location-access';
import { seedZeroStockForNewLocation } from '../../common/stock-at-location';
import { Role } from '../../common/roles';

const TENANT_SELECT = {
  id: true,
  name: true,
  slug: true,
  taxId: true,
  taxMode: true,
  currencyCode: true,
  locale: true,
  timezone: true,
  status: true,
  branding: true,
  settings: true,
} satisfies Prisma.TenantSelect;

@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: TENANT_SELECT,
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const settingsRoot =
      tenant.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const taxBlock =
      settingsRoot.tax && typeof settingsRoot.tax === 'object'
        ? (settingsRoot.tax as Record<string, unknown>)
        : null;
    const needsTaxBackfill =
      !taxBlock ||
      (typeof taxBlock.ratePercent !== 'number' &&
        typeof taxBlock.ratePercent !== 'string');

    if (needsTaxBackfill) {
      const nextSettings = ensureTenantTaxSettings(
        tenant.settings,
        tenant.taxMode as TaxMode,
      );
      const updated = await this.prisma.tenant.update({
        where: { id: user.tenantId },
        data: { settings: nextSettings as Prisma.InputJsonValue },
        select: TENANT_SELECT,
      });
      return {
        ...updated,
        gstin: updated.taxId,
      };
    }

    return {
      ...tenant,
      gstin: tenant.taxId,
    };
  }

  async updateMe(user: AuthUser, dto: UpdateTenantDto) {
    const existing = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true, taxId: true, taxMode: true, branding: true },
    });
    if (!existing) throw new NotFoundException('Tenant not found');

    const data: Prisma.TenantUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.taxId !== undefined) {
      const v = dto.taxId.trim();
      data.taxId = v ? v.toUpperCase() : null;
    }
    if (dto.gstin !== undefined) {
      const v = dto.gstin.trim();
      data.taxId = v ? v.toUpperCase() : null;
    }
    if (dto.taxMode !== undefined) data.taxMode = dto.taxMode;
    if (dto.branding !== undefined) {
      const prev =
        existing.branding && typeof existing.branding === 'object'
          ? { ...(existing.branding as Record<string, unknown>) }
          : {};
      data.branding = {
        ...prev,
        ...dto.branding,
      } as Prisma.InputJsonValue;
    }
    if (dto.currencyCode !== undefined)
      data.currencyCode = dto.currencyCode.trim().toUpperCase();
    if (dto.locale !== undefined) data.locale = dto.locale.trim();
    if (dto.timezone !== undefined) data.timezone = dto.timezone.trim();

    const prevSettings =
      existing.settings && typeof existing.settings === 'object'
        ? ({ ...(existing.settings as Record<string, unknown>) } as Record<
            string,
            unknown
          >)
        : {};

    if (dto.settings !== undefined) {
      for (const [key, value] of Object.entries(dto.settings)) {
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          prevSettings[key] &&
          typeof prevSettings[key] === 'object' &&
          !Array.isArray(prevSettings[key])
        ) {
          prevSettings[key] = {
            ...(prevSettings[key] as Record<string, unknown>),
            ...(value as Record<string, unknown>),
          };
        } else {
          prevSettings[key] = value;
        }
      }
    }
    if (dto.tax !== undefined) {
      const prevTax =
        prevSettings.tax && typeof prevSettings.tax === 'object'
          ? { ...(prevSettings.tax as Record<string, unknown>) }
          : {};
      if (dto.tax.ratePercent !== undefined)
        prevTax.ratePercent = dto.tax.ratePercent;
      if (dto.tax.inclusive !== undefined) prevTax.inclusive = dto.tax.inclusive;
      if (dto.tax.receiptFooter !== undefined)
        prevTax.receiptFooter = dto.tax.receiptFooter;
      prevSettings.tax = prevTax;
    }
    if (
      dto.maxCashierDiscountPercent !== undefined ||
      dto.pinSwitchEnabled !== undefined ||
      dto.upiVpa !== undefined ||
      dto.upiPayeeName !== undefined
    ) {
      const prevPos =
        prevSettings.pos && typeof prevSettings.pos === 'object'
          ? { ...(prevSettings.pos as Record<string, unknown>) }
          : {};
      if (dto.maxCashierDiscountPercent !== undefined) {
        prevPos.maxCashierDiscountPercent = dto.maxCashierDiscountPercent;
      }
      if (dto.pinSwitchEnabled !== undefined) {
        prevPos.pinSwitchEnabled = dto.pinSwitchEnabled;
      }
      if (dto.upiVpa !== undefined) {
        const vpa = dto.upiVpa.trim();
        prevPos.upiVpa = vpa || null;
      }
      if (dto.upiPayeeName !== undefined) {
        const name = dto.upiPayeeName.trim();
        prevPos.upiPayeeName = name || null;
      }
      prevSettings.pos = prevPos;
    }
    if (
      dto.settings !== undefined ||
      dto.tax !== undefined ||
      dto.maxCashierDiscountPercent !== undefined ||
      dto.pinSwitchEnabled !== undefined ||
      dto.upiVpa !== undefined ||
      dto.upiPayeeName !== undefined
    ) {
      data.settings = prevSettings as Prisma.InputJsonValue;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('No settings fields to update');
    }

    const tenant = await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data,
      select: TENANT_SELECT,
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        action: 'tenant.settings_updated',
        entityType: 'tenant',
        entityId: user.tenantId,
        beforeAfter: {
          taxMode: tenant.taxMode,
          taxId: tenant.taxId,
          branding: tenant.branding,
          settings: tenant.settings,
        },
      },
    });

    return { ...tenant, gstin: tenant.taxId };
  }

  listOrganizations(user: AuthUser) {
    return this.prisma.organization.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createOrganization(user: AuthUser, dto: CreateOrganizationDto) {
    const code = dto.code.trim().toUpperCase();
    try {
      return await this.prisma.organization.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name.trim(),
          code,
          taxId: dto.taxId?.toUpperCase(),
          isDefault: dto.isDefault ?? false,
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Organization code already exists');
    }
  }

  /** Locations (stores / warehouses / …). Also exposed as /stores for compat. */
  async listLocations(user: AuthUser) {
    const allowed = await resolveAllowedLocationIds(this.prisma, user, {
      includeInactive: true,
    });
    const rows = await this.prisma.location.findMany({
      where: {
        tenantId: user.tenantId,
        ...(allowed === 'all' ? {} : { id: { in: allowed } }),
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.mapLocation(r));
  }

  listStores(user: AuthUser) {
    return this.listLocations(user);
  }

  async createLocation(user: AuthUser, dto: CreateLocationDto) {
    const code = (dto.code ?? (dto.isMain ? 'MAIN' : undefined))
      ?.trim()
      .toUpperCase();
    if (!code) {
      throw new BadRequestException('code is required unless isMain is true');
    }

    const sub = await this.prisma.tenantSubscription.findFirst({
      where: { tenantId: user.tenantId, status: 'active' },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    if (sub) {
      const limits = (sub.plan.limits ?? {}) as { locations?: number | null };
      const maxLoc = limits.locations;
      // null / undefined / <= 0 ⇒ unlimited branches
      if (typeof maxLoc === 'number' && maxLoc > 0) {
        const used = await this.prisma.location.count({
          where: { tenantId: user.tenantId },
        });
        if (used >= maxLoc) {
          throw new BadRequestException(
            `Plan limit reached: max ${maxLoc} locations`,
          );
        }
      }
    }

    let organizationId = dto.organizationId;
    if (!organizationId) {
      const def = await this.prisma.organization.findFirst({
        where: { tenantId: user.tenantId, isDefault: true },
        select: { id: true },
      });
      organizationId = def?.id;
    }

    if (dto.managerUserId) {
      await this.assertManagerUser(user.tenantId, dto.managerUserId);
    }
    if (dto.defaultWarehouseId) {
      await this.assertWarehouse(user.tenantId, dto.defaultWarehouseId);
    }
    if (dto.parentLocationId) {
      await this.assertParentLocation(user.tenantId, dto.parentLocationId);
    }

    const settings = mergeLocationSettings(
      {},
      {
        phone: dto.phone,
        email: dto.email,
        managerUserId: dto.managerUserId,
        businessHours: dto.businessHours,
        timezone: dto.timezone,
        currencyCode: dto.currencyCode,
        defaultWarehouseId: dto.defaultWarehouseId,
        parentLocationId: dto.parentLocationId,
      },
    );

    try {
      const location = await this.prisma.location.create({
        data: {
          tenantId: user.tenantId,
          organizationId,
          name: dto.name.trim(),
          code,
          type: dto.type ?? 'store',
          address: dto.address?.trim(),
          regionCode: dto.regionCode?.trim(),
          isActive: true,
          settings: settings as Prisma.InputJsonValue,
        },
      });
      await seedZeroStockForNewLocation(this.prisma, {
        tenantId: user.tenantId,
        locationId: location.id,
      });
      if (sub) {
        await this.prisma.tenantSubscription.update({
          where: { id: sub.id },
          data: { locationsUsed: { increment: 1 } },
        });
      }
      await this.prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'location',
          entityId: location.id,
          action: 'branch.created',
          beforeAfter: {
            after: {
              name: location.name,
              code: location.code,
              type: location.type,
            },
          },
        },
      });
      return this.mapLocation(location);
    } catch (e) {
      throwIfUnique(e, 'Location code already exists for this tenant');
    }
  }

  createStore(user: AuthUser, dto: CreateLocationDto) {
    return this.createLocation(user, dto);
  }

  async getLocation(user: AuthUser, id: string) {
    await assertLocationAccess(this.prisma, user, id, {
      requireActive: false,
    });
    const location = await this.prisma.location.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!location) throw new NotFoundException('Location not found');
    return this.mapLocation(location);
  }

  getStore(user: AuthUser, id: string) {
    return this.getLocation(user, id);
  }

  async updateLocation(user: AuthUser, id: string, dto: UpdateLocationDto) {
    await assertLocationAccess(this.prisma, user, id, {
      requireActive: false,
    });
    const existing = await this.prisma.location.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!existing) throw new NotFoundException('Location not found');

    if (dto.isActive === false && existing.isActive) {
      // Soft-deactivate only — never hard-delete branches with history
      // (delete endpoint intentionally omitted)
    }

    if (dto.managerUserId) {
      await this.assertManagerUser(user.tenantId, dto.managerUserId);
    }
    if (dto.defaultWarehouseId) {
      await this.assertWarehouse(user.tenantId, dto.defaultWarehouseId);
    }
    if (dto.parentLocationId) {
      await this.assertParentLocation(
        user.tenantId,
        dto.parentLocationId,
        id,
      );
    }

    const settingsPatch: Record<string, unknown> = {};
    const hasSettingsPatch =
      dto.phone !== undefined ||
      dto.email !== undefined ||
      dto.managerUserId !== undefined ||
      dto.businessHours !== undefined ||
      dto.timezone !== undefined ||
      dto.currencyCode !== undefined ||
      dto.defaultWarehouseId !== undefined ||
      dto.parentLocationId !== undefined;

    const data: Prisma.LocationUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.regionCode !== undefined) data.regionCode = dto.regionCode;
    if (dto.type !== undefined) data.type = dto.type;
    if (hasSettingsPatch) {
      data.settings = mergeLocationSettings(existing.settings, {
        phone: dto.phone,
        email: dto.email,
        managerUserId: dto.managerUserId,
        businessHours: dto.businessHours,
        timezone: dto.timezone,
        currencyCode: dto.currencyCode,
        defaultWarehouseId: dto.defaultWarehouseId,
        parentLocationId: dto.parentLocationId,
      }) as Prisma.InputJsonValue;
      Object.assign(settingsPatch, data.settings as object);
    }

    const updated = await this.prisma.location.update({ where: { id }, data });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'location',
        entityId: id,
        action:
          dto.isActive === false && existing.isActive
            ? 'branch.deactivated'
            : dto.isActive === true && !existing.isActive
              ? 'branch.activated'
              : 'branch.updated',
        beforeAfter: {
          before: {
            name: existing.name,
            isActive: existing.isActive,
            settings: parseLocationSettings(existing.settings),
          },
          after: {
            name: updated.name,
            isActive: updated.isActive,
            settings: parseLocationSettings(updated.settings),
          },
        },
      },
    });
    return this.mapLocation(updated);
  }

  updateStore(user: AuthUser, id: string, dto: UpdateLocationDto) {
    return this.updateLocation(user, id, dto);
  }

  /** Branch KPIs for dashboard — scoped + ACL */
  async branchDashboard(user: AuthUser, locationId: string) {
    await assertLocationAccess(this.prisma, user, locationId, {
      requireActive: false,
    });
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: user.tenantId },
    });
    if (!loc) throw new NotFoundException('Location not found');

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const [
      todayOrders,
      todaySalesAgg,
      todayRefunds,
      todayExpensesAgg,
      outOfStock,
      openRegister,
      levels,
    ] = await Promise.all([
      this.prisma.order.count({
        where: {
          tenantId: user.tenantId,
          locationId,
          createdAt: { gte: start, lte: end },
          status: { in: ['closed', 'fulfilled', 'ready'] },
        },
      }),
      this.prisma.order.aggregate({
        where: {
          tenantId: user.tenantId,
          locationId,
          createdAt: { gte: start, lte: end },
          status: { not: 'cancelled' },
        },
        _sum: { subtotal: true, taxTotal: true },
        _count: true,
      }),
      this.prisma.returnEvent.count({
        where: {
          tenantId: user.tenantId,
          createdAt: { gte: start, lte: end },
          order: { locationId },
        },
      }),
      this.prisma.expense.aggregate({
        where: {
          tenantId: user.tenantId,
          locationId,
          spentAt: { gte: start, lte: end },
          status: 'approved',
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.stockLevel.count({
        where: {
          tenantId: user.tenantId,
          locationId,
          qtyOnHand: { lte: 0 },
        },
      }),
      this.prisma.registerSession.findFirst({
        where: {
          tenantId: user.tenantId,
          locationId,
          closedAt: null,
        },
        select: { id: true, openedAt: true, openingFloat: true },
      }),
      this.prisma.stockLevel.findMany({
        where: { tenantId: user.tenantId, locationId },
        select: {
          qtyOnHand: true,
          sellPrice: true,
          reorderPoint: true,
        },
        take: 5000,
      }),
    ]);

    const lowStockCount = levels.filter((l) => {
      const q = Number(l.qtyOnHand);
      const rp = l.reorderPoint != null ? Number(l.reorderPoint) : 5;
      return q > 0 && q <= rp;
    }).length;

    const invValue = levels.reduce(
      (sum, r) => sum + Number(r.qtyOnHand) * Number(r.sellPrice),
      0,
    );

    const salesTotal =
      Number(todaySalesAgg._sum.subtotal ?? 0) +
      Number(todaySalesAgg._sum.taxTotal ?? 0);

    return {
      branch: this.mapLocation(loc),
      today: {
        salesTotal,
        orders: todaySalesAgg._count || todayOrders,
        refunds: todayRefunds,
        expensesTotal: Number(todayExpensesAgg._sum.amount ?? 0),
        expensesCount: todayExpensesAgg._count,
      },
      inventory: {
        value: Math.round(invValue * 100) / 100,
        lowStock: lowStockCount,
        outOfStock,
      },
      registerOpen: Boolean(openRegister),
      register: openRegister,
    };
  }

  /** HQ rollup across allowed branches */
  async multiStoreDashboard(user: AuthUser) {
    const allowed = await resolveAllowedLocationIds(this.prisma, user);
    const locations = await this.prisma.location.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        ...(allowed === 'all' ? {} : { id: { in: allowed } }),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true, type: true },
    });

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const byBranch = await Promise.all(
      locations.map(async (loc) => {
        const sales = await this.prisma.order.aggregate({
          where: {
            tenantId: user.tenantId,
            locationId: loc.id,
            createdAt: { gte: start, lte: end },
            status: { not: 'cancelled' },
          },
          _sum: { subtotal: true, taxTotal: true },
          _count: true,
        });
        const todaySales =
          Number(sales._sum.subtotal ?? 0) + Number(sales._sum.taxTotal ?? 0);
        return {
          locationId: loc.id,
          name: loc.name,
          code: loc.code,
          type: loc.type,
          todaySales,
          todayOrders: sales._count,
        };
      }),
    );

    const totalSales = byBranch.reduce((s, b) => s + b.todaySales, 0);
    const totalOrders = byBranch.reduce((s, b) => s + b.todayOrders, 0);

    return {
      totalStores: locations.length,
      activeStores: locations.length,
      today: { salesTotal: totalSales, orders: totalOrders },
      byBranch,
      canViewAll: allowed === 'all' || user.roles?.includes(Role.admin),
    };
  }

  private mapLocation(row: {
    id: string;
    tenantId: string;
    organizationId: string | null;
    name: string;
    code: string;
    type: string;
    address: string | null;
    regionCode: string | null;
    isActive: boolean;
    settings: unknown;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const s = parseLocationSettings(row.settings);
    return {
      id: row.id,
      tenantId: row.tenantId,
      organizationId: row.organizationId,
      name: row.name,
      code: row.code,
      type: row.type,
      address: row.address,
      regionCode: row.regionCode,
      isActive: row.isActive,
      phone: s.phone ?? null,
      email: s.email ?? null,
      managerUserId: s.managerUserId ?? null,
      businessHours: s.businessHours ?? null,
      timezone: s.timezone ?? null,
      currencyCode: s.currencyCode ?? null,
      defaultWarehouseId: s.defaultWarehouseId ?? null,
      parentLocationId: s.parentLocationId ?? null,
      settings: row.settings,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      /** API alias — branchId === locationId */
      branchId: row.id,
    };
  }

  private async assertManagerUser(tenantId: string, userId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true },
    });
    if (!u) throw new BadRequestException('Manager user not found');
  }

  private async assertWarehouse(tenantId: string, locationId: string) {
    const w = await this.prisma.location.findFirst({
      where: {
        id: locationId,
        tenantId,
        type: { in: ['warehouse', 'store', 'branch'] },
      },
      select: { id: true },
    });
    if (!w) {
      throw new BadRequestException('Default warehouse / location not found');
    }
  }

  /**
   * Organization → Location tree via settings.parentLocationId.
   * Location has no Prisma parentId yet — JSON keeps this additive (no migrate).
   */
  private async assertParentLocation(
    tenantId: string,
    parentId: string,
    childId?: string,
  ) {
    if (childId && parentId === childId) {
      throw new BadRequestException('A location cannot be its own parent');
    }
    const parent = await this.prisma.location.findFirst({
      where: { id: parentId, tenantId },
      select: { id: true },
    });
    if (!parent) {
      throw new BadRequestException('Parent location not found');
    }
    let cur: string | null = parentId;
    const seen = new Set<string>();
    while (cur) {
      if (childId && cur === childId) {
        throw new BadRequestException(
          'Circular location hierarchy — choose a different parent',
        );
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      const row: { settings: Prisma.JsonValue } | null =
        await this.prisma.location.findFirst({
          where: { id: cur, tenantId },
          select: { settings: true },
        });
      cur = parseLocationSettings(row?.settings).parentLocationId ?? null;
    }
  }

  async bootstrap(user: AuthUser) {
    const [tenant, modules, locations, organizations] = await Promise.all([
      this.getMe(user),
      this.prisma.tenantModule.findMany({
        where: { tenantId: user.tenantId, status: 'enabled' },
        include: {
          module: {
            select: {
              code: true,
              name: true,
              navSchema: true,
              dependsOn: true,
              permissions: true,
            },
          },
        },
      }),
      this.listLocations(user),
      this.listOrganizations(user),
    ]);

    const nav = modules.flatMap((m) => {
      const schema = m.module.navSchema;
      return Array.isArray(schema) ? schema : [];
    });

    return {
      tenant,
      organizations,
      locations,
      modules: modules.map((m) => ({
        code: m.module.code,
        name: m.module.name,
        dependsOn: m.module.dependsOn,
        permissions: m.module.permissions,
        navSchema: m.module.navSchema,
        config: m.config,
      })),
      nav,
    };
  }
}
