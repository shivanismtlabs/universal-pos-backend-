import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderKind,
  OrderStatus,
  PaymentStatus,
  PaymentType,
  RentalOrderLifecycle,
  ReservationStatus,
  StockUnitStatus,
} from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from '../payments/payments.service';
import {
  CreateReturnDto,
  InspectReturnDto,
  ListReturnsQueryDto,
  SettleDepositDto,
} from './dto/returns.dto';

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async create(user: AuthUser, dto: CreateReturnDto) {
    const unitId = dto.stockUnitId ?? dto.inventoryUnitId;
    if (!unitId) {
      throw new BadRequestException('stockUnitId is required');
    }

    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId },
      include: { rentalExt: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const rentalOk =
      order.rentalExt?.lifecycle === RentalOrderLifecycle.checked_out ||
      order.rentalExt?.lifecycle === RentalOrderLifecycle.returned ||
      order.rentalExt?.lifecycle === RentalOrderLifecycle.inspected ||
      order.rentalExt?.lifecycle === RentalOrderLifecycle.ready ||
      order.rentalExt?.lifecycle === RentalOrderLifecycle.reserved ||
      order.rentalExt?.lifecycle === RentalOrderLifecycle.fitted;
    const coreOk =
      order.status === OrderStatus.fulfilled ||
      order.status === OrderStatus.ready ||
      order.status === OrderStatus.closed ||
      order.status === OrderStatus.confirmed;
    if (!rentalOk && !coreOk) {
      throw new BadRequestException(
        `Order ${order.orderNumber} is not checked out yet and cannot be returned`,
      );
    }

    const item = await this.prisma.orderItem.findFirst({
      where: {
        orderId: dto.orderId,
        tenantId: user.tenantId,
        OR: [{ stockUnitId: unitId }, { id: unitId }],
      },
    });
    if (!item) {
      throw new BadRequestException('Item is not on this order');
    }

    const actualStockUnitId = item.stockUnitId ?? null;

    const existingEvents = await this.prisma.returnEvent.findMany({
      where: { tenantId: user.tenantId, orderId: dto.orderId },
      select: { stockUnitId: true, itemsJson: true },
    });

    let alreadyReturnedQty = 0;
    for (const e of existingEvents) {
      if (actualStockUnitId && e.stockUnitId === actualStockUnitId) {
        throw new BadRequestException('This serialized unit was already returned on this order');
      }
      if (Array.isArray(e.itemsJson)) {
        for (const it of e.itemsJson as Array<{ orderItemId?: string; quantity?: number }>) {
          if (it.orderItemId === item.id) {
            alreadyReturnedQty += Number(it.quantity ?? 1);
          }
        }
      }
    }

    const orderedQty = Number(item.quantity ?? 1);
    const returnQty = Number(dto.quantityToReturn ?? 1);
    if (alreadyReturnedQty + returnQty > orderedQty) {
      throw new BadRequestException(
        `Cannot return ${returnQty} units. Only ${orderedQty - alreadyReturnedQty} units remain checked out on this order.`,
      );
    }

    const event = await this.prisma.$transaction(async (tx) => {
      const isDamaged = dto.inspectStatus === 'damaged';
      const isCleaningNeeded = dto.cleaningRequired || dto.inspectStatus === 'needs_cleaning';

      const returnEvent = await tx.returnEvent.create({
        data: {
          tenantId: user.tenantId,
          orderId: dto.orderId,
          stockUnitId: actualStockUnitId,
          receivedById: user.userId,
          notes: dto.inspectNotes,
          itemsJson: [{ orderItemId: item.id, quantity: returnQty }],
          approvedById: dto.inspectStatus ? user.userId : undefined,
        },
      });

      if (actualStockUnitId) {
        await tx.stockReservation.updateMany({
          where: {
            tenantId: user.tenantId,
            orderItemId: item.id,
            status: ReservationStatus.checked_out,
          },
          data: { status: ReservationStatus.released },
        });

        const targetStatus = isDamaged
          ? StockUnitStatus.repair
          : isCleaningNeeded
            ? StockUnitStatus.cleaning
            : StockUnitStatus.available;

        await tx.stockUnit.update({
          where: { id: actualStockUnitId },
          data: {
            status: targetStatus,
            ...(isDamaged ? { condition: 'damaged' } : {}),
          },
        });

        if (isDamaged) {
          await tx.modRentalDamageRecord.create({
            data: {
              tenantId: user.tenantId,
              stockUnitId: actualStockUnitId,
              inspectStatus: 'damaged',
              notes: dto.inspectNotes,
              chargeAmount: dto.damageFee,
            },
          });
        }

        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId: actualStockUnitId,
            fromStatus: StockUnitStatus.checked_out,
            toStatus: targetStatus,
            reason: isDamaged ? 'rental.returned_damaged' : 'rental.returned',
            actorUserId: user.userId,
            orderId: dto.orderId,
          },
        });

        if (isCleaningNeeded) {
          await tx.modRentalCleaningJob.create({
            data: {
              tenantId: user.tenantId,
              stockUnitId: actualStockUnitId,
              status: 'queued',
              notes: dto.inspectNotes,
            },
          });
        }
      }

      // Update lifecycle status (checked_out or returned/inspected)
      if (order.rentalExt) {
        const unitLines = await tx.orderItem.findMany({
          where: {
            orderId: dto.orderId,
            tenantId: user.tenantId,
          },
          select: { id: true, stockUnitId: true, quantity: true },
        });
        const returned = await tx.returnEvent.findMany({
          where: { orderId: dto.orderId, tenantId: user.tenantId },
          select: { stockUnitId: true, itemsJson: true },
        });
        const returnedUnitIds = new Set(
          returned.map((r) => r.stockUnitId).filter(Boolean),
        );
        const itemReturnedQtyMap = new Map<string, number>();
        for (const r of returned) {
          if (Array.isArray(r.itemsJson)) {
            for (const it of r.itemsJson as Array<{ orderItemId?: string; quantity?: number }>) {
              if (it.orderItemId) {
                const prev = itemReturnedQtyMap.get(it.orderItemId) ?? 0;
                itemReturnedQtyMap.set(it.orderItemId, prev + Number(it.quantity ?? 1));
              }
            }
          }
        }
        const allBack = unitLines.every(
          (l) =>
            (l.stockUnitId && returnedUnitIds.has(l.stockUnitId)) ||
            ((itemReturnedQtyMap.get(l.id) ?? 0) >= Number(l.quantity ?? 1)),
        );

        const newLifecycle = allBack
          ? (dto.inspectStatus ? RentalOrderLifecycle.inspected : RentalOrderLifecycle.returned)
          : RentalOrderLifecycle.checked_out;

        await tx.modRentalOrder.update({
          where: { orderId: dto.orderId },
          data: { lifecycle: newLifecycle },
        });
      }

      return returnEvent;
    });

    return event;
  }

  /** Orders with units still out — for Returns / Exchange desks */
  async listCandidates(user: AuthUser) {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        OR: [
          { kind: OrderKind.rental },
          { rentalExt: { isNot: null } },
          { depositTotal: { gt: 0 } },
        ],
        status: { notIn: [OrderStatus.cancelled] },
        NOT: {
          rentalExt: {
            lifecycle: RentalOrderLifecycle.cancelled,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        customer: { select: { id: true, fullName: true, phone: true } },
        rentalExt: {
          select: {
            lifecycle: true,
            pickupDate: true,
            returnDueDate: true,
          },
        },
        payments: {
          where: { status: PaymentStatus.succeeded },
          select: { id: true, amount: true, type: true, status: true },
        },
        items: {
          include: {
            stockUnit: {
              select: {
                id: true,
                barcodeSku: true,
                variantLabel: true,
                status: true,
              },
            },
            product: { select: { id: true, name: true, skuCode: true } },
          },
        },
        returnEvents: { select: { stockUnitId: true, itemsJson: true } },
      },
    });

    const allStockUnitIds = orders
      .flatMap((o) => o.items.map((i) => i.stockUnitId))
      .filter((id): id is string => Boolean(id));

    const damageRecords = allStockUnitIds.length
      ? await this.prisma.modRentalDamageRecord.findMany({
          where: { tenantId: user.tenantId, stockUnitId: { in: allStockUnitIds } },
          select: { stockUnitId: true, chargeAmount: true },
        })
      : [];

    const damageMap = new Map<string, number>();
    for (const d of damageRecords) {
      if (d.stockUnitId) {
        const prev = damageMap.get(d.stockUnitId) ?? 0;
        damageMap.set(d.stockUnitId, prev + Number(d.chargeAmount ?? 0));
      }
    }

    return {
      items: orders.map((o) => {
        const totalAmount =
          Number((o as { totalAmount?: number }).totalAmount ?? 0) ||
          (Number(o.subtotal ?? 0) +
            Number(o.taxTotal ?? 0) -
            Number(o.discountTotal ?? 0));
        const balanceDue = Number(o.balanceDue ?? 0);
        const depTotal = Number(o.depositTotal ?? 0);
        let paidAmount = 0;
        let heldDeposit = 0;
        let depositRefunded = 0;

        for (const p of o.payments ?? []) {
          if (p.status && p.status !== PaymentStatus.succeeded) continue;
          const amt = Number(p.amount ?? 0);
          if (p.type === PaymentType.deposit_refund || p.type === PaymentType.refund) {
            depositRefunded += amt;
          } else {
            paidAmount += amt;
          }
        }

        const rawHeld =
          depTotal > 0
            ? depTotal
            : Math.max(0, paidAmount - totalAmount);

        heldDeposit = Math.max(0, rawHeld - depositRefunded);
        const meta = (o.meta ?? {}) as Record<string, unknown>;
        const isSettled = Boolean(meta.depositSettledAt);
        if (isSettled) {
          heldDeposit = 0;
        }

        const returnedUnitIds = new Set(
          o.returnEvents.map((r) => r.stockUnitId).filter(Boolean),
        );
        const itemReturnedQtyMap = new Map<string, number>();
        for (const r of o.returnEvents) {
          if (Array.isArray(r.itemsJson)) {
            for (const it of r.itemsJson as Array<{ orderItemId?: string; quantity?: number }>) {
              if (it.orderItemId) {
                const prev = itemReturnedQtyMap.get(it.orderItemId) ?? 0;
                itemReturnedQtyMap.set(it.orderItemId, prev + Number(it.quantity ?? 1));
              }
            }
          }
        }

        const unitsOut = o.items
          .filter((i) => {
            const unitId = i.stockUnitId ?? i.id;
            if (returnedUnitIds.has(unitId)) return false;
            const alreadyReturned = itemReturnedQtyMap.get(i.id) ?? 0;
            const orderedQty = Number(i.quantity ?? 1);
            return alreadyReturned < orderedQty;
          })
          .map((i) => {
            const alreadyReturned = itemReturnedQtyMap.get(i.id) ?? 0;
            const remainingQty = Math.max(0, Number(i.quantity ?? 1) - alreadyReturned);
            return {
              stockUnitId: i.stockUnitId ?? i.id,
              barcode:
                i.stockUnit?.barcodeSku ??
                i.product?.skuCode ??
                i.id.slice(0, 8),
              barcodeSku:
                i.stockUnit?.barcodeSku ??
                i.product?.skuCode ??
                i.id.slice(0, 8),
              variant: i.stockUnit?.variantLabel ?? null,
              size: i.stockUnit?.variantLabel ?? null,
              title: i.product?.name ?? i.description ?? 'Rental Item',
              productId: i.product?.id ?? null,
              quantity: remainingQty,
            };
          });

        const totalDamageFees = o.items.reduce((sum, i) => {
          if (!i.stockUnitId) return sum;
          return sum + (damageMap.get(i.stockUnitId) ?? 0);
        }, 0);

        const returnDueDate = o.rentalExt?.returnDueDate ? new Date(o.rentalExt.returnDueDate) : null;
        let overdueDays = 0;
        let overdueFee = 0;
        if (returnDueDate && new Date() > returnDueDate) {
          const diffMs = new Date().getTime() - returnDueDate.getTime();
          overdueDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
          const dailyRate = Math.max(10, Math.round(totalAmount * 0.05));
          overdueFee = overdueDays * dailyRate;
        }
        const suggestedRefund = Math.max(0, heldDeposit - overdueFee - totalDamageFees);

        return {
          id: o.id,
          orderNumber: o.orderNumber,
          lifecycle: o.rentalExt?.lifecycle ?? null,
          customerName: o.customer?.fullName ?? 'Walk-in',
          customerPhone: o.customer?.phone ?? null,
          pickupDate: o.rentalExt?.pickupDate ?? null,
          returnDueDate: o.rentalExt?.returnDueDate ?? null,
          totalAmount,
          paidAmount,
          balanceDue,
          heldDeposit,
          overdueDays,
          overdueFee,
          totalDamageFees,
          suggestedRefund,
          unitsOut,
          isSettled,
        };
      })
      .filter((o) => o.unitsOut.length > 0 || (!o.isSettled && o.heldDeposit > 0)),
    };
  }

  async list(user: AuthUser, query: ListReturnsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const where = {
      tenantId: user.tenantId,
      ...(query.orderId ? { orderId: query.orderId } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.returnEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          stockUnit: {
            select: {
              id: true,
              barcodeSku: true,
              variantLabel: true,
              status: true,
            },
          },
          order: {
            select: {
              id: true,
              orderNumber: true,
              rentalExt: { select: { lifecycle: true } },
            },
          },
        },
      }),
      this.prisma.returnEvent.count({ where }),
    ]);

    const unitIds = rows
      .map((r) => r.stockUnitId)
      .filter((id): id is string => Boolean(id));
    const [jobs, damages] = await Promise.all([
      unitIds.length
        ? this.prisma.modRentalCleaningJob.findMany({
            where: {
              tenantId: user.tenantId,
              stockUnitId: { in: unitIds },
              status: { in: ['queued', 'in_progress', 'done'] },
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve(
            [] as Awaited<
              ReturnType<typeof this.prisma.modRentalCleaningJob.findMany>
            >,
          ),
      unitIds.length
        ? this.prisma.modRentalDamageRecord.findMany({
            where: {
              tenantId: user.tenantId,
              stockUnitId: { in: unitIds },
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve(
            [] as Awaited<
              ReturnType<typeof this.prisma.modRentalDamageRecord.findMany>
            >,
          ),
    ]);

    const items = rows.map((r) => {
      const unitJobs = jobs.filter((j) => j.stockUnitId === r.stockUnitId);
      const openJob = unitJobs.find(
        (j) => j.status === 'queued' || j.status === 'in_progress',
      );
      const doneJob = unitJobs.find((j) => j.status === 'done');
      const damage = damages.find((d) => d.stockUnitId === r.stockUnitId);
      let inspectStatus: string | null = null;
      if (damage) inspectStatus = 'damaged';
      else if (openJob) inspectStatus = 'needs_cleaning';
      else if (r.approvedById || doneJob) inspectStatus = 'clean_ready';

      const stockUnit = r.stockUnit
        ? {
            id: r.stockUnit.id,
            barcodeSku: r.stockUnit.barcodeSku,
            variant: r.stockUnit.variantLabel,
            size: r.stockUnit.variantLabel,
            status: r.stockUnit.status,
          }
        : null;

      return {
        id: r.id,
        orderId: r.orderId,
        stockUnitId: r.stockUnitId,
        notes: r.notes,
        inspectNotes: r.notes,
        createdAt: r.createdAt,
        cleaningRequired: Boolean(openJob) || r.stockUnit?.status === 'cleaning',
        cleaningCompletedAt: doneJob ? doneJob.updatedAt ?? doneJob.createdAt : null,
        inspectStatus,
        order: r.order,
        stockUnit,
        /** Legacy FE alias */
        inventoryUnit: stockUnit,
      };
    });

    return { items, meta: pageMeta(total, page, limit) };
  }

  async getById(user: AuthUser, id: string) {
    const row = await this.prisma.returnEvent.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        stockUnit: true,
        order: { include: { rentalExt: true } },
      },
    });
    if (!row) throw new NotFoundException('Return not found');
    return row;
  }

  async inspect(user: AuthUser, id: string, dto: InspectReturnDto) {
    const row = await this.getById(user, id);
    if (!row.stockUnitId) {
      throw new BadRequestException('Return has no stock unit');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.returnEvent.update({
        where: { id },
        data: {
          notes: dto.inspectNotes ?? row.notes,
          approvedById: user.userId,
        },
      });

      if (dto.inspectStatus === 'damaged' && row.stockUnitId) {
        await tx.modRentalDamageRecord.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId: row.stockUnitId,
            inspectStatus: 'damaged',
            notes: dto.inspectNotes,
            chargeAmount: dto.damage?.feeAmount,
          },
        });
        await tx.stockUnit.update({
          where: { id: row.stockUnitId },
          data: { status: StockUnitStatus.repair, condition: 'damaged' },
        });
      } else if (row.stockUnitId) {
        if (dto.inspectStatus === 'needs_cleaning') {
          await tx.modRentalCleaningJob.create({
            data: {
              tenantId: user.tenantId,
              stockUnitId: row.stockUnitId,
              status: 'queued',
              notes: dto.inspectNotes,
            },
          });
        }
        await tx.stockUnit.update({
          where: { id: row.stockUnitId },
          data: {
            status:
              dto.inspectStatus === 'needs_cleaning'
                ? StockUnitStatus.cleaning
                : StockUnitStatus.available,
          },
        });
      }

      if (row.order?.rentalExt) {
        const lc = row.order.rentalExt.lifecycle;
        if (
          lc === RentalOrderLifecycle.returned ||
          lc === RentalOrderLifecycle.checked_out
        ) {
          await tx.modRentalOrder.update({
            where: { orderId: row.orderId },
            data: { lifecycle: RentalOrderLifecycle.inspected },
          });
        }
      }
    });

    return this.getById(user, id);
  }

  async completeCleaning(user: AuthUser, id: string) {
    const row = await this.getById(user, id);
    if (!row.stockUnitId) {
      throw new BadRequestException('Return has no stock unit');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.modRentalCleaningJob.updateMany({
        where: {
          tenantId: user.tenantId,
          stockUnitId: row.stockUnitId!,
          status: { in: ['queued', 'in_progress'] },
        },
        data: { status: 'done' },
      });
      await tx.stockUnit.update({
        where: { id: row.stockUnitId! },
        data: { status: StockUnitStatus.available },
      });
    });
    return this.getById(user, id);
  }

  /**
   * Settle held deposits on a rental order after return/inspect.
   * refundAmount refunds to customer; remainder is treated as forfeited/captured.
   */
  async settleDeposit(
    user: AuthUser,
    orderId: string,
    dto: SettleDepositDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      select: {
        id: true,
        meta: true,
        kind: true,
        subtotal: true,
        taxTotal: true,
        discountTotal: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const meta = (order.meta ?? {}) as Record<string, unknown>;
    if (meta.depositSettledAt) {
      throw new BadRequestException('Deposit already settled on this order');
    }

    let deposits = await this.prisma.payment.findMany({
      where: {
        tenantId: user.tenantId,
        orderId,
        type: PaymentType.deposit,
        status: PaymentStatus.succeeded,
      },
      orderBy: { createdAt: 'asc' },
    });
    const isGeneralPayment = deposits.length === 0;
    if (!deposits.length) {
      deposits = await this.prisma.payment.findMany({
        where: {
          tenantId: user.tenantId,
          orderId,
          type: PaymentType.payment,
          status: PaymentStatus.succeeded,
        },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!deposits.length) {
      throw new BadRequestException('No succeeded deposit or payment records on this order');
    }

    let held = 0;
    for (const d of deposits) {
      const already = await this.prisma.payment.aggregate({
        where: {
          tenantId: user.tenantId,
          orderId,
          status: PaymentStatus.succeeded,
          type: { in: [PaymentType.deposit_refund, PaymentType.refund] },
          gatewayPayload: {
            path: ['parentPaymentId'],
            equals: d.id,
          },
        },
        _sum: { amount: true },
      });
      held += Number(d.amount) - Number(already._sum.amount ?? 0);
    }

    const rentAmount =
      Number(order.subtotal ?? 0) +
      Number(order.taxTotal ?? 0) -
      Number(order.discountTotal ?? 0);
    const allSucceeded = await this.prisma.payment.findMany({
      where: {
        tenantId: user.tenantId,
        orderId,
        status: PaymentStatus.succeeded,
      },
    });
    let totalCustomerPaid = 0;
    let totalRefunded = 0;
    for (const p of allSucceeded) {
      const amt = Number(p.amount ?? 0);
      if (p.type === PaymentType.deposit_refund || p.type === PaymentType.refund) {
        totalRefunded += amt;
      } else {
        totalCustomerPaid += amt;
      }
    }
    const refundableDeposit = Math.max(0, totalCustomerPaid - rentAmount - totalRefunded);
    held = Math.min(held, refundableDeposit);
    held = Math.round(held * 100) / 100;

    if (dto.refundAmount > held + 1e-9) {
      throw new BadRequestException(
        `Refund ${dto.refundAmount} exceeds held deposit ${held.toFixed(2)}`,
      );
    }

    const refunds = [];
    let remaining = dto.refundAmount;
    for (const d of deposits) {
      if (remaining <= 1e-9) break;
      const already = await this.prisma.payment.aggregate({
        where: {
          tenantId: user.tenantId,
          orderId,
          status: PaymentStatus.succeeded,
          type: PaymentType.deposit_refund,
          gatewayPayload: {
            path: ['parentPaymentId'],
            equals: d.id,
          },
        },
        _sum: { amount: true },
      });
      const refundable =
        Number(d.amount) - Number(already._sum.amount ?? 0);
      if (refundable <= 1e-9) continue;
      const chunk = Math.min(remaining, refundable);
      const key =
        remaining === dto.refundAmount
          ? dto.idempotencyKey
          : `${dto.idempotencyKey}:${d.id}`;
      const refund = await this.paymentsService.refund(user, d.id, {
        amount: chunk,
        idempotencyKey: key,
        reason: dto.reason ?? 'Deposit settlement refund',
      });
      refunds.push(refund);
      remaining = Math.round((remaining - chunk) * 100) / 100;
    }

    const forfeited = Math.round((held - dto.refundAmount) * 100) / 100;
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        meta: {
          ...meta,
          depositSettledAt: new Date().toISOString(),
          depositRefunded: dto.refundAmount,
          depositForfeited: forfeited,
          depositSettleReason: dto.reason ?? null,
          depositSettledBy: user.userId,
        },
      },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        action: 'rental.deposit_settled',
        entityType: 'order',
        entityId: orderId,
        beforeAfter: {
          held,
          refunded: dto.refundAmount,
          forfeited,
        },
      },
    });

    return {
      orderId,
      held,
      refunded: dto.refundAmount,
      forfeited,
      refunds,
    };
  }
}
