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
      order.rentalExt?.lifecycle === RentalOrderLifecycle.returned;
    const coreOk =
      order.status === OrderStatus.fulfilled ||
      order.status === OrderStatus.ready ||
      order.status === OrderStatus.closed;
    if (!rentalOk && !coreOk) {
      throw new BadRequestException(
        `Order status ${order.status} / lifecycle ${order.rentalExt?.lifecycle ?? 'n/a'} is not returnable yet`,
      );
    }

    const item = await this.prisma.orderItem.findFirst({
      where: {
        orderId: dto.orderId,
        tenantId: user.tenantId,
        stockUnitId: unitId,
      },
    });
    if (!item) {
      throw new BadRequestException('Stock unit is not on this order');
    }

    const already = await this.prisma.returnEvent.findFirst({
      where: {
        tenantId: user.tenantId,
        orderId: dto.orderId,
        stockUnitId: unitId,
      },
    });
    if (already) {
      throw new BadRequestException('This unit was already returned on this order');
    }

    const event = await this.prisma.$transaction(async (tx) => {
      const returnEvent = await tx.returnEvent.create({
        data: {
          tenantId: user.tenantId,
          orderId: dto.orderId,
          stockUnitId: unitId,
          receivedById: user.userId,
          notes: dto.inspectNotes,
        },
      });

      await tx.stockReservation.updateMany({
        where: {
          tenantId: user.tenantId,
          orderItemId: item.id,
          status: ReservationStatus.checked_out,
        },
        data: { status: ReservationStatus.released },
      });

      await tx.stockUnit.update({
        where: { id: unitId },
        data: {
          status: dto.cleaningRequired
            ? StockUnitStatus.cleaning
            : StockUnitStatus.available,
        },
      });

      await tx.stockMovement.create({
        data: {
          tenantId: user.tenantId,
          stockUnitId: unitId,
          fromStatus: StockUnitStatus.checked_out,
          toStatus: dto.cleaningRequired
            ? StockUnitStatus.cleaning
            : StockUnitStatus.available,
          reason: 'rental.returned',
          actorUserId: user.userId,
          orderId: dto.orderId,
        },
      });

      if (dto.cleaningRequired) {
        await tx.modRentalCleaningJob.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId: unitId,
            status: 'queued',
            notes: dto.inspectNotes,
          },
        });
      }

      // Only mark order returned when every unit line has a return event
      if (
        order.rentalExt &&
        order.rentalExt.lifecycle === RentalOrderLifecycle.checked_out
      ) {
        const unitLines = await tx.orderItem.findMany({
          where: {
            orderId: dto.orderId,
            tenantId: user.tenantId,
            stockUnitId: { not: null },
          },
          select: { stockUnitId: true },
        });
        const returned = await tx.returnEvent.findMany({
          where: { orderId: dto.orderId, tenantId: user.tenantId },
          select: { stockUnitId: true },
        });
        const returnedSet = new Set(
          returned.map((r) => r.stockUnitId).filter(Boolean),
        );
        const allBack = unitLines.every(
          (l) => l.stockUnitId && returnedSet.has(l.stockUnitId),
        );
        if (allBack) {
          await tx.modRentalOrder.update({
            where: { orderId: dto.orderId },
            data: { lifecycle: RentalOrderLifecycle.returned },
          });
        }
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
        kind: OrderKind.rental,
        rentalExt: {
          lifecycle: {
            in: [
              RentalOrderLifecycle.checked_out,
              RentalOrderLifecycle.returned,
            ],
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
      include: {
        customer: { select: { id: true, fullName: true, phone: true } },
        rentalExt: {
          select: {
            lifecycle: true,
            pickupDate: true,
            returnDueDate: true,
          },
        },
        items: {
          where: { stockUnitId: { not: null } },
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
        returnEvents: { select: { stockUnitId: true } },
      },
    });

    return {
      items: orders
        .map((o) => {
          const returnedIds = new Set(
            o.returnEvents.map((r) => r.stockUnitId).filter(Boolean),
          );
          const unitsOut = o.items
            .filter(
              (i) =>
                i.stockUnitId &&
                !returnedIds.has(i.stockUnitId) &&
                i.stockUnit?.status === StockUnitStatus.checked_out,
            )
            .map((i) => ({
              stockUnitId: i.stockUnitId!,
              barcode: i.stockUnit!.barcodeSku,
              barcodeSku: i.stockUnit!.barcodeSku,
              variant: i.stockUnit!.variantLabel,
              size: i.stockUnit!.variantLabel,
              title: i.product?.name ?? i.description,
              productId: i.product?.id ?? null,
            }));
          return {
            id: o.id,
            orderNumber: o.orderNumber,
            lifecycle: o.rentalExt?.lifecycle ?? null,
            customerName: o.customer?.fullName ?? 'Walk-in',
            customerPhone: o.customer?.phone ?? null,
            pickupDate: o.rentalExt?.pickupDate ?? null,
            returnDueDate: o.rentalExt?.returnDueDate ?? null,
            unitsOut,
          };
        })
        .filter((o) => o.unitsOut.length > 0),
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
      select: { id: true, meta: true, kind: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const meta = (order.meta ?? {}) as Record<string, unknown>;
    if (meta.depositSettledAt) {
      throw new BadRequestException('Deposit already settled on this order');
    }

    const deposits = await this.prisma.payment.findMany({
      where: {
        tenantId: user.tenantId,
        orderId,
        type: PaymentType.deposit,
        status: PaymentStatus.succeeded,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!deposits.length) {
      throw new BadRequestException('No succeeded deposit payments on this order');
    }

    let held = 0;
    for (const d of deposits) {
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
      held += Number(d.amount) - Number(already._sum.amount ?? 0);
    }
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
