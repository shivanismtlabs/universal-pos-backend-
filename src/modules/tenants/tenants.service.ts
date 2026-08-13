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
  listLocations(user: AuthUser) {
    return this.prisma.location.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'asc' },
    });
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
      const limits = (sub.plan.limits ?? {}) as { locations?: number };
      const maxLoc = limits.locations;
      if (typeof maxLoc === 'number') {
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
        },
      });
      if (sub) {
        await this.prisma.tenantSubscription.update({
          where: { id: sub.id },
          data: { locationsUsed: { increment: 1 } },
        });
      }
      return location;
    } catch (e) {
      throwIfUnique(e, 'Location code already exists for this tenant');
    }
  }

  createStore(user: AuthUser, dto: CreateLocationDto) {
    return this.createLocation(user, dto);
  }

  async getLocation(user: AuthUser, id: string) {
    const location = await this.prisma.location.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!location) throw new NotFoundException('Location not found');
    return location;
  }

  getStore(user: AuthUser, id: string) {
    return this.getLocation(user, id);
  }

  async updateLocation(user: AuthUser, id: string, dto: UpdateLocationDto) {
    await this.getLocation(user, id);

    const data: Prisma.LocationUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.regionCode !== undefined) data.regionCode = dto.regionCode;
    if (dto.type !== undefined) data.type = dto.type;

    return this.prisma.location.update({ where: { id }, data });
  }

  updateStore(user: AuthUser, id: string, dto: UpdateLocationDto) {
    return this.updateLocation(user, id, dto);
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
