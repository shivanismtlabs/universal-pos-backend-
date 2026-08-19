import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { hasEntitlement } from '../../common/entitlements';
import { writeAudit } from '../../common/audit-write';
import { PrismaService } from '../../database/database.module';
import {
  canOperateGroup,
  type EnterprisePrincipal,
} from './enterprise.types';

@Injectable()
export class EnterpriseGroupService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(p: EnterprisePrincipal) {
    const group = await this.prisma.businessGroup.findUniqueOrThrow({
      where: { id: p.groupId },
    });
    const tenants = await this.prisma.tenant.findMany({
      where: { businessGroupId: p.groupId, status: 'active' },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        currencyCode: true,
        timezone: true,
        settings: true,
        shareInventory: true,
        shareSuppliers: true,
        shareCustomers: true,
        businessConfig: { select: { businessType: true } },
        _count: {
          select: {
            locations: true,
            registerSessions: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    const locationCounts = await this.prisma.location.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { in: tenants.map((t) => t.id) },
        isActive: true,
      },
      _count: { _all: true },
    });
    const locMap = new Map(locationCounts.map((r) => [r.tenantId, r._count._all]));

    const openRegisters = await this.prisma.registerSession.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { in: tenants.map((t) => t.id) },
        closedAt: null,
      },
      _count: { _all: true },
    });
    const regMap = new Map(
      openRegisters.map((r) => [r.tenantId, r._count._all]),
    );

    const businesses = tenants.map((t) => {
      const settings =
        t.settings && typeof t.settings === 'object'
          ? (t.settings as Record<string, unknown>)
          : {};
      return {
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        currencyCode: t.currencyCode,
        timezone: t.timezone,
        businessType:
          t.businessConfig?.businessType ||
          (typeof settings.businessType === 'string'
            ? settings.businessType
            : 'general'),
        branchCount: locMap.get(t.id) ?? t._count.locations,
        openRegisterCount: regMap.get(t.id) ?? 0,
        shareInventory: t.shareInventory,
        shareSuppliers: t.shareSuppliers,
        shareCustomers: t.shareCustomers,
        canEnter: p.tenantIds.includes(t.id),
      };
    });

    return {
      group: {
        id: group.id,
        name: group.name,
        slug: group.slug,
        role: p.groupRole,
        entitlements: p.entitlements,
        hideLayer: businesses.length < 2,
        pricingModel: 'platform_plus_registers',
      },
      businesses,
    };
  }

  async setShare(
    p: EnterprisePrincipal,
    tenantId: string,
    body: {
      shareInventory?: boolean;
      shareSuppliers?: boolean;
      shareCustomers?: boolean;
    },
  ) {
    if (!canOperateGroup(p)) {
      throw new ForbiddenException('Only the group owner can change sharing');
    }
    this.assertTenantInGroup(p, tenantId);
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, businessGroupId: p.groupId },
    });
    if (!tenant) throw new NotFoundException('Business not in this group');
    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...(body.shareInventory !== undefined
          ? { shareInventory: body.shareInventory }
          : {}),
        ...(body.shareSuppliers !== undefined
          ? { shareSuppliers: body.shareSuppliers }
          : {}),
        ...(body.shareCustomers !== undefined
          ? { shareCustomers: body.shareCustomers }
          : {}),
      },
    });
    await writeAudit(this.prisma, {
      tenantId,
      actorUserId: p.shopUser?.userId,
      entityType: 'tenant',
      entityId: tenantId,
      action: 'enterprise.share_flags',
      before: {
        shareInventory: tenant.shareInventory,
        shareSuppliers: tenant.shareSuppliers,
        shareCustomers: tenant.shareCustomers,
      },
      after: {
        shareInventory: updated.shareInventory,
        shareSuppliers: updated.shareSuppliers,
        shareCustomers: updated.shareCustomers,
      },
      reason: 'Opt-in group sharing',
    });
    return {
      tenantId,
      shareInventory: updated.shareInventory,
      shareSuppliers: updated.shareSuppliers,
      shareCustomers: updated.shareCustomers,
    };
  }

  assertTenantInGroup(p: EnterprisePrincipal, tenantId: string) {
    if (!p.tenantIds.includes(tenantId) && p.groupRole !== 'owner') {
      throw new ForbiddenException('No access to this business');
    }
  }

  requireEntitlement(p: EnterprisePrincipal, code: string) {
    if (!hasEntitlement(p.entitlements, code)) {
      throw new ForbiddenException(`Entitlement required: ${code}`);
    }
  }

  async staffProfile(p: EnterprisePrincipal) {
    const memberships = await this.prisma.identityTenantMembership.findMany({
      where: { identityId: p.identityId },
      include: {
        tenant: { select: { id: true, name: true, slug: true, status: true } },
        user: {
          include: {
            userRoles: { include: { role: { select: { code: true, name: true } } } },
          },
        },
      },
    });
    return {
      identity: {
        id: p.identityId,
        email: p.email,
        fullName: p.fullName,
        groupRole: p.groupRole,
      },
      memberships: memberships
        .filter((m) => m.tenant.status === 'active')
        .map((m) => ({
          tenantId: m.tenant.id,
          name: m.tenant.name,
          slug: m.tenant.slug,
          userId: m.user.id,
          roles: m.user.userRoles.map((r) => r.role.code),
          inGroup: m.tenant.id && p.tenantIds.includes(m.tenantId),
        })),
    };
  }

  async groupCustomers(p: EnterprisePrincipal, q?: string) {
    this.requireEntitlement(p, 'GROUP_CUSTOMERS');
    const tenants = await this.prisma.tenant.findMany({
      where: {
        businessGroupId: p.groupId,
        shareCustomers: true,
        status: 'active',
        id: { in: this.visibleTenantIds(p) },
      },
      select: { id: true, name: true },
    });
    if (!tenants.length) {
      return { enabled: false, matches: [] as unknown[] };
    }
    const where: Prisma.CustomerWhereInput = {
      tenantId: { in: tenants.map((t) => t.id) },
      deletedAt: null,
      ...(q?.trim()
        ? {
            OR: [
              { phone: { contains: q.trim(), mode: 'insensitive' } },
              { email: { contains: q.trim(), mode: 'insensitive' } },
              { fullName: { contains: q.trim(), mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.customer.findMany({
      where,
      select: {
        id: true,
        tenantId: true,
        fullName: true,
        phone: true,
        email: true,
        storeCreditBalance: true,
      },
      take: 200,
    });
    const byKey = new Map<
      string,
      Array<(typeof rows)[number] & { tenantName: string }>
    >();
    const tName = new Map(tenants.map((t) => [t.id, t.name]));
    for (const r of rows) {
      const key = (r.phone || r.email || r.id).toLowerCase();
      const list = byKey.get(key) ?? [];
      list.push({ ...r, tenantName: tName.get(r.tenantId) ?? r.tenantId });
      byKey.set(key, list);
    }
    const matches = [...byKey.entries()]
      .filter(([, list]) => list.length >= 1)
      .map(([matchKey, list]) => ({
        matchKey,
        totalRelationship: list.reduce(
          (s, x) => s + Number(x.storeCreditBalance ?? 0),
          0,
        ),
        profiles: list,
      }));
    return { enabled: true, matches };
  }

  async groupSuppliers(p: EnterprisePrincipal, q?: string) {
    this.requireEntitlement(p, 'GROUP_PROCUREMENT');
    const tenantIds = this.visibleTenantIds(p);
    const shared = await this.prisma.tenant.findMany({
      where: {
        id: { in: tenantIds },
        businessGroupId: p.groupId,
        OR: [{ shareSuppliers: true }, { id: { in: p.tenantIds } }],
      },
      select: { id: true, name: true },
    });
    const ids = shared.map((t) => t.id);
    const suppliers = await this.prisma.supplier.findMany({
      where: {
        tenantId: { in: ids },
        ...(q?.trim()
          ? {
              OR: [
                { name: { contains: q.trim(), mode: 'insensitive' } },
                { phone: { contains: q.trim(), mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, tenantId: true, name: true, phone: true },
      take: 200,
    });
    const invoices = await this.prisma.supplierInvoice.groupBy({
      by: ['supplierId', 'tenantId'],
      where: {
        tenantId: { in: ids },
        status: { in: ['open', 'partial'] },
      },
      _sum: { grandTotal: true, amountPaid: true },
    });
    const ap = new Map(
      invoices.map((i) => [
        `${i.tenantId}:${i.supplierId}`,
        Number(i._sum.grandTotal ?? 0) - Number(i._sum.amountPaid ?? 0),
      ]),
    );
    const tName = new Map(shared.map((t) => [t.id, t.name]));
    return {
      suppliers: suppliers.map((s) => ({
        ...s,
        tenantName: tName.get(s.tenantId),
        outstanding: ap.get(`${s.tenantId}:${s.id}`) ?? 0,
      })),
    };
  }

  async procurementSummary(p: EnterprisePrincipal) {
    this.requireEntitlement(p, 'GROUP_PROCUREMENT');
    const tenantIds = this.visibleTenantIds(p);
    const [byTenant, bySupplier] = await Promise.all([
      this.prisma.supplierInvoice.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: tenantIds }, status: { not: 'void' } },
        _sum: { grandTotal: true, amountPaid: true },
      }),
      this.prisma.supplierInvoice.groupBy({
        by: ['supplierId', 'tenantId'],
        where: { tenantId: { in: tenantIds }, status: { not: 'void' } },
        _sum: { grandTotal: true, amountPaid: true },
        orderBy: { _sum: { grandTotal: 'desc' } },
        take: 50,
      }),
    ]);
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true },
    });
    const tName = new Map(tenants.map((t) => [t.id, t.name]));
    return {
      byBusiness: byTenant.map((r) => ({
        tenantId: r.tenantId,
        name: tName.get(r.tenantId),
        spend: Number(r._sum.grandTotal ?? 0),
        outstanding:
          Number(r._sum.grandTotal ?? 0) - Number(r._sum.amountPaid ?? 0),
      })),
      bySupplier: bySupplier.map((r) => ({
        supplierId: r.supplierId,
        tenantId: r.tenantId,
        tenantName: tName.get(r.tenantId),
        spend: Number(r._sum.grandTotal ?? 0),
        outstanding:
          Number(r._sum.grandTotal ?? 0) - Number(r._sum.amountPaid ?? 0),
      })),
    };
  }

  async startSpinOff(
    p: EnterprisePrincipal,
    tenantId: string,
    confirmation: string,
  ) {
    this.requireEntitlement(p, 'SPIN_OFF');
    if (!canOperateGroup(p)) {
      throw new ForbiddenException('Only the group owner can spin off a business');
    }
    if (confirmation !== 'SPIN_OFF') {
      throw new ForbiddenException('Confirmation must be SPIN_OFF');
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, businessGroupId: p.groupId },
    });
    if (!tenant) throw new NotFoundException('Business not in this group');

    const [locations, products, orders, users] = await Promise.all([
      this.prisma.location.count({ where: { tenantId } }),
      this.prisma.product.count({ where: { tenantId } }),
      this.prisma.order.count({ where: { tenantId } }),
      this.prisma.user.count({ where: { tenantId } }),
    ]);

    const row = await this.prisma.businessSpinOff.create({
      data: {
        businessGroupId: p.groupId,
        tenantId,
        status: 'exported',
        requestedByIdentityId: p.identityId,
        confirmation,
        exportPayload: {
          tenant: {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            taxId: tenant.taxId,
          },
          counts: { locations, products, orders, users },
          ownership: 'tenant',
          groupOwned: [],
          exportedAt: new Date().toISOString(),
        },
      },
    });
    await writeAudit(this.prisma, {
      tenantId,
      actorUserId: p.shopUser?.userId,
      entityType: 'business_spin_off',
      entityId: row.id,
      action: 'enterprise.spin_off.export',
      after: { tenantId, status: 'exported' },
      reason: 'Owner requested spin-off export',
    });
    return row;
  }

  async completeSpinOff(p: EnterprisePrincipal, spinOffId: string) {
    this.requireEntitlement(p, 'SPIN_OFF');
    if (!canOperateGroup(p)) {
      throw new ForbiddenException('Only the group owner can complete spin-off');
    }
    const row = await this.prisma.businessSpinOff.findFirst({
      where: { id: spinOffId, businessGroupId: p.groupId },
    });
    if (!row) throw new NotFoundException('Spin-off not found');
    if (row.status === 'detached') return row;

    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: row.tenantId },
    });
    const newGroup = await this.prisma.businessGroup.create({
      data: {
        name: `${tenant.name} (spun off)`,
        slug: `${tenant.slug}-solo-${Date.now().toString(36).slice(-4)}`,
        ownerIdentityId: p.identityId,
        entitlements: p.entitlements,
        settings: { spunOffFrom: p.groupId },
      },
    });
    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: { businessGroupId: newGroup.id },
    });
    await this.prisma.businessGroupMembership.create({
      data: {
        groupId: newGroup.id,
        identityId: p.identityId,
        role: 'owner',
      },
    });
    const done = await this.prisma.businessSpinOff.update({
      where: { id: row.id },
      data: {
        status: 'detached',
        completedAt: new Date(),
        exportPayload: {
          ...(row.exportPayload as object),
          newGroupId: newGroup.id,
        },
      },
    });
    await writeAudit(this.prisma, {
      tenantId: tenant.id,
      actorUserId: p.shopUser?.userId,
      entityType: 'business_spin_off',
      entityId: row.id,
      action: 'enterprise.spin_off.detach',
      before: { businessGroupId: p.groupId },
      after: { businessGroupId: newGroup.id },
      reason: 'Spin-off completed — other businesses unchanged',
    });
    return { ...done, newGroupId: newGroup.id };
  }

  visibleTenantIds(p: EnterprisePrincipal) {
    if (p.groupRole === 'owner' || p.groupRole === 'finance' || p.groupRole === 'auditor') {
      return p.tenantIds.length
        ? undefined
        : [];
    }
    return p.tenantIds;
  }

  async allTenantIdsInGroup(groupId: string) {
    const rows = await this.prisma.tenant.findMany({
      where: { businessGroupId: groupId, status: 'active' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
