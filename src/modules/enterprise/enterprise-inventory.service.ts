import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockLedgerType } from '@prisma/client';
import { hasEntitlement } from '../../common/entitlements';
import { writeAudit } from '../../common/audit-write';
import { PrismaService } from '../../database/database.module';
import { canOperateGroup, type EnterprisePrincipal } from './enterprise.types';
import { EnterpriseApprovalsService } from './enterprise-approvals.service';

@Injectable()
export class EnterpriseInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: EnterpriseApprovalsService,
  ) {}

  async map(p: EnterprisePrincipal, q: string) {
    if (!hasEntitlement(p.entitlements, 'GROUP_INVENTORY')) {
      throw new ForbiddenException('GROUP_INVENTORY entitlement required');
    }
    const term = q?.trim();
    if (!term || term.length < 2) {
      throw new BadRequestException('Search query must be at least 2 characters');
    }
    const tenants = await this.visibleInventoryTenants(p);
    if (!tenants.length) return { query: term, items: [] };

    const products = await this.prisma.product.findMany({
      where: {
        tenantId: { in: tenants.map((t) => t.id) },
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { skuCode: { contains: term, mode: 'insensitive' } },
          { barcode: { contains: term, mode: 'insensitive' } },
          { shortName: { contains: term, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
        skuCode: true,
        barcode: true,
        costPrice: true,
      },
      take: 80,
    });
    const showCost =
      p.groupRole === 'owner' ||
      p.groupRole === 'finance' ||
      (p.shopUser?.permissions ?? []).includes('catalog.cost.read') ||
      (p.shopUser?.permissions ?? []).includes('*');

    const productIds = products.map((x) => x.id);
    const levels =
      productIds.length === 0
        ? []
        : await this.prisma.stockLevel.findMany({
            where: { productId: { in: productIds } },
            include: {
              location: { select: { id: true, name: true, type: true } },
            },
          });

    const serials =
      productIds.length === 0
        ? []
        : await this.prisma.stockUnit.findMany({
            where: {
              productId: { in: productIds },
              barcodeSku: { contains: term, mode: 'insensitive' },
            },
            select: {
              barcodeSku: true,
              productId: true,
              locationId: true,
              status: true,
            },
            take: 40,
          });

    const tName = new Map(tenants.map((t) => [t.id, t.name]));
    const byProduct = new Map<string, typeof products>();
    // group products with same sku across tenants
    const groups = new Map<
      string,
      {
        sku: string;
        name: string;
        locations: Array<{
          tenantId: string;
          business: string;
          locationId: string;
          location: string;
          warehouse: boolean;
          available: number;
          reserved: number;
          damaged: number;
          inTransit: number;
          total: number;
          unitCost?: number;
        }>;
        serials: typeof serials;
      }
    >();

    for (const p0 of products) {
      const key = p0.skuCode || p0.id;
      if (!groups.has(key)) {
        groups.set(key, {
          sku: p0.skuCode,
          name: p0.name,
          locations: [],
          serials: [],
        });
      }
    }
    for (const lv of levels) {
      const prod = products.find((x) => x.id === lv.productId);
      if (!prod) continue;
      const key = prod.skuCode || prod.id;
      const g = groups.get(key);
      if (!g) continue;
      const avail = Number(lv.qtyOnHand);
      const dmg = Number(lv.qtyDamaged);
      g.locations.push({
        tenantId: lv.tenantId,
        business: tName.get(lv.tenantId) ?? lv.tenantId,
        locationId: lv.locationId,
        location: lv.location.name,
        warehouse: lv.location.type === 'warehouse',
        available: avail,
        reserved: 0,
        damaged: dmg,
        inTransit: 0,
        total: avail + dmg,
        ...(showCost ? { unitCost: Number(prod.costPrice ?? 0) } : {}),
      });
    }
    for (const s of serials) {
      const prod = products.find((x) => x.id === s.productId);
      if (!prod) continue;
      groups.get(prod.skuCode || prod.id)?.serials.push(s);
    }

    const transit = await this.prisma.intercompanyTransferLine.findMany({
      where: {
        transfer: {
          businessGroupId: p.groupId,
          status: { in: ['issued', 'in_transit'] },
        },
        sku: { in: [...groups.keys()] },
      },
      select: { sku: true, quantity: true },
    });
    for (const t of transit) {
      const g = groups.get(t.sku);
      if (g?.locations[0]) {
        g.locations[0].inTransit += Number(t.quantity);
      }
    }

    return { query: term, showCost, items: [...groups.values()] };
  }

  async createTransfer(
    p: EnterprisePrincipal,
    body: {
      sourceTenantId: string;
      destinationTenantId: string;
      sourceLocationId: string;
      destinationLocationId: string;
      notes?: string;
      lines: Array<{ sku: string; quantity: number; unitCost?: number }>;
    },
  ) {
    if (!hasEntitlement(p.entitlements, 'INTERCOMPANY')) {
      throw new ForbiddenException('INTERCOMPANY entitlement required');
    }
    if (!canOperateGroup(p) && p.shopUser?.tenantId !== body.sourceTenantId) {
      throw new ForbiddenException('Cannot issue from this business');
    }
    if (body.sourceTenantId === body.destinationTenantId) {
      throw new BadRequestException('Use in-tenant stock transfer for the same business');
    }
    await this.assertTenants(p, [body.sourceTenantId, body.destinationTenantId]);
    if (!body.lines?.length) throw new BadRequestException('Lines required');

    const srcLoc = await this.prisma.location.findFirst({
      where: { id: body.sourceLocationId, tenantId: body.sourceTenantId },
    });
    const dstLoc = await this.prisma.location.findFirst({
      where: {
        id: body.destinationLocationId,
        tenantId: body.destinationTenantId,
      },
    });
    if (!srcLoc || !dstLoc) {
      throw new BadRequestException('Locations must belong to the source/destination businesses');
    }

    const gate = await this.approvals.evaluate(p.shopUser, {
      type: 'intercompany',
      tenantId: body.sourceTenantId,
      amount: body.lines.reduce(
        (s, l) => s + Number(l.quantity) * Number(l.unitCost ?? 0),
        0,
      ),
      entityType: 'intercompany_transfer',
      reason: body.notes,
      payload: body,
    });

    const transfer = await this.prisma.intercompanyTransfer.create({
      data: {
        businessGroupId: p.groupId,
        sourceTenantId: body.sourceTenantId,
        destinationTenantId: body.destinationTenantId,
        sourceLocationId: body.sourceLocationId,
        destinationLocationId: body.destinationLocationId,
        notes: body.notes,
        createdById: p.shopUser?.userId,
        status: gate.needsApproval ? 'pending_approval' : 'draft',
        lines: {
          create: await Promise.all(
            body.lines.map(async (line) => {
              const src = await this.prisma.product.findFirst({
                where: {
                  tenantId: body.sourceTenantId,
                  skuCode: line.sku,
                },
                select: { id: true, name: true, costPrice: true },
              });
              return {
                sku: line.sku,
                name: src?.name ?? line.sku,
                sourceProductId: src?.id,
                quantity: line.quantity,
                unitCost: line.unitCost ?? Number(src?.costPrice ?? 0),
              };
            }),
          ),
        },
      },
      include: { lines: true },
    });

    if (gate.needsApproval && p.shopUser) {
      await this.approvals.createRequest(p.shopUser, {
        type: 'intercompany',
        tenantId: body.sourceTenantId,
        entityType: 'intercompany_transfer',
        entityId: transfer.id,
        amount: body.lines.reduce(
          (s, l) => s + Number(l.quantity) * Number(l.unitCost ?? 0),
          0,
        ),
        reason: body.notes,
        payload: { transferId: transfer.id },
      });
    }

    await writeAudit(this.prisma, {
      tenantId: body.sourceTenantId,
      actorUserId: p.shopUser?.userId,
      entityType: 'intercompany_transfer',
      entityId: transfer.id,
      action: 'intercompany.create',
      after: { status: transfer.status, dest: body.destinationTenantId },
      reason: body.notes,
    });
    return transfer;
  }

  async issue(p: EnterprisePrincipal, id: string) {
    const t = await this.load(p, id);
    if (!['draft', 'pending_approval'].includes(t.status)) {
      throw new BadRequestException(`Cannot issue from status ${t.status}`);
    }
    if (t.status === 'pending_approval') {
      throw new ForbiddenException('Awaiting approval');
    }
    await this.prisma.$transaction(async (tx) => {
      for (const line of t.lines) {
        if (!line.sourceProductId) {
          throw new BadRequestException(`Unknown SKU ${line.sku} on source`);
        }
        const level = await tx.stockLevel.findFirst({
          where: {
            tenantId: t.sourceTenantId,
            locationId: t.sourceLocationId,
            productId: line.sourceProductId,
          },
        });
        if (!level || Number(level.qtyOnHand) < Number(line.quantity)) {
          throw new BadRequestException(`Insufficient stock for ${line.sku}`);
        }
        const qtyAfter = Number(level.qtyOnHand) - Number(line.quantity);
        await tx.stockLevel.update({
          where: { id: level.id },
          data: { qtyOnHand: qtyAfter },
        });
        await tx.stockLedgerEntry.create({
          data: {
            tenantId: t.sourceTenantId,
            locationId: t.sourceLocationId,
            productId: line.sourceProductId,
            stockLevelId: level.id,
            type: StockLedgerType.transfer_out,
            qtyDelta: -Number(line.quantity),
            qtyAfter,
            reason: 'Intercompany issue',
            referenceType: 'intercompany_transfer',
            referenceId: t.id,
            actorUserId: p.shopUser?.userId,
            meta: { destinationTenantId: t.destinationTenantId },
          },
        });
      }
      await tx.intercompanyTransfer.update({
        where: { id: t.id },
        data: { status: 'in_transit', issuedAt: new Date() },
      });
    });
    await writeAudit(this.prisma, {
      tenantId: t.sourceTenantId,
      actorUserId: p.shopUser?.userId,
      entityType: 'intercompany_transfer',
      entityId: t.id,
      action: 'intercompany.issue',
      before: { status: t.status },
      after: { status: 'in_transit' },
    });
    return this.load(p, id);
  }

  async receive(p: EnterprisePrincipal, id: string) {
    const t = await this.load(p, id);
    if (t.status !== 'in_transit' && t.status !== 'issued') {
      throw new BadRequestException(`Cannot receive from status ${t.status}`);
    }
    if (
      p.shopUser?.tenantId !== t.destinationTenantId &&
      !canOperateGroup(p)
    ) {
      throw new ForbiddenException('Only destination business can receive');
    }
    await this.prisma.$transaction(async (tx) => {
      for (const line of t.lines) {
        let destProduct = await tx.product.findFirst({
          where: { tenantId: t.destinationTenantId, skuCode: line.sku },
        });
        if (!destProduct) {
          const src = line.sourceProductId
            ? await tx.product.findUnique({ where: { id: line.sourceProductId } })
            : null;
          destProduct = await tx.product.create({
            data: {
              tenantId: t.destinationTenantId,
              name: src?.name ?? line.name,
              skuCode: line.sku,
              kind: src?.kind ?? 'physical',
              basePrice: src?.basePrice ?? 0,
              costPrice: line.unitCost,
              trackQty: true,
            },
          });
        }
        let level = await tx.stockLevel.findFirst({
          where: {
            tenantId: t.destinationTenantId,
            locationId: t.destinationLocationId,
            productId: destProduct.id,
          },
        });
        if (!level) {
          level = await tx.stockLevel.create({
            data: {
              tenantId: t.destinationTenantId,
              locationId: t.destinationLocationId,
              productId: destProduct.id,
              sku: line.sku.slice(0, 18),
              qtyOnHand: 0,
              sellPrice: destProduct.basePrice,
            },
          });
        }
        const qtyAfter = Number(level.qtyOnHand) + Number(line.quantity);
        await tx.stockLevel.update({
          where: { id: level.id },
          data: { qtyOnHand: qtyAfter },
        });
        await tx.stockLedgerEntry.create({
          data: {
            tenantId: t.destinationTenantId,
            locationId: t.destinationLocationId,
            productId: destProduct.id,
            stockLevelId: level.id,
            type: StockLedgerType.transfer_in,
            qtyDelta: Number(line.quantity),
            qtyAfter,
            reason: 'Intercompany receipt',
            referenceType: 'intercompany_transfer',
            referenceId: t.id,
            actorUserId: p.shopUser?.userId,
            meta: { sourceTenantId: t.sourceTenantId },
          },
        });
        await tx.intercompanyTransferLine.update({
          where: { id: line.id },
          data: { destProductId: destProduct.id },
        });
      }
      await tx.intercompanyTransfer.update({
        where: { id: t.id },
        data: {
          status: 'received',
          receivedAt: new Date(),
        },
      });
    });
    await writeAudit(this.prisma, {
      tenantId: t.destinationTenantId,
      actorUserId: p.shopUser?.userId,
      entityType: 'intercompany_transfer',
      entityId: t.id,
      action: 'intercompany.receive',
      before: { status: t.status },
      after: { status: 'received' },
    });
    return this.load(p, id);
  }

  async list(p: EnterprisePrincipal) {
    return this.prisma.intercompanyTransfer.findMany({
      where: { businessGroupId: p.groupId },
      include: { lines: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private async load(p: EnterprisePrincipal, id: string) {
    const t = await this.prisma.intercompanyTransfer.findFirst({
      where: { id, businessGroupId: p.groupId },
      include: { lines: true },
    });
    if (!t) throw new NotFoundException('Transfer not found');
    return t;
  }

  private async assertTenants(p: EnterprisePrincipal, ids: string[]) {
    const n = await this.prisma.tenant.count({
      where: { id: { in: ids }, businessGroupId: p.groupId, status: 'active' },
    });
    if (n !== ids.length) {
      throw new ForbiddenException('Businesses must belong to this group');
    }
  }

  private async visibleInventoryTenants(p: EnterprisePrincipal) {
    if (p.groupRole === 'owner' || p.groupRole === 'finance') {
      return this.prisma.tenant.findMany({
        where: { businessGroupId: p.groupId, status: 'active' },
        select: { id: true, name: true },
      });
    }
    return this.prisma.tenant.findMany({
      where: {
        businessGroupId: p.groupId,
        status: 'active',
        OR: [{ id: { in: p.tenantIds } }, { shareInventory: true }],
      },
      select: { id: true, name: true },
    });
  }
}
