/**
 * Shared IAM provisioning helpers for register + seed (Phase 2).
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  DEFAULT_PERMISSION_CODES,
  DEFAULT_ROLES,
  DEFAULT_TENANT_MODULE_CODES,
  PLATFORM_MODULES,
} from './platform-catalog';

type Tx = Prisma.TransactionClient | PrismaClient;

export async function ensurePlatformCatalog(tx: Tx) {
  for (const code of DEFAULT_PERMISSION_CODES) {
    await tx.permission.upsert({
      where: { code },
      create: { code },
      update: {},
    });
  }

  for (const mod of PLATFORM_MODULES) {
    await tx.module.upsert({
      where: { code: mod.code },
      create: {
        code: mod.code,
        name: mod.name,
        description: mod.description,
        dependsOn: mod.dependsOn,
        permissions: mod.permissions,
        isCore: mod.isCore,
        navSchema: mod.navSchema,
      },
      update: {
        name: mod.name,
        description: mod.description,
        dependsOn: mod.dependsOn,
        permissions: mod.permissions,
        isCore: mod.isCore,
        navSchema: mod.navSchema,
      },
    });
  }

  await tx.plan.upsert({
    where: { code: 'starter' },
    create: {
      code: 'starter',
      name: 'Starter',
      priceAmount: 999,
      currencyCode: 'INR',
      limits: { locations: null, users: 10 },
      features: {
        modules: [
          'core',
          'iam',
          'catalog',
          'inventory',
          'orders',
          'pos',
          'payments',
          'rental',
          'appointments',
          'notify',
          'reports',
        ],
      },
    },
    update: {
      limits: { locations: null, users: 10 },
      features: {
        modules: [
          'core',
          'iam',
          'catalog',
          'inventory',
          'orders',
          'pos',
          'payments',
          'rental',
          'appointments',
          'notify',
          'reports',
        ],
      },
    },
  });

  await tx.plan.upsert({
    where: { code: 'professional' },
    create: {
      code: 'professional',
      name: 'Professional',
      priceAmount: 2999,
      currencyCode: 'INR',
      limits: { locations: null, users: 50 },
      features: {
        modules: [
          'core',
          'iam',
          'catalog',
          'inventory',
          'orders',
          'pos',
          'payments',
          'rental',
          'appointments',
          'notify',
          'reports',
        ],
      },
    },
    update: {
      limits: { locations: null, users: 50 },
    },
  });
}

export async function enableTenantModules(
  tx: Tx,
  tenantId: string,
  moduleCodes: readonly string[],
) {
  const mods = await tx.module.findMany({
    where: { code: { in: [...moduleCodes] } },
  });
  for (const mod of mods) {
    await tx.tenantModule.upsert({
      where: {
        tenantId_moduleId: { tenantId, moduleId: mod.id },
      },
      create: {
        tenantId,
        moduleId: mod.id,
        status: 'enabled',
        enabledAt: new Date(),
        config: {},
      },
      update: { status: 'enabled', enabledAt: new Date() },
    });
  }
}

export type ProvisionTenantInput = {
  tenantName: string;
  slug: string;
  taxId?: string;
  locationName: string;
  adminEmail: string;
  adminFullName: string;
  adminPhone?: string;
  passwordHash: string;
  currencyCode?: string;
  locale?: string;
  timezone?: string;
  taxMode?: 'none' | 'simple' | 'in_gst' | 'vat';
  moduleCodes?: readonly string[];
};

export async function provisionTenantWithAdmin(
  tx: Tx,
  input: ProvisionTenantInput,
) {
  await ensurePlatformCatalog(tx);

  const plan = await tx.plan.findUniqueOrThrow({ where: { code: 'starter' } });
  const now = new Date();

  const tenant = await tx.tenant.create({
    data: {
      name: input.tenantName,
      slug: input.slug,
      taxId: input.taxId?.toUpperCase(),
      taxMode: input.taxMode ?? 'in_gst',
      currencyCode: input.currencyCode ?? 'INR',
      locale: input.locale ?? 'en-IN',
      timezone: input.timezone ?? 'Asia/Kolkata',
      status: 'active',
      settings: {
        // Empty until onboarding multi-select (CommerceModeGate)
        commerceModes: [],
        pos: {
          pinSwitchEnabled: true,
        },
      },
      branding: {
        productName: input.tenantName,
        tagline: 'Universal POS',
      },
    },
  });

  await tx.tenantSubscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: 'active',
      seatsUsed: 1,
      locationsUsed: 1,
      currentPeriodEnd: new Date(Date.now() + 365 * 86400000),
    },
  });

  const organization = await tx.organization.create({
    data: {
      tenantId: tenant.id,
      name: input.tenantName,
      code: 'DEFAULT',
      taxId: input.taxId?.toUpperCase(),
      isDefault: true,
    },
  });

  const location = await tx.location.create({
    data: {
      tenantId: tenant.id,
      organizationId: organization.id,
      name: input.locationName,
      code: 'MAIN',
      type: 'store',
      isActive: true,
    },
  });

  const roleRecords = [];
  for (const code of DEFAULT_ROLES) {
    roleRecords.push(
      await tx.role.create({
        data: {
          tenantId: tenant.id,
          code,
          name: code,
          isSystem: true,
        },
      }),
    );
  }

  const adminRole = roleRecords.find((r) => r.code === 'admin')!;
  const allPermissions = await tx.permission.findMany({
    where: { code: { in: [...DEFAULT_PERMISSION_CODES] } },
  });
  for (const permission of allPermissions) {
    await tx.rolePermission.create({
      data: { roleId: adminRole.id, permissionId: permission.id },
    });
  }

  const user = await tx.user.create({
    data: {
      tenantId: tenant.id,
      primaryLocationId: location.id,
      email: input.adminEmail,
      phone: input.adminPhone,
      passwordHash: input.passwordHash,
      fullName: input.adminFullName,
      isActive: true,
      passwordChangedAt: now,
      failedLoginAttempts: 0,
    },
  });

  await tx.employee.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      employeeCode: 'E001',
      status: 'active',
      hiredAt: now,
      jobTitle: 'Owner',
    },
  });

  await tx.userRole.create({
    data: {
      userId: user.id,
      roleId: adminRole.id,
      locationId: location.id,
    },
  });

  await tx.membership.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      locationId: location.id,
      roleId: adminRole.id,
      status: 'active',
    },
  });

  await enableTenantModules(
    tx,
    tenant.id,
    input.moduleCodes ?? DEFAULT_TENANT_MODULE_CODES,
  );

  await tx.auditLog.create({
    data: {
      tenantId: tenant.id,
      actorUserId: user.id,
      entityType: 'tenant',
      entityId: tenant.id,
      action: 'tenant.registered',
      beforeAfter: {
        slug: input.slug,
        locationId: location.id,
        organizationId: organization.id,
      },
    },
  });

  // Default return/refund reason catalog (required by sale returns)
  const refundDefaults = [
    { code: 'defective', label: 'Defective product', sortOrder: 1, appliesTo: 'customer' },
    { code: 'damaged', label: 'Damaged product', sortOrder: 2, appliesTo: 'both' },
    { code: 'wrong_item', label: 'Wrong product', sortOrder: 3, appliesTo: 'customer' },
    { code: 'wrong_size', label: 'Wrong size / size issue', sortOrder: 4, appliesTo: 'customer' },
    { code: 'size_issue', label: 'Size issue', sortOrder: 4, appliesTo: 'customer' },
    { code: 'wrong_color', label: 'Wrong color', sortOrder: 5, appliesTo: 'customer' },
    { code: 'not_as_expected', label: 'Product not as expected', sortOrder: 6, appliesTo: 'customer' },
    { code: 'customer_changed_mind', label: 'Customer changed mind', sortOrder: 7, appliesTo: 'customer' },
    { code: 'duplicate', label: 'Duplicate purchase', sortOrder: 8, appliesTo: 'customer' },
    { code: 'quality', label: 'Quality issue', sortOrder: 9, appliesTo: 'both' },
    { code: 'exchange', label: 'Exchange', sortOrder: 10, appliesTo: 'customer' },
    { code: 'other', label: 'Other', sortOrder: 99, appliesTo: 'both' },
  ];
  for (const d of refundDefaults) {
    await tx.refundReason.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: d.code } },
      create: { tenantId: tenant.id, ...d },
      update: {
        label: d.label,
        isActive: true,
        sortOrder: d.sortOrder,
        appliesTo: d.appliesTo,
      },
    });
  }

  return {
    tenant,
    organization,
    location,
    user,
    roles: ['admin'] as string[],
  };
}
