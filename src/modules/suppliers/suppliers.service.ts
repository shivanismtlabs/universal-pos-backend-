import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PoType } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreatePurchaseOrderDto,
  CreateSupplierDto,
  ReceivePurchaseOrderDto,
  UpdatePurchaseOrderDto,
} from './dto/suppliers.dto';

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  createSupplier(user: AuthUser, dto: CreateSupplierDto) {
    return this.prisma.supplier.create({
      data: {
        tenantId: user.tenantId,
        name: dto.name.trim(),
        contact: dto.contact?.trim(),
        phone: dto.phone?.trim(),
      },
    });
  }

  listSuppliers(user: AuthUser) {
    return this.prisma.supplier.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: 'asc' },
    });
  }

  async getSupplier(user: AuthUser, id: string) {
    const row = await this.prisma.supplier.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Supplier not found');
    return row;
  }

  async updateSupplier(
    user: AuthUser,
    id: string,
    dto: { name?: string; contact?: string; phone?: string },
  ) {
    await this.getSupplier(user, id);
    return this.prisma.supplier.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        contact: dto.contact?.trim(),
        phone: dto.phone?.trim(),
      },
    });
  }

  async createPo(user: AuthUser, dto: CreatePurchaseOrderDto) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, tenantId: user.tenantId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    if (dto.linkedOrderId) {
      const order = await this.prisma.order.findFirst({
        where: { id: dto.linkedOrderId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!order) throw new NotFoundException('Linked order not found');
    }

    const lines = dto.lines ?? [];
    if (lines.length) {
      const ids = lines.map((l) => l.stockLevelId);
      const levels = await this.prisma.stockLevel.findMany({
        where: { tenantId: user.tenantId, id: { in: ids } },
        select: { id: true },
      });
      if (levels.length !== new Set(ids).size) {
        throw new BadRequestException('One or more stock levels not found');
      }
    }

    return this.prisma.purchaseOrder.create({
      data: {
        tenantId: user.tenantId,
        supplierId: dto.supplierId,
        poType: dto.poType ?? PoType.purchase,
        linkedOrderId: dto.linkedOrderId,
        expectedDelivery: dto.expectedDelivery
          ? new Date(dto.expectedDelivery)
          : undefined,
        status: 'draft',
        lines: lines.length
          ? {
              create: lines.map((l) => ({
                tenantId: user.tenantId,
                stockLevelId: l.stockLevelId,
                qtyOrdered: l.qtyOrdered,
                unitCost: l.unitCost,
              })),
            }
          : undefined,
      },
      include: {
        supplier: true,
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });
  }

  listPos(user: AuthUser) {
    return this.prisma.purchaseOrder.findMany({
      where: { tenantId: user.tenantId },
      include: {
        supplier: true,
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPo(user: AuthUser, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        supplier: true,
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  async updatePo(user: AuthUser, id: string, dto: UpdatePurchaseOrderDto) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!po) throw new NotFoundException('Purchase order not found');

    const allowed = ['draft', 'ordered', 'partial', 'received', 'cancelled'];
    if (dto.status && !allowed.includes(dto.status)) {
      throw new BadRequestException(`Invalid status. Use: ${allowed.join(', ')}`);
    }
    if (dto.status === 'received') {
      throw new BadRequestException(
        'Use POST /purchase-orders/:id/receive to put stock on the shelf',
      );
    }

    return this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        status: dto.status,
        expectedDelivery: dto.expectedDelivery
          ? new Date(dto.expectedDelivery)
          : undefined,
      },
      include: {
        supplier: true,
        lines: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Receive goods → increase StockLevel.qtyOnHand (atomic).
   */
  async receivePo(user: AuthUser, id: string, dto: ReceivePurchaseOrderDto) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status === 'cancelled') {
      throw new BadRequestException('Cannot receive a cancelled PO');
    }

    return this.prisma.$transaction(async (tx) => {
      const results: Array<{
        stockLevelId: string;
        sku: string;
        qtyAdded: number;
        qtyOnHand: number;
      }> = [];

      for (const incoming of dto.lines) {
        if (incoming.qty < 1) {
          throw new BadRequestException('Receive qty must be ≥ 1');
        }
        const level = await tx.stockLevel.findFirst({
          where: { id: incoming.stockLevelId, tenantId: user.tenantId },
        });
        if (!level) {
          throw new NotFoundException(
            `Stock level ${incoming.stockLevelId} not found`,
          );
        }

        let line = po.lines.find((l) => l.stockLevelId === incoming.stockLevelId);
        if (!line) {
          line = await tx.purchaseOrderLine.create({
            data: {
              tenantId: user.tenantId,
              purchaseOrderId: po.id,
              stockLevelId: incoming.stockLevelId,
              qtyOrdered: incoming.qty,
              qtyReceived: 0,
            },
          });
        }

        await tx.purchaseOrderLine.update({
          where: { id: line.id },
          data: { qtyReceived: { increment: incoming.qty } },
        });

        const updated = await tx.stockLevel.update({
          where: { id: level.id },
          data: { qtyOnHand: { increment: incoming.qty } },
        });

        await tx.stockLedgerEntry.create({
          data: {
            tenantId: user.tenantId,
            locationId: level.locationId,
            productId: level.productId,
            stockLevelId: level.id,
            type: 'purchase_receive',
            qtyDelta: incoming.qty,
            qtyAfter: Number(updated.qtyOnHand),
            reason: `PO ${po.id}`,
            referenceType: 'purchase_order',
            referenceId: po.id,
            actorUserId: user.userId,
          },
        });

        results.push({
          stockLevelId: level.id,
          sku: level.sku,
          qtyAdded: incoming.qty,
          qtyOnHand: Number(updated.qtyOnHand),
        });
      }

      const refreshed = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: po.id, tenantId: user.tenantId },
      });
      const allReceived =
        refreshed.length > 0 &&
        refreshed.every((l) => l.qtyReceived >= l.qtyOrdered);
      const anyReceived = refreshed.some((l) => l.qtyReceived > 0);

      const status = allReceived
        ? 'received'
        : anyReceived
          ? 'partial'
          : po.status === 'draft'
            ? 'ordered'
            : po.status;

      const updatedPo = await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status },
        include: {
          supplier: true,
          lines: {
            include: {
              stockLevel: {
                select: {
                  id: true,
                  sku: true,
                  qtyOnHand: true,
                  product: { select: { name: true } },
                },
              },
            },
          },
        },
      });

      return { purchaseOrder: updatedPo, received: results };
    });
  }

  /**
   * Purchase return (RTV) — reverse stock from a received PO line.
   */
  async returnPo(
    user: AuthUser,
    id: string,
    dto: {
      lines: Array<{ stockLevelId: string; qty: number }>;
      reason?: string;
    },
  ) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status === 'cancelled' || po.status === 'draft') {
      throw new BadRequestException('PO has nothing to return yet');
    }

    return this.prisma.$transaction(async (tx) => {
      const results: Array<{
        stockLevelId: string;
        sku: string;
        qtyReturned: number;
        qtyOnHand: number;
      }> = [];

      for (const line of dto.lines) {
        if (line.qty < 1) {
          throw new BadRequestException('Return qty must be ≥ 1');
        }
        const poLine = po.lines.find(
          (l) => l.stockLevelId === line.stockLevelId,
        );
        if (!poLine) {
          throw new BadRequestException(
            `No PO line for stock level ${line.stockLevelId}`,
          );
        }
        const received = Number(poLine.qtyReceived);
        if (line.qty > received) {
          throw new BadRequestException(
            `Cannot return ${line.qty} (only ${received} received)`,
          );
        }

        const level = await tx.stockLevel.findFirst({
          where: { id: line.stockLevelId, tenantId: user.tenantId },
        });
        if (!level) throw new NotFoundException('Stock level not found');
        if (Number(level.qtyOnHand) < line.qty) {
          throw new BadRequestException(
            `Insufficient on-hand stock for ${level.sku}`,
          );
        }

        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: { qtyReceived: { decrement: line.qty } },
        });
        const updated = await tx.stockLevel.update({
          where: { id: level.id },
          data: { qtyOnHand: { decrement: line.qty } },
        });
        await tx.stockLedgerEntry.create({
          data: {
            tenantId: user.tenantId,
            locationId: level.locationId,
            productId: level.productId,
            stockLevelId: level.id,
            type: 'purchase_return',
            qtyDelta: -line.qty,
            qtyAfter: Number(updated.qtyOnHand),
            reason: dto.reason?.trim() || `RTV PO ${po.id}`,
            referenceType: 'purchase_order',
            referenceId: po.id,
            actorUserId: user.userId,
          },
        });
        results.push({
          stockLevelId: level.id,
          sku: level.sku,
          qtyReturned: line.qty,
          qtyOnHand: Number(updated.qtyOnHand),
        });
      }

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'purchase_order',
          entityId: po.id,
          action: 'purchase.return',
          beforeAfter: {
            reason: dto.reason ?? null,
            lines: results,
          },
        },
      });

      const refreshed = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: po.id },
      });
      const anyOnShelf = refreshed.some((l) => Number(l.qtyReceived) > 0);
      const status = anyOnShelf ? 'partial' : 'ordered';

      const updatedPo = await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status },
        include: {
          supplier: true,
          lines: {
            include: {
              stockLevel: {
                select: {
                  id: true,
                  sku: true,
                  qtyOnHand: true,
                  product: { select: { name: true } },
                },
              },
            },
          },
        },
      });

      return { purchaseOrder: updatedPo, returned: results };
    });
  }
}
