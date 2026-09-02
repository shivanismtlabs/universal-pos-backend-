import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ProductionOrderStatus,
  QtyReservationStatus,
  StockLedgerType,
  StockTransferStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { EnterpriseApprovalsService } from '../enterprise/enterprise-approvals.service';
import { StockMutationEngine } from './stock-mutation.engine';

@Injectable()
export class InventoryLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockMutationEngine,
    private readonly approvals: EnterpriseApprovalsService,
  ) {}

  async reserveQty(
    user: AuthUser,
    dto: {
      locationId: string;
      productId: string;
      variantId?: string;
      qty: number;
      orderId?: string;
      customerId?: string;
      expiresAt?: string;
      reason?: string;
    },
  ) {
    const qty = Number(dto.qty);
    if (!(qty > 0)) throw new BadRequestException('qty must be > 0');
    return this.prisma.$transaction(async (tx) => {
      const level = await tx.stockLevel.findFirst({
        where: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          productId: dto.productId,
          variantKey: dto.variantId ?? '',
        },
      });
      if (!level) throw new NotFoundException('Stock level not found');
      await this.stock.adjustReserved(tx, {
        tenantId: user.tenantId,
        stockLevelId: level.id,
        delta: qty,
      });
      const row = await tx.qtyReservation.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          productId: dto.productId,
          variantId: dto.variantId,
          stockLevelId: level.id,
          orderId: dto.orderId,
          customerId: dto.customerId,
          qty,
          status: QtyReservationStatus.active,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          reason: dto.reason,
        },
      });
      await tx.stockLedgerEntry.create({
        data: {
          tenantId: user.tenantId,
          locationId: level.locationId,
          productId: level.productId,
          stockLevelId: level.id,
          type: StockLedgerType.reservation,
          qtyBefore: Number(level.qtyOnHand),
          qtyDelta: 0,
          qtyAfter: Number(level.qtyOnHand),
          reason: dto.reason ?? 'qty reservation',
          referenceType: 'qty_reservation',
          referenceId: row.id,
          actorUserId: user.userId,
          meta: { reservedDelta: qty },
        },
      });
      return row;
    });
  }

  async releaseOrConsumeReservation(
    user: AuthUser,
    id: string,
    action: 'release' | 'consume' | 'cancel',
  ) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.qtyReservation.findFirst({
        where: { id, tenantId: user.tenantId },
      });
      if (!row) throw new NotFoundException('Reservation not found');
      if (row.status !== QtyReservationStatus.active) {
        throw new BadRequestException(`Reservation is ${row.status}`);
      }
      const levelId = row.stockLevelId;
      if (!levelId) throw new BadRequestException('Reservation has no stock level');
      await this.stock.adjustReserved(tx, {
        tenantId: user.tenantId,
        stockLevelId: levelId,
        delta: -Number(row.qty),
      });
      if (action === 'consume') {
        await this.stock.mutateInTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          locationId: row.locationId,
          stockLevelId: levelId,
          qty: -Number(row.qty),
          type: StockLedgerType.sale,
          referenceType: 'qty_reservation',
          referenceId: row.id,
          skipComponentExplosion: true,
        });
      }
      const status =
        action === 'consume'
          ? QtyReservationStatus.consumed
          : action === 'cancel'
            ? QtyReservationStatus.cancelled
            : QtyReservationStatus.released;
      return tx.qtyReservation.update({
        where: { id: row.id },
        data: { status },
      });
    });
  }

  async createTransfer(
    user: AuthUser,
    dto: {
      fromLocationId: string;
      toLocationId: string;
      notes?: string;
      lines: Array<{
        productId: string;
        variantId?: string;
        batchId?: string;
        qty: number;
      }>;
    },
  ) {
    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException('Source and destination must differ');
    }
    if (!dto.lines?.length) throw new BadRequestException('Add at least one line');

    const [fromLoc, toLoc] = await Promise.all([
      this.prisma.location.findFirst({
        where: { id: dto.fromLocationId, tenantId: user.tenantId, isActive: true },
      }),
      this.prisma.location.findFirst({
        where: { id: dto.toLocationId, tenantId: user.tenantId, isActive: true },
      }),
    ]);
    if (!fromLoc) throw new BadRequestException('From location not found');
    if (!toLoc) throw new BadRequestException('To location not found');

    for (const line of dto.lines) {
      const qty = Number(line.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException('Each line qty must be greater than 0');
      }
      const product = await this.prisma.product.findFirst({
        where: {
          id: line.productId,
          tenantId: user.tenantId,
          isActive: true,
        },
        select: { id: true, name: true, trackQty: true },
      });
      if (!product) {
        throw new NotFoundException(`Product ${line.productId} not found`);
      }
      if (!product.trackQty) {
        throw new BadRequestException(
          `"${product.name}" is not quantity-tracked and cannot be transferred in bulk`,
        );
      }
      const onHand = await this.prisma.stockLevel.findFirst({
        where: {
          tenantId: user.tenantId,
          locationId: dto.fromLocationId,
          productId: line.productId,
          variantKey: line.variantId ?? '',
        },
        select: { qtyOnHand: true },
      });
      if (!onHand || Number(onHand.qtyOnHand) + 1e-9 < qty) {
        throw new BadRequestException(
          `Insufficient stock for "${product.name}" at source (have ${Number(onHand?.qtyOnHand ?? 0)})`,
        );
      }
    }

    return this.prisma.stockTransfer.create({
      data: {
        tenantId: user.tenantId,
        fromLocationId: dto.fromLocationId,
        toLocationId: dto.toLocationId,
        notes: dto.notes,
        actorUserId: user.userId,
        status: StockTransferStatus.draft,
        lines: {
          create: dto.lines.map((l) => ({
            tenantId: user.tenantId,
            productId: l.productId,
            variantId: l.variantId,
            batchId: l.batchId,
            qty: l.qty,
          })),
        },
      },
      include: { lines: true },
    });
  }

  async issueTransfer(user: AuthUser, id: string) {
    const preview = await this.prisma.stockTransfer.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { lines: true },
    });
    if (!preview) throw new NotFoundException('Transfer not found');

    await this.approvals.assertOrQueue(user, {
      type: 'stock_transfer',
      tenantId: user.tenantId,
      entityType: 'stock_transfer',
      entityId: id,
      reason: `Issue transfer ${id.slice(0, 8)} (${preview.lines.length} line(s))`,
      payload: {
        transferId: id,
        fromLocationId: preview.fromLocationId,
        toLocationId: preview.toLocationId,
        lines: preview.lines.map((l) => ({
          productId: l.productId,
          qty: Number(l.qty),
        })),
      },
    });

    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.stockTransfer.findFirst({
        where: { id, tenantId: user.tenantId },
        include: { lines: true },
      });
      if (!doc) throw new NotFoundException('Transfer not found');
      if (
        doc.status !== StockTransferStatus.draft &&
        doc.status !== StockTransferStatus.approved
      ) {
        throw new BadRequestException(`Cannot issue from ${doc.status}`);
      }
      for (const line of doc.lines) {
        await this.stock.mutateInTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          locationId: doc.fromLocationId,
          productId: line.productId,
          variantId: line.variantId,
          batchId: line.batchId,
          qty: -Number(line.qty),
          type: StockLedgerType.transfer_out,
          referenceType: 'stock_transfer',
          referenceId: doc.id,
          reason: doc.notes,
          skipComponentExplosion: true,
        });
        const dest = await tx.stockLevel.findFirst({
          where: {
            tenantId: user.tenantId,
            locationId: doc.toLocationId,
            productId: line.productId,
            variantKey: line.variantId ?? '',
          },
        });
        if (dest) {
          await tx.stockLevel.update({
            where: { id: dest.id },
            data: { qtyInTransit: { increment: Number(line.qty) } },
          });
        } else {
          const src = await tx.stockLevel.findFirst({
            where: {
              tenantId: user.tenantId,
              locationId: doc.fromLocationId,
              productId: line.productId,
              variantKey: line.variantId ?? '',
            },
          });
          const product = await tx.product.findFirstOrThrow({
            where: { id: line.productId, tenantId: user.tenantId },
          });
          await tx.stockLevel.create({
            data: {
              tenantId: user.tenantId,
              locationId: doc.toLocationId,
              productId: line.productId,
              variantId: line.variantId,
              variantKey: line.variantId ?? '',
              sku: src?.sku ?? product.skuCode,
              sellUnit: src?.sellUnit ?? product.unitOfMeasure.slice(0, 8),
              sellPrice: src?.sellPrice ?? product.basePrice,
              qtyOnHand: 0,
              qtyInTransit: Number(line.qty),
            },
          });
        }
      }
      return tx.stockTransfer.update({
        where: { id: doc.id },
        data: {
          status: StockTransferStatus.in_transit,
          issuedAt: new Date(),
        },
        include: { lines: true },
      });
    });
  }

  async receiveTransfer(
    user: AuthUser,
    id: string,
    lines: Array<{ lineId: string; qty: number; damagedQty?: number }>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.stockTransfer.findFirst({
        where: { id, tenantId: user.tenantId },
        include: { lines: true },
      });
      if (!doc) throw new NotFoundException('Transfer not found');
      if (
        doc.status !== StockTransferStatus.in_transit &&
        doc.status !== StockTransferStatus.partially_received
      ) {
        throw new BadRequestException(`Cannot receive from ${doc.status}`);
      }
      for (const rec of lines) {
        const line = doc.lines.find((l) => l.id === rec.lineId);
        if (!line) throw new BadRequestException('Unknown transfer line');
        const remaining = Number(line.qty) - Number(line.qtyReceived);
        const take = Number(rec.qty);
        const damaged = Number(rec.damagedQty ?? 0);
        if (take + damaged > remaining + 1e-9) {
          throw new BadRequestException('Receive qty exceeds remaining in transit');
        }
        if (take > 0) {
          await this.stock.mutateInTx(tx, {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            locationId: doc.toLocationId,
            productId: line.productId,
            variantId: line.variantId,
            batchId: line.batchId,
            qty: take,
            type: StockLedgerType.transfer_in,
            referenceType: 'stock_transfer',
            referenceId: doc.id,
            skipComponentExplosion: true,
          });
        }
        const dest = await tx.stockLevel.findFirst({
          where: {
            tenantId: user.tenantId,
            locationId: doc.toLocationId,
            productId: line.productId,
            variantKey: line.variantId ?? '',
          },
        });
        if (dest) {
          await tx.stockLevel.update({
            where: { id: dest.id },
            data: {
              qtyInTransit: { decrement: take + damaged },
              ...(damaged > 0 ? { qtyDamaged: { increment: damaged } } : {}),
            },
          });
        }
        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: {
            qtyReceived: { increment: take },
            qtyDamaged: { increment: damaged },
          },
        });
      }
      const fresh = await tx.stockTransfer.findFirstOrThrow({
        where: { id: doc.id },
        include: { lines: true },
      });
      const allDone = fresh.lines.every(
        (l) => Number(l.qtyReceived) + Number(l.qtyDamaged) + 1e-9 >= Number(l.qty),
      );
      const any = fresh.lines.some((l) => Number(l.qtyReceived) > 0);
      return tx.stockTransfer.update({
        where: { id: doc.id },
        data: {
          status: allDone
            ? StockTransferStatus.received
            : any
              ? StockTransferStatus.partially_received
              : StockTransferStatus.in_transit,
          receivedAt: allDone ? new Date() : fresh.receivedAt,
        },
        include: { lines: true },
      });
    });
  }

  async cancelTransfer(user: AuthUser, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.stockTransfer.findFirst({
        where: { id, tenantId: user.tenantId },
        include: { lines: true },
      });
      if (!doc) throw new NotFoundException('Transfer not found');
      if (doc.status === StockTransferStatus.received) {
        throw new BadRequestException('Fully received transfer cannot be cancelled');
      }
      if (
        doc.status === StockTransferStatus.in_transit ||
        doc.status === StockTransferStatus.partially_received
      ) {
        for (const line of doc.lines) {
          const remaining =
            Number(line.qty) - Number(line.qtyReceived) - Number(line.qtyDamaged);
          if (remaining > 1e-9) {
            await this.stock.mutateInTx(tx, {
              tenantId: user.tenantId,
              actorUserId: user.userId,
              locationId: doc.fromLocationId,
              productId: line.productId,
              variantId: line.variantId,
              batchId: line.batchId,
              qty: remaining,
              type: StockLedgerType.transfer_in,
              reason: 'Transfer cancelled — return to source',
              referenceType: 'stock_transfer',
              referenceId: doc.id,
              skipComponentExplosion: true,
            });
            const dest = await tx.stockLevel.findFirst({
              where: {
                tenantId: user.tenantId,
                locationId: doc.toLocationId,
                productId: line.productId,
                variantKey: line.variantId ?? '',
              },
            });
            if (dest) {
              await tx.stockLevel.update({
                where: { id: dest.id },
                data: { qtyInTransit: { decrement: remaining } },
              });
            }
          }
        }
      }
      return tx.stockTransfer.update({
        where: { id: doc.id },
        data: { status: StockTransferStatus.cancelled },
      });
    });
  }

  async completeProduction(
    user: AuthUser,
    dto: {
      locationId: string;
      finishedProductId: string;
      finishedVariantId?: string;
      qty: number;
      notes?: string;
    },
  ) {
    const qty = Number(dto.qty);
    if (!(qty > 0)) throw new BadRequestException('qty must be > 0');
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.productionOrder.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          finishedProductId: dto.finishedProductId,
          finishedVariantId: dto.finishedVariantId,
          qty,
          notes: dto.notes,
          actorUserId: user.userId,
          status: ProductionOrderStatus.draft,
        },
      });
      const bom = await tx.productBundleLine.findMany({
        where: {
          tenantId: user.tenantId,
          bundleProductId: dto.finishedProductId,
        },
      });
      if (!bom.length) {
        throw new BadRequestException('No BOM / consumption lines on finished product');
      }
      for (const line of bom) {
        await this.stock.mutateInTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          locationId: dto.locationId,
          productId: line.componentProductId,
          variantId: line.componentVariantId,
          qty: -(Number(line.quantity) * qty),
          type: StockLedgerType.production_out,
          referenceType: 'production_order',
          referenceId: order.id,
          skipComponentExplosion: true,
        });
      }
      await this.stock.mutateInTx(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: dto.locationId,
        productId: dto.finishedProductId,
        variantId: dto.finishedVariantId,
        qty,
        type: StockLedgerType.production_in,
        referenceType: 'production_order',
        referenceId: order.id,
        skipComponentExplosion: true,
      });
      return tx.productionOrder.update({
        where: { id: order.id },
        data: {
          status: ProductionOrderStatus.completed,
          completedAt: new Date(),
        },
      });
    });
  }

  async reconcile(user: AuthUser, locationId?: string) {
    const levels = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: user.tenantId,
        ...(locationId ? { locationId } : {}),
      },
      include: {
        product: { select: { name: true, skuCode: true, trackBatch: true, trackSerial: true } },
        location: { select: { name: true } },
      },
      take: 2000,
    });
    const issues: Array<Record<string, unknown>> = [];
    for (const level of levels) {
      const agg = await this.prisma.stockLedgerEntry.aggregate({
        where: { tenantId: user.tenantId, stockLevelId: level.id },
        _sum: { qtyDelta: true },
      });
      const ledgerQty = Number(agg._sum.qtyDelta ?? 0);
      const soh = Number(level.qtyOnHand);
      if (Math.abs(ledgerQty - soh) > 0.02) {
        issues.push({
          kind: 'ledger_vs_soh',
          stockLevelId: level.id,
          sku: level.sku,
          location: level.location.name,
          qtyOnHand: soh,
          ledgerSum: ledgerQty,
          delta: soh - ledgerQty,
        });
      }
      if (level.product.trackBatch) {
        const batches = await this.prisma.productBatch.aggregate({
          where: {
            tenantId: user.tenantId,
            productId: level.productId,
            locationId: level.locationId,
            isActive: true,
            variantId: level.variantId,
          },
          _sum: { qtyOnHand: true },
        });
        const batchSum = Number(batches._sum.qtyOnHand ?? 0);
        if (Math.abs(batchSum - soh) > 0.02) {
          issues.push({
            kind: 'batch_vs_soh',
            stockLevelId: level.id,
            sku: level.sku,
            qtyOnHand: soh,
            batchSum,
          });
        }
      }
    }
    return {
      checked: levels.length,
      issueCount: issues.length,
      issues: issues.slice(0, 200),
    };
  }

  async upsertConversion(
    user: AuthUser,
    dto: { productId?: string; fromUnit: string; toUnit: string; factor: number },
  ) {
    const factor = Number(dto.factor);
    if (!(factor > 0)) throw new BadRequestException('factor must be > 0');
    return this.prisma.unitConversion.upsert({
      where: {
        tenantId_productKey_fromUnit_toUnit: {
          tenantId: user.tenantId,
          productKey: dto.productId ?? '',
          fromUnit: dto.fromUnit.trim(),
          toUnit: dto.toUnit.trim(),
        },
      },
      create: {
        tenantId: user.tenantId,
        productId: dto.productId,
        productKey: dto.productId ?? '',
        fromUnit: dto.fromUnit.trim(),
        toUnit: dto.toUnit.trim(),
        factor,
      },
      update: { factor, productId: dto.productId },
    });
  }

  async listTransfers(user: AuthUser) {
    const rows = await this.prisma.stockTransfer.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        lines: true,
        from: { select: { id: true, name: true, code: true } },
        to: { select: { id: true, name: true, code: true } },
      },
    });
    const productIds = [
      ...new Set(rows.flatMap((r) => r.lines.map((l) => l.productId))),
    ];
    const products = productIds.length
      ? await this.prisma.product.findMany({
          where: { tenantId: user.tenantId, id: { in: productIds } },
          select: {
            id: true,
            name: true,
            skuCode: true,
            unitOfMeasure: true,
          },
        })
      : [];
    const productMap = new Map(products.map((p) => [p.id, p]));
    const actorIds = [
      ...new Set(
        rows
          .map((r) => r.actorUserId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, fullName: true },
        })
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a.fullName]));

    return rows.map((r) => {
      const lines = r.lines.map((l) => {
        const p = productMap.get(l.productId);
        return {
          id: l.id,
          productId: l.productId,
          variantId: l.variantId,
          batchId: l.batchId,
          productName: p?.name ?? '—',
          sku: p?.skuCode ?? '—',
          unit: p?.unitOfMeasure ?? 'pcs',
          qty: Number(l.qty),
          qtyReceived: Number(l.qtyReceived),
          qtyDamaged: Number(l.qtyDamaged),
        };
      });
      const totalQty = lines.reduce((s, l) => s + l.qty, 0);
      return {
        id: r.id,
        status: r.status,
        notes: r.notes,
        createdAt: r.createdAt,
        issuedAt: r.issuedAt,
        receivedAt: r.receivedAt,
        fromLocationId: r.fromLocationId,
        toLocationId: r.toLocationId,
        fromLocationName: r.from.name,
        toLocationName: r.to.name,
        lineCount: lines.length,
        totalQty,
        lines,
        actorName: r.actorUserId
          ? (actorMap.get(r.actorUserId) ?? 'Staff')
          : 'Staff',
      };
    });
  }
}
