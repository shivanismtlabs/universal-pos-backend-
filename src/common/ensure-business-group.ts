import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/database.module';
import { DEFAULT_GROUP_ENTITLEMENTS } from './entitlements';

const DEFAULT_POLICIES: Array<{ type: string; config: Prisma.InputJsonValue }> =
  [
    {
      type: 'refund',
      config: {
        cashierMaxAmount: 1000,
        managerMaxAmount: 5000,
        steps: [{ role: 'manager' }, { role: 'admin' }],
      },
    },
    {
      type: 'discount',
      config: {
        cashierMaxPercent: 5,
        managerMaxPercent: 15,
        steps: [{ role: 'manager' }, { role: 'admin' }],
      },
    },
    {
      type: 'stock_adjustment',
      config: { requireApproval: true, steps: [{ role: 'manager' }] },
    },
    {
      type: 'stock_transfer',
      config: { requireApproval: false, steps: [{ role: 'manager' }] },
    },
    {
      type: 'purchase',
      config: { managerMaxAmount: 25000, steps: [{ role: 'manager' }] },
    },
    {
      type: 'expense',
      config: { managerMaxAmount: 5000, steps: [{ role: 'manager' }] },
    },
    {
      type: 'price_change',
      config: { requireApproval: true, steps: [{ role: 'manager' }] },
    },
    {
      type: 'credit_sale',
      config: { requireApproval: true, steps: [{ role: 'manager' }] },
    },
    {
      type: 'intercompany',
      config: { requireApproval: true, steps: [{ role: 'admin' }] },
    },
  ];

const DEFAULT_ALERTS = [
  'sales_drop',
  'cash_mismatch',
  'unusual_discount',
  'large_refund',
  'inventory_shrinkage',
  'low_stock',
  'dead_stock',
  'overdue_ap',
  'overdue_ar',
  'unusual_expense',
  'negative_margin',
  'high_return_rate',
] as const;

function slugify(name: string) {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s.length >= 2 ? s : `group-${randomUUID().slice(0, 8)}`;
}

export async function ensureBusinessGroupForIdentity(
  db: PrismaService,
  identityId: string,
) {
  const identity = await db.identityAccount.findUnique({
    where: { id: identityId },
    select: { id: true, fullName: true, email: true },
  });
  if (!identity) return null;

  const memberships = await db.identityTenantMembership.findMany({
    where: { identityId },
    select: {
      tenantId: true,
      tenant: {
        select: {
          id: true,
          name: true,
          businessGroupId: true,
          status: true,
        },
      },
    },
  });

  const active = memberships.filter((m) => m.tenant?.status === 'active');
  if (!active.length) return null;

  const existingGroupId =
    active.find((m) => m.tenant.businessGroupId)?.tenant.businessGroupId ??
    null;

  let group = existingGroupId
    ? await db.businessGroup.findUnique({ where: { id: existingGroupId } })
    : null;

  if (!group) {
    const name = `${identity.fullName.trim() || 'Owner'}'s group`;
    let slug = slugify(name);
    const clash = await db.businessGroup.findUnique({ where: { slug } });
    if (clash) slug = `${slug}-${randomUUID().slice(0, 6)}`;
    group = await db.businessGroup.create({
      data: {
        name,
        slug,
        ownerIdentityId: identity.id,
        entitlements: DEFAULT_GROUP_ENTITLEMENTS,
        settings: {
          pricingModel: 'platform_plus_registers',
          hideLayerWhenSingleTenant: true,
        },
      },
    });
  }

  const unlinked = active
    .filter((m) => m.tenant.businessGroupId !== group!.id)
    .map((m) => m.tenantId);
  if (unlinked.length) {
    await db.tenant.updateMany({
      where: { id: { in: unlinked } },
      data: { businessGroupId: group.id },
    });
  }

  await db.businessGroupMembership.upsert({
    where: {
      groupId_identityId: { groupId: group.id, identityId },
    },
    create: {
      groupId: group.id,
      identityId,
      role: 'owner',
    },
    update: { role: 'owner' },
  });

  await seedDefaultPolicies(db, group.id);

  return {
    ...group,
    tenantIds: active.map((m) => m.tenantId),
  };
}

async function seedDefaultPolicies(db: PrismaService, groupId: string) {
  const [policyCount, alertCount] = await Promise.all([
    db.approvalPolicy.count({ where: { businessGroupId: groupId } }),
    db.exceptionAlertRule.count({ where: { businessGroupId: groupId } }),
  ]);
  if (policyCount === 0) {
    await db.approvalPolicy.createMany({
      data: DEFAULT_POLICIES.map((p) => ({
        businessGroupId: groupId,
        type: p.type,
        enabled: true,
        config: p.config,
      })),
    });
  }
  if (alertCount === 0) {
    await db.exceptionAlertRule.createMany({
      data: DEFAULT_ALERTS.map((type) => ({
        businessGroupId: groupId,
        type,
        enabled: true,
        threshold:
          type === 'sales_drop' ? 20 : type === 'large_refund' ? 5000 : null,
        cooldownMinutes: 360,
        recipients: { roles: ['owner'] },
      })),
    });
  }
}
