import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateStockAdjustmentDto,
  ListStockAdjustmentsQueryDto,
  StockAdjustmentStatusDto,
  StockAdjustmentTypeDto,
  UpdateStockAdjustmentDto,
} from './dto/stock-adjustment.dto';
import { StockMutationEngine } from './stock-mutation.engine';
import { Prisma, StockLedgerType } from '@prisma/client';

@Injectable()
export class StockAdjustmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockEngine: StockMutationEngine,
  ) {}

  /** Auto-generate next unique adjustment number for tenant: ADJ-YYYY-000001 */
  private async generateNextAdjustmentNo(tenantId: string): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `ADJ-${year}-`;
    const latest = await this.prisma.stockAdjustment.findFirst({
      where: {
        tenantId,
        adjustmentNo: { startsWith: prefix },
      },
      orderBy: { createdAt: 'desc' },
      select: { adjustmentNo: true },
    });

    if (!latest) {
      return `${prefix}000001`;
    }

    const numStr = latest.adjustmentNo.replace(prefix, '');
    const nextNum = (parseInt(numStr, 10) || 0) + 1;
    return `${prefix}${String(nextNum).padStart(6, '0')}`;
  }

  /** Validate location and lines before saving/finalizing */
  private async validateAdjustmentInput(
    tenantId: string,
    locationId: string,
    lines: Array<{
      productId: string;
      adjustmentQty: number;
      adjustmentValue?: number;
      newQty: number;
    }>,
    type: StockAdjustmentTypeDto,
  ) {
    // 1. Verify location
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId, isActive: true },
    });
    if (!loc) {
      throw new BadRequestException('Invalid or inactive store/location selected');
    }

    if (!lines || lines.length === 0) {
      throw new BadRequestException('At least one item is required for adjustment');
    }

    // 2. Verify products exist, belong to tenant, and are not archived/deleted
    const productIds = Array.from(new Set(lines.map((l) => l.productId)));
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        tenantId,
        status: { not: 'archived' },
      },
      select: { id: true, name: true, skuCode: true, trackQty: true },
    });

    if (products.length !== productIds.length) {
      throw new BadRequestException(
        'One or more selected products are invalid, inactive, or belong to another store',
      );
    }

    // 3. Validate line numbers
    for (const line of lines) {
      const isQtyAdj = type === StockAdjustmentTypeDto.quantity;
      if (isQtyAdj && Math.abs(line.adjustmentQty) < 1e-9) {
        throw new BadRequestException(
          'Adjustment quantity cannot be zero',
        );
      }
      if (!isQtyAdj && Math.abs(line.adjustmentValue ?? 0) < 1e-9 && Math.abs(line.adjustmentQty) < 1e-9) {
        throw new BadRequestException(
          'Adjustment value or quantity cannot be zero',
        );
      }
      if (line.newQty < 0) {
        throw new BadRequestException(
          `New stock quantity cannot be negative (${line.newQty})`,
        );
      }
    }

    return loc;
  }

  async create(user: AuthUser, dto: CreateStockAdjustmentDto) {
    await this.validateAdjustmentInput(
      user.tenantId,
      dto.locationId,
      dto.lines,
      dto.type,
    );

    const adjustmentNo = await this.generateNextAdjustmentNo(user.tenantId);
    const targetStatus = dto.status ?? StockAdjustmentStatusDto.draft;
    const isFinalizing = targetStatus === StockAdjustmentStatusDto.adjusted;

    const adjustment = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.stockAdjustment.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          adjustmentNo,
          adjustmentDate: new Date(dto.adjustmentDate),
          type: dto.type,
          status: isFinalizing ? StockAdjustmentStatusDto.adjusted : targetStatus,
          reason: dto.reason.trim(),
          description: dto.description?.trim() || null,
          attachments: dto.attachments ?? [],
          createdById: user.userId,
          finalizedAt: isFinalizing ? new Date() : null,
          finalizedById: isFinalizing ? user.userId : null,
          lines: {
            create: dto.lines.map((l) => ({
              tenantId: user.tenantId,
              productId: l.productId,
              stockLevelId: l.stockLevelId || null,
              currentQty: l.currentQty,
              adjustmentQty: l.adjustmentQty,
              newQty: l.newQty,
              unit: l.unit || 'pcs',
              currentUnitCost: l.currentUnitCost ?? null,
              adjustmentValue: l.adjustmentValue ?? null,
              serialNumber: l.serialNumber?.trim() || null,
              notes: l.notes?.trim() || null,
            })),
          },
        },
        include: {
          lines: {
            include: {
              product: { select: { id: true, name: true, skuCode: true } },
            },
          },
          location: { select: { id: true, name: true, code: true } },
          createdBy: { select: { id: true, fullName: true, email: true } },
        },
      });

      if (isFinalizing) {
        await this.applyAdjustmentStockMutations(tx, user, created);
      }

      return created;
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'stock_adjustment',
        entityId: adjustment.id,
        action: isFinalizing ? 'create_and_finalize' : 'create_draft',
        beforeAfter: {
          adjustmentNo: adjustment.adjustmentNo,
          status: adjustment.status,
          itemCount: adjustment.lines.length,
        },
      },
    });

    return adjustment;
  }

  async findAll(user: AuthUser, query: ListStockAdjustmentsQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: any = {
      tenantId: user.tenantId,
    };

    if (query.locationId) {
      where.locationId = query.locationId;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.type) {
      where.type = query.type;
    }
    if (query.startDate || query.endDate) {
      where.adjustmentDate = {};
      if (query.startDate) where.adjustmentDate.gte = new Date(query.startDate);
      if (query.endDate) where.adjustmentDate.lte = new Date(query.endDate);
    }
    if (query.search?.trim()) {
      const q = query.search.trim();
      where.OR = [
        { adjustmentNo: { contains: q, mode: 'insensitive' } },
        { reason: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { createdBy: { fullName: { contains: q, mode: 'insensitive' } } },
        { lines: { some: { product: { name: { contains: q, mode: 'insensitive' } } } } },
        { lines: { some: { product: { skuCode: { contains: q, mode: 'insensitive' } } } } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.stockAdjustment.count({ where }),
      this.prisma.stockAdjustment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          location: { select: { id: true, name: true, code: true } },
          createdBy: { select: { id: true, fullName: true } },
          lines: {
            include: {
              product: { select: { id: true, name: true, skuCode: true } },
            },
          },
        },
      }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(user: AuthUser, id: string) {
    const adj = await this.prisma.stockAdjustment.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        location: { select: { id: true, name: true, code: true } },
        createdBy: { select: { id: true, fullName: true, email: true } },
        finalizedBy: { select: { id: true, fullName: true, email: true } },
        cancelledBy: { select: { id: true, fullName: true, email: true } },
        lines: {
          include: {
            product: { select: { id: true, name: true, skuCode: true, photoUrl: true } },
            stockLevel: { select: { id: true, qtyOnHand: true, sellPrice: true } },
          },
        },
      },
    });

    if (!adj) {
      throw new NotFoundException('Adjustment record not found');
    }

    return adj;
  }

  async update(user: AuthUser, id: string, dto: UpdateStockAdjustmentDto) {
    const existing = await this.findOne(user, id);

    if (existing.status !== StockAdjustmentStatusDto.draft) {
      throw new ForbiddenException(
        `Only draft adjustments can be updated (current status: ${existing.status})`,
      );
    }

    const locationId = dto.locationId ?? existing.locationId;
    const linesToValidate = dto.lines
      ? dto.lines
      : existing.lines.map((l: any) => ({
          productId: l.productId,
          adjustmentQty: Number(l.adjustmentQty),
          adjustmentValue: l.adjustmentValue ? Number(l.adjustmentValue) : undefined,
          newQty: Number(l.newQty),
        }));

    await this.validateAdjustmentInput(
      user.tenantId,
      locationId,
      linesToValidate,
      dto.type ?? (existing.type as StockAdjustmentTypeDto),
    );

    const isFinalizing = dto.status === StockAdjustmentStatusDto.adjusted;

    const updated = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 1. Delete existing lines if new lines provided
      if (dto.lines) {
        await tx.stockAdjustmentLine.deleteMany({
          where: { adjustmentId: id, tenantId: user.tenantId },
        });
      }

      // 2. Update header and re-create lines
      const adj = await tx.stockAdjustment.update({
        where: { id },
        data: {
          locationId: dto.locationId ?? undefined,
          adjustmentDate: dto.adjustmentDate ? new Date(dto.adjustmentDate) : undefined,
          type: dto.type ?? undefined,
          status: isFinalizing ? StockAdjustmentStatusDto.adjusted : dto.status ?? undefined,
          reason: dto.reason?.trim() ?? undefined,
          description: dto.description !== undefined ? dto.description.trim() || null : undefined,
          attachments: dto.attachments ?? undefined,
          finalizedAt: isFinalizing ? new Date() : undefined,
          finalizedById: isFinalizing ? user.userId : undefined,
          lines: dto.lines
            ? {
                create: dto.lines.map((l) => ({
                  tenantId: user.tenantId,
                  productId: l.productId,
                  stockLevelId: l.stockLevelId || null,
                  currentQty: l.currentQty,
                  adjustmentQty: l.adjustmentQty,
                  newQty: l.newQty,
                  unit: l.unit || 'pcs',
                  currentUnitCost: l.currentUnitCost ?? null,
                  adjustmentValue: l.adjustmentValue ?? null,
                  serialNumber: l.serialNumber?.trim() || null,
                  notes: l.notes?.trim() || null,
                })),
              }
            : undefined,
        },
        include: {
          lines: {
            include: {
              product: { select: { id: true, name: true, skuCode: true } },
            },
          },
          location: { select: { id: true, name: true, code: true } },
          createdBy: { select: { id: true, fullName: true } },
        },
      });

      if (isFinalizing) {
        await this.applyAdjustmentStockMutations(tx, user, adj);
      }

      return adj;
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'stock_adjustment',
        entityId: id,
        action: isFinalizing ? 'update_and_finalize' : 'update_draft',
        beforeAfter: {
          adjustmentNo: updated.adjustmentNo,
          status: updated.status,
        },
      },
    });

    return updated;
  }

  async finalize(user: AuthUser, id: string) {
    const existing = await this.findOne(user, id);

    if (existing.status === StockAdjustmentStatusDto.adjusted) {
      throw new BadRequestException('Adjustment has already been finalized');
    }
    if (existing.status === StockAdjustmentStatusDto.cancelled) {
      throw new BadRequestException('Cancelled adjustments cannot be finalized');
    }

    const finalized = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const adj = await tx.stockAdjustment.update({
        where: { id },
        data: {
          status: StockAdjustmentStatusDto.adjusted,
          finalizedAt: new Date(),
          finalizedById: user.userId,
        },
        include: {
          lines: {
            include: {
              product: { select: { id: true, name: true, skuCode: true } },
            },
          },
          location: { select: { id: true, name: true, code: true } },
          createdBy: { select: { id: true, fullName: true } },
        },
      });

      await this.applyAdjustmentStockMutations(tx, user, adj);
      return adj;
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'stock_adjustment',
        entityId: id,
        action: 'finalize',
        beforeAfter: {
          adjustmentNo: finalized.adjustmentNo,
          status: finalized.status,
        },
      },
    });

    return finalized;
  }

  async cancel(user: AuthUser, id: string, reason?: string) {
    const existing = await this.findOne(user, id);

    if (existing.status === StockAdjustmentStatusDto.cancelled) {
      throw new BadRequestException('Adjustment is already cancelled');
    }

    const isFinalized = existing.status === StockAdjustmentStatusDto.adjusted;

    const cancelled = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const adj = await tx.stockAdjustment.update({
        where: { id },
        data: {
          status: StockAdjustmentStatusDto.cancelled,
          cancelledAt: new Date(),
          cancelledById: user.userId,
          description: reason
            ? `${existing.description ? `${existing.description}\n` : ''}[CANCELLED]: ${reason}`
            : existing.description,
        },
        include: {
          lines: {
            include: {
              product: { select: { id: true, name: true, skuCode: true } },
            },
          },
          location: { select: { id: true, name: true, code: true } },
          createdBy: { select: { id: true, fullName: true } },
        },
      });

      // If adjustment was previously finalized, reverse stock changes atomically
      if (isFinalized) {
        for (const line of adj.lines) {
          const reverseQty = -Number(line.adjustmentQty);
          if (Math.abs(reverseQty) > 1e-9) {
            let stockLevel = await tx.stockLevel.findFirst({
              where: {
                tenantId: user.tenantId,
                locationId: adj.locationId,
                productId: line.productId,
              },
            });

            if (stockLevel) {
              await this.stockEngine.mutate(tx, {
                tenantId: user.tenantId,
                actorUserId: user.userId,
                locationId: adj.locationId,
                stockLevelId: stockLevel.id,
                qty: reverseQty,
                type: StockLedgerType.adjustment,
                reason: `Reversal of Adjustment ${adj.adjustmentNo}: ${reason || 'Cancelled'}`,
                referenceType: 'stock_adjustment_reversal',
                referenceId: adj.id,
                serialNumber: line.serialNumber || undefined,
                idempotencyKey: `adj-reversal:${adj.id}:${line.id}`,
              });
            }
          }
        }
      }

      return adj;
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'stock_adjustment',
        entityId: id,
        action: isFinalized ? 'cancel_and_reverse' : 'cancel_draft',
        beforeAfter: {
          adjustmentNo: cancelled.adjustmentNo,
          status: cancelled.status,
          reason,
        },
      },
    });

    return cancelled;
  }

  async delete(user: AuthUser, id: string) {
    const existing = await this.findOne(user, id);

    if (existing.status !== StockAdjustmentStatusDto.draft) {
      throw new ForbiddenException(
        `Only draft adjustments can be deleted (status: ${existing.status})`,
      );
    }

    await this.prisma.stockAdjustment.delete({
      where: { id },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'stock_adjustment',
        entityId: id,
        action: 'delete_draft',
        beforeAfter: {
          adjustmentNo: existing.adjustmentNo,
        },
      },
    });

    return { success: true, message: `Draft adjustment ${existing.adjustmentNo} deleted` };
  }

  /** Execute stock mutations for each line item upon finalization */
  private async applyAdjustmentStockMutations(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    adjustment: any,
  ) {
    for (const line of adjustment.lines) {
      const delta = Number(line.adjustmentQty);
      if (Math.abs(delta) < 1e-9) continue;

      let stockLevel = await tx.stockLevel.findFirst({
        where: {
          tenantId: user.tenantId,
          locationId: adjustment.locationId,
          productId: line.productId,
        },
      });

      if (!stockLevel) {
        const prod = await tx.product.findFirst({
          where: { id: line.productId, tenantId: user.tenantId },
        });
        if (!prod) continue;

        stockLevel = await tx.stockLevel.create({
          data: {
            tenantId: user.tenantId,
            locationId: adjustment.locationId,
            productId: line.productId,
            sku: prod.skuCode,
            sellUnit: line.unit || prod.unitOfMeasure || 'pcs',
            sellPrice: prod.basePrice,
            qtyOnHand: 0,
          },
        });
      }

      await this.stockEngine.mutate(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: adjustment.locationId,
        stockLevelId: stockLevel.id,
        qty: delta,
        type: StockLedgerType.adjustment,
        reason: `Adjustment ${adjustment.adjustmentNo}: ${adjustment.reason}`,
        referenceType: 'stock_adjustment',
        referenceId: adjustment.id,
        serialNumber: line.serialNumber || undefined,
        idempotencyKey: `adj:${adjustment.id}:${line.id}`,
      });
    }
  }
}
