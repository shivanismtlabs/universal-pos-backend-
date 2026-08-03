import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AvailabilityStatus,
  FeeType,
  InspectStatus,
  OrderItemType,
  OrderStatus,
  Prisma,
  ReservationStatus,
} from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from '../payments/payments.service';
import {
  CreateReturnDto,
  InspectReturnDto,
  ListReturnsQueryDto,
} from './dto/returns.dto';

type PrismaTx = Prisma.TransactionClient;

const RETURNABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.checked_out,
  OrderStatus.returned,
];

const RETURN_DETAIL_INCLUDE = {
  damageRecords: { orderBy: { createdAt: 'desc' as const } },
  cleaningJobs: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.ReturnEventInclude;

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async create(user: AuthUser, dto: CreateReturnDto) {
    const order = await this.prisma.rentalOrder.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (!RETURNABLE_ORDER_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        `Order must be checked_out or returned to record a return (current status: ${order.status})`,
      );
    }

    const orderItem = await this.prisma.orderItem.findFirst({
      where: {
        orderId: dto.orderId,
        tenantId: user.tenantId,
        inventoryUnitId: dto.inventoryUnitId,
        itemType: OrderItemType.rental_unit,
      },
    });
    if (!orderItem) {
      throw new BadRequestException(
        'Inventory unit is not a rental item on this order',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const returnEvent = await tx.returnEvent.create({
        data: {
          tenantId: user.tenantId,
          orderId: dto.orderId,
          inventoryUnitId: dto.inventoryUnitId,
          receivedById: user.userId,
          cleaningRequired: dto.cleaningRequired ?? false,
          inspectNotes: dto.inspectNotes,
          inspectStatus: dto.cleaningRequired
            ? InspectStatus.needs_cleaning
            : null,
        },
      });

      if (order.status === OrderStatus.checked_out) {
        await tx.rentalOrder.update({
          where: { id: order.id },
          data: { status: OrderStatus.returned },
        });
      }

      return returnEvent;
    });
  }

  async list(user: AuthUser, query: ListReturnsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);

    const where: Prisma.ReturnEventWhereInput = {
      tenantId: user.tenantId,
      ...(query.orderId ? { orderId: query.orderId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.returnEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { returnedAt: 'desc' },
        include: {
          inventoryUnit: {
            select: { id: true, barcodeSku: true, size: true },
          },
        },
      }),
      this.prisma.returnEvent.count({ where }),
    ]);

    return { items, meta: pageMeta(total, page, limit) };
  }

  async getById(user: AuthUser, id: string) {
    const returnEvent = await this.prisma.returnEvent.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        ...RETURN_DETAIL_INCLUDE,
        inventoryUnit: {
          select: {
            id: true,
            barcodeSku: true,
            size: true,
            availabilityStatus: true,
          },
        },
        order: { select: { id: true, orderNumber: true, status: true } },
      },
    });
    if (!returnEvent) {
      throw new NotFoundException('Return event not found');
    }
    return returnEvent;
  }

  async inspect(user: AuthUser, id: string, dto: InspectReturnDto) {
    const returnEvent = await this.prisma.returnEvent.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!returnEvent) {
      throw new NotFoundException('Return event not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.returnEvent.update({
        where: { id },
        data: {
          inspectStatus: dto.inspectStatus,
          inspectNotes: dto.inspectNotes ?? returnEvent.inspectNotes,
          inspectedAt: new Date(),
          approvedById: user.userId,
        },
      });

      if (dto.inspectStatus === InspectStatus.damaged) {
        await this.handleDamaged(tx, user, returnEvent, dto);
      } else if (dto.inspectStatus === InspectStatus.needs_cleaning) {
        await this.handleNeedsCleaning(tx, user, returnEvent);
      } else if (dto.inspectStatus === InspectStatus.clean_ready) {
        await this.handleCleanReady(tx, user, returnEvent);
      }

      await this.maybeMarkOrderInspected(
        tx,
        user.tenantId,
        returnEvent.orderId,
      );
    });

    return this.getById(user, id);
  }

  async completeCleaning(user: AuthUser, id: string) {
    const returnEvent = await this.prisma.returnEvent.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { cleaningJobs: true },
    });
    if (!returnEvent) {
      throw new NotFoundException('Return event not found');
    }

    const openJob = returnEvent.cleaningJobs.find((j) => j.status === 'open');
    if (!openJob) {
      throw new BadRequestException('No open cleaning job for this return');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.cleaningJob.update({
        where: { id: openJob.id },
        data: { status: 'completed' },
      });

      const unit = await tx.inventoryUnit.findFirst({
        where: { id: returnEvent.inventoryUnitId, tenantId: user.tenantId },
      });
      if (unit) {
        await tx.inventoryUnit.update({
          where: { id: unit.id },
          data: { availabilityStatus: AvailabilityStatus.AVAILABLE },
        });
        await tx.inventoryMovement.create({
          data: {
            tenantId: user.tenantId,
            inventoryUnitId: unit.id,
            fromAvailability: unit.availabilityStatus,
            toAvailability: AvailabilityStatus.AVAILABLE,
            reason: 'cleaning.completed',
            orderId: returnEvent.orderId,
            actorUserId: user.userId,
          },
        });
      }

      await tx.unitReservation.updateMany({
        where: {
          tenantId: user.tenantId,
          inventoryUnitId: returnEvent.inventoryUnitId,
          status: ReservationStatus.checked_out,
        },
        data: { status: ReservationStatus.released },
      });
    });

    return this.getById(user, id);
  }

  // ─── inspect helpers ─────────────────────────────────────────────────────

  private async handleDamaged(
    tx: PrismaTx,
    user: AuthUser,
    returnEvent: { id: string; orderId: string; inventoryUnitId: string },
    dto: InspectReturnDto,
  ) {
    const feeAmount = dto.damage?.feeAmount ?? 0;

    await tx.damageRecord.create({
      data: {
        tenantId: user.tenantId,
        returnEventId: returnEvent.id,
        inventoryUnitId: returnEvent.inventoryUnitId,
        notes: dto.damage?.notes,
        feeAmount: feeAmount.toFixed(2),
      },
    });

    if (feeAmount > 0) {
      await tx.orderFee.create({
        data: {
          tenantId: user.tenantId,
          orderId: returnEvent.orderId,
          inventoryUnitId: returnEvent.inventoryUnitId,
          feeType: FeeType.damage,
          amount: feeAmount.toFixed(2),
          reason: dto.damage?.notes,
        },
      });
      await this.paymentsService.recalculateBalance(
        tx,
        user.tenantId,
        returnEvent.orderId,
      );
    }

    const unit = await tx.inventoryUnit.findFirst({
      where: { id: returnEvent.inventoryUnitId, tenantId: user.tenantId },
    });
    if (unit && unit.availabilityStatus !== AvailabilityStatus.REPAIR) {
      await tx.inventoryUnit.update({
        where: { id: unit.id },
        data: { availabilityStatus: AvailabilityStatus.REPAIR },
      });
      await tx.inventoryMovement.create({
        data: {
          tenantId: user.tenantId,
          inventoryUnitId: unit.id,
          fromAvailability: unit.availabilityStatus,
          toAvailability: AvailabilityStatus.REPAIR,
          reason: 'return.damaged',
          orderId: returnEvent.orderId,
          actorUserId: user.userId,
        },
      });
    }
  }

  private async handleNeedsCleaning(
    tx: PrismaTx,
    user: AuthUser,
    returnEvent: { id: string; orderId: string; inventoryUnitId: string },
  ) {
    await tx.cleaningJob.create({
      data: {
        tenantId: user.tenantId,
        inventoryUnitId: returnEvent.inventoryUnitId,
        returnEventId: returnEvent.id,
        status: 'open',
      },
    });

    const unit = await tx.inventoryUnit.findFirst({
      where: { id: returnEvent.inventoryUnitId, tenantId: user.tenantId },
    });
    if (unit) {
      await tx.inventoryUnit.update({
        where: { id: unit.id },
        data: { availabilityStatus: AvailabilityStatus.CLEANING },
      });
      await tx.inventoryMovement.create({
        data: {
          tenantId: user.tenantId,
          inventoryUnitId: unit.id,
          fromAvailability: unit.availabilityStatus,
          toAvailability: AvailabilityStatus.CLEANING,
          reason: 'return.needs_cleaning',
          orderId: returnEvent.orderId,
          actorUserId: user.userId,
        },
      });
    }
  }

  private async handleCleanReady(
    tx: PrismaTx,
    user: AuthUser,
    returnEvent: { id: string; orderId: string; inventoryUnitId: string },
  ) {
    const unit = await tx.inventoryUnit.findFirst({
      where: { id: returnEvent.inventoryUnitId, tenantId: user.tenantId },
    });
    if (unit) {
      await tx.inventoryUnit.update({
        where: { id: unit.id },
        data: { availabilityStatus: AvailabilityStatus.AVAILABLE },
      });
      await tx.inventoryMovement.create({
        data: {
          tenantId: user.tenantId,
          inventoryUnitId: unit.id,
          fromAvailability: unit.availabilityStatus,
          toAvailability: AvailabilityStatus.AVAILABLE,
          reason: 'return.clean_ready',
          orderId: returnEvent.orderId,
          actorUserId: user.userId,
        },
      });
    }

    await tx.unitReservation.updateMany({
      where: {
        tenantId: user.tenantId,
        inventoryUnitId: returnEvent.inventoryUnitId,
        status: ReservationStatus.checked_out,
      },
      data: { status: ReservationStatus.released },
    });
  }

  /** Best-effort: once every rental unit on the order has an inspected return, mark order inspected */
  private async maybeMarkOrderInspected(
    tx: PrismaTx,
    tenantId: string,
    orderId: string,
  ) {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, tenantId },
      select: { status: true },
    });
    if (!order || order.status !== OrderStatus.returned) {
      return;
    }

    const rentalItems = await tx.orderItem.findMany({
      where: { orderId, tenantId, itemType: OrderItemType.rental_unit },
      select: { inventoryUnitId: true },
    });
    const unitIds = rentalItems
      .map((item) => item.inventoryUnitId)
      .filter((v): v is string => !!v);
    if (unitIds.length === 0) {
      return;
    }

    const returnEvents = await tx.returnEvent.findMany({
      where: { orderId, tenantId, inventoryUnitId: { in: unitIds } },
      select: { inventoryUnitId: true, inspectedAt: true },
    });

    const inspectedUnitIds = new Set(
      returnEvents.filter((r) => r.inspectedAt).map((r) => r.inventoryUnitId),
    );

    const allInspected = unitIds.every((unitId) =>
      inspectedUnitIds.has(unitId),
    );
    if (allInspected) {
      await tx.rentalOrder.update({
        where: { id: orderId },
        data: { status: OrderStatus.inspected },
      });
    }
  }
}
