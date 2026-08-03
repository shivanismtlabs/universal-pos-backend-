import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AvailabilityStatus,
  OrderItem,
  OrderItemType,
  OrderStatus,
  PaymentType,
  Prisma,
  RentalOrder,
  ReservationStatus,
} from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateOrderDto,
  CreateOrderItemDto,
  ListOrdersQueryDto,
  UpdateOrderDto,
  UpdateOrderStatusDto,
} from './dto/orders.dto';

type PrismaTx = Prisma.TransactionClient;

const ACTIVE_RESERVATIONS: ReservationStatus[] = [
  ReservationStatus.held,
  ReservationStatus.checked_out,
];

/** Statuses in which order-level fields (dates, party) may still change */
const ORDER_EDITABLE_STATUSES: OrderStatus[] = [
  OrderStatus.quote,
  OrderStatus.reserved,
  OrderStatus.fitted,
];

/** Statuses in which line items may still be added/removed */
const ITEMS_MUTABLE_STATUSES: OrderStatus[] = [
  OrderStatus.quote,
  OrderStatus.reserved,
];

const STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  quote: [OrderStatus.reserved, OrderStatus.cancelled],
  reserved: [OrderStatus.fitted, OrderStatus.ready, OrderStatus.cancelled],
  fitted: [OrderStatus.ready, OrderStatus.cancelled],
  ready: [OrderStatus.checked_out, OrderStatus.cancelled],
  checked_out: [OrderStatus.returned],
  returned: [OrderStatus.inspected],
  inspected: [OrderStatus.closed],
  closed: [],
  cancelled: [],
};

const CREDIT_PAYMENT_TYPES: PaymentType[] = [
  PaymentType.payment,
  PaymentType.deposit,
];
const REFUND_PAYMENT_TYPES: PaymentType[] = [
  PaymentType.refund,
  PaymentType.deposit_refund,
];

const ORDER_DETAIL_INCLUDE = {
  items: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      inventoryUnit: {
        select: {
          id: true,
          barcodeSku: true,
          size: true,
          rentalPrice: true,
          depositAmount: true,
          availabilityStatus: true,
        },
      },
      retailSku: {
        select: { id: true, sku: true, sellPrice: true },
      },
      wearer: { select: { id: true, fullName: true, phone: true } },
    },
  },
  payments: {
    orderBy: { createdAt: 'asc' as const },
    select: {
      id: true,
      amount: true,
      status: true,
      type: true,
      method: true,
    },
  },
  fees: { orderBy: { createdAt: 'asc' as const } },
  customer: { select: { id: true, fullName: true, phone: true } },
} satisfies Prisma.RentalOrderInclude;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Create ──────────────────────────────────────────────────────────────

  async create(user: AuthUser, dto: CreateOrderDto) {
    await this.assertStore(user.tenantId, dto.storeId);
    await this.assertCustomer(user.tenantId, dto.customerId);
    if (dto.partyId) {
      await this.assertParty(user.tenantId, dto.partyId);
    }

    const orderId = await this.prisma.$transaction(async (tx) => {
      const orderNumber = await this.generateOrderNumber(tx, user.tenantId);

      const order = await tx.rentalOrder.create({
        data: {
          tenantId: user.tenantId,
          storeId: dto.storeId,
          customerId: dto.customerId,
          partyId: dto.partyId,
          orderNumber,
          eventDate: dto.eventDate ? new Date(dto.eventDate) : null,
          pickupDate: dto.pickupDate ? new Date(dto.pickupDate) : null,
          returnDueDate: dto.returnDueDate ? new Date(dto.returnDueDate) : null,
          createdById: user.userId,
        },
      });

      if (dto.items?.length) {
        for (const item of dto.items) {
          await this.createItem(tx, user, order.id, item);
        }
      }

      await this.recalcTotals(tx, user.tenantId, order.id);

      return order.id;
    });

    return this.getById(user, orderId);
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  async list(user: AuthUser, query: ListOrdersQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const q = query.q?.trim();

    const where: Prisma.RentalOrderWhereInput = {
      tenantId: user.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(q ? { orderNumber: { contains: q, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.rentalOrder.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          eventDate: true,
          pickupDate: true,
          returnDueDate: true,
          subtotal: true,
          taxTotal: true,
          depositTotal: true,
          balanceDue: true,
          storeId: true,
          customerId: true,
          partyId: true,
          createdAt: true,
          customer: { select: { id: true, fullName: true, phone: true } },
        },
      }),
      this.prisma.rentalOrder.count({ where }),
    ]);

    return { items, meta: pageMeta(total, page, limit) };
  }

  async getById(user: AuthUser, id: string) {
    const order = await this.prisma.rentalOrder.findFirst({
      where: { id, tenantId: user.tenantId },
      include: ORDER_DETAIL_INCLUDE,
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  // ─── Update ──────────────────────────────────────────────────────────────

  async update(user: AuthUser, id: string, dto: UpdateOrderDto) {
    const order = await this.getOrderOrThrow(user, id);

    const data: Prisma.RentalOrderUncheckedUpdateInput = {};

    if (dto.partyId !== undefined) {
      if (!ORDER_EDITABLE_STATUSES.includes(order.status)) {
        throw new BadRequestException(
          `Cannot change party while order status is ${order.status}`,
        );
      }
      if (dto.partyId) {
        await this.assertParty(user.tenantId, dto.partyId);
      }
      data.partyId = dto.partyId ?? null;
    }
    if (dto.eventDate !== undefined) {
      data.eventDate = dto.eventDate ? new Date(dto.eventDate) : null;
    }
    if (dto.pickupDate !== undefined) {
      data.pickupDate = dto.pickupDate ? new Date(dto.pickupDate) : null;
    }
    if (dto.returnDueDate !== undefined) {
      data.returnDueDate = dto.returnDueDate
        ? new Date(dto.returnDueDate)
        : null;
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.rentalOrder.update({ where: { id }, data });
    }

    return this.getById(user, id);
  }

  // ─── Items ───────────────────────────────────────────────────────────────

  async addItem(user: AuthUser, orderId: string, dto: CreateOrderItemDto) {
    const order = await this.getOrderOrThrow(user, orderId);
    if (!ITEMS_MUTABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        `Cannot add items while order status is ${order.status}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.createItem(tx, user, orderId, dto);
      await this.recalcTotals(tx, user.tenantId, orderId);
    });

    return this.getById(user, orderId);
  }

  async removeItem(user: AuthUser, orderId: string, itemId: string) {
    const order = await this.getOrderOrThrow(user, orderId);
    if (!ITEMS_MUTABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        `Cannot remove items while order status is ${order.status}`,
      );
    }

    const item = await this.prisma.orderItem.findFirst({
      where: { id: itemId, orderId, tenantId: user.tenantId },
    });
    if (!item) {
      throw new NotFoundException('Order item not found');
    }

    await this.prisma.$transaction(async (tx) => {
      const reservations = await tx.unitReservation.findMany({
        where: {
          tenantId: user.tenantId,
          orderItemId: itemId,
          status: { in: ACTIVE_RESERVATIONS },
        },
      });

      for (const reservation of reservations) {
        await tx.unitReservation.update({
          where: { id: reservation.id },
          data: { status: ReservationStatus.cancelled },
        });
        await this.releaseUnitIfFree(
          tx,
          user,
          reservation.inventoryUnitId,
          orderId,
        );
      }

      if (item.itemType === OrderItemType.retail && item.retailSkuId) {
        await tx.retailSku.update({
          where: { id: item.retailSkuId },
          data: { qtyOnHand: { increment: 1 } },
        });
      }

      await tx.orderItem.delete({ where: { id: itemId } });
      await this.recalcTotals(tx, user.tenantId, orderId);
    });

    return this.getById(user, orderId);
  }

  // ─── Status lifecycle ───────────────────────────────────────────────────

  async changeStatus(
    user: AuthUser,
    orderId: string,
    dto: UpdateOrderStatusDto,
  ) {
    const order = await this.prisma.rentalOrder.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.status === dto.status) {
      throw new BadRequestException(`Order is already ${dto.status}`);
    }

    const allowed = STATUS_TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Cannot transition order from ${order.status} to ${dto.status}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (dto.status === OrderStatus.reserved) {
        await this.handleReserveTransition(tx, user, order);
      } else if (dto.status === OrderStatus.checked_out) {
        await this.handleCheckoutTransition(tx, user, order);
      } else if (dto.status === OrderStatus.cancelled) {
        await this.handleCancelTransition(tx, user, order);
      }

      await tx.rentalOrder.update({
        where: { id: orderId },
        data: { status: dto.status },
      });
      await this.recalcTotals(tx, user.tenantId, orderId);
    });

    return this.getById(user, orderId);
  }

  private async handleReserveTransition(
    tx: PrismaTx,
    user: AuthUser,
    order: RentalOrder & { items: OrderItem[] },
  ) {
    if (!order.pickupDate || !order.returnDueDate) {
      throw new BadRequestException(
        'pickupDate and returnDueDate are required before reserving',
      );
    }

    const rentalItems = order.items.filter(
      (item) =>
        item.itemType === OrderItemType.rental_unit && item.inventoryUnitId,
    );

    for (const item of rentalItems) {
      const existing = await tx.unitReservation.findFirst({
        where: {
          tenantId: user.tenantId,
          orderItemId: item.id,
          status: { in: ACTIVE_RESERVATIONS },
        },
      });
      if (existing) continue;

      const unit = await tx.inventoryUnit.findFirst({
        where: { id: item.inventoryUnitId!, tenantId: user.tenantId },
      });
      if (!unit) {
        throw new NotFoundException(
          `Inventory unit not found for item ${item.id}`,
        );
      }

      const overlap = await tx.unitReservation.findFirst({
        where: {
          inventoryUnitId: unit.id,
          tenantId: user.tenantId,
          status: { in: ACTIVE_RESERVATIONS },
          startDate: { lte: order.returnDueDate },
          endDate: { gte: order.pickupDate },
        },
      });
      if (overlap) {
        throw new ConflictException(
          `Unit ${unit.barcodeSku} already reserved for overlapping dates`,
        );
      }

      await tx.unitReservation.create({
        data: {
          tenantId: user.tenantId,
          inventoryUnitId: unit.id,
          orderItemId: item.id,
          startDate: order.pickupDate,
          endDate: order.returnDueDate,
          status: ReservationStatus.held,
        },
      });

      if (unit.availabilityStatus === AvailabilityStatus.AVAILABLE) {
        await tx.inventoryUnit.update({
          where: { id: unit.id },
          data: { availabilityStatus: AvailabilityStatus.RESERVED },
        });
        await tx.inventoryMovement.create({
          data: {
            tenantId: user.tenantId,
            inventoryUnitId: unit.id,
            fromAvailability: unit.availabilityStatus,
            toAvailability: AvailabilityStatus.RESERVED,
            reason: 'order.reserved',
            orderId: order.id,
            actorUserId: user.userId,
          },
        });
      }
    }
  }

  private async handleCheckoutTransition(
    tx: PrismaTx,
    user: AuthUser,
    order: RentalOrder,
  ) {
    const reservations = await tx.unitReservation.findMany({
      where: {
        tenantId: user.tenantId,
        status: ReservationStatus.held,
        orderItem: { orderId: order.id },
      },
    });

    for (const reservation of reservations) {
      await tx.unitReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.checked_out },
      });

      const unit = await tx.inventoryUnit.findFirst({
        where: { id: reservation.inventoryUnitId, tenantId: user.tenantId },
      });
      if (unit && unit.availabilityStatus !== AvailabilityStatus.CHECKED_OUT) {
        await tx.inventoryUnit.update({
          where: { id: unit.id },
          data: { availabilityStatus: AvailabilityStatus.CHECKED_OUT },
        });
        await tx.inventoryMovement.create({
          data: {
            tenantId: user.tenantId,
            inventoryUnitId: unit.id,
            fromAvailability: unit.availabilityStatus,
            toAvailability: AvailabilityStatus.CHECKED_OUT,
            reason: 'order.checked_out',
            orderId: order.id,
            actorUserId: user.userId,
          },
        });
      }
    }
  }

  private async handleCancelTransition(
    tx: PrismaTx,
    user: AuthUser,
    order: RentalOrder,
  ) {
    const reservations = await tx.unitReservation.findMany({
      where: {
        tenantId: user.tenantId,
        status: ReservationStatus.held,
        orderItem: { orderId: order.id },
      },
    });

    for (const reservation of reservations) {
      await tx.unitReservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.cancelled },
      });
      await this.releaseUnitIfFree(
        tx,
        user,
        reservation.inventoryUnitId,
        order.id,
      );
    }
  }

  // ─── Totals ──────────────────────────────────────────────────────────────

  private async recalcTotals(tx: PrismaTx, tenantId: string, orderId: string) {
    const order = await tx.rentalOrder.findFirst({
      where: { id: orderId, tenantId },
      select: { depositTotal: true },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const items = await tx.orderItem.findMany({
      where: { tenantId, orderId },
      include: { inventoryUnit: { select: { depositAmount: true } } },
    });

    let subtotal = new Prisma.Decimal(0);
    let taxTotal = new Prisma.Decimal(0);
    const rentalDeposits: Prisma.Decimal[] = [];

    for (const item of items) {
      subtotal = subtotal.plus(item.unitPrice).minus(item.discount);
      taxTotal = taxTotal.plus(item.taxAmount);
      if (item.itemType === OrderItemType.rental_unit && item.inventoryUnit) {
        rentalDeposits.push(item.inventoryUnit.depositAmount);
      }
    }

    const depositTotal = rentalDeposits.length
      ? rentalDeposits.reduce(
          (sum, deposit) => sum.plus(deposit),
          new Prisma.Decimal(0),
        )
      : order.depositTotal;

    const [feesAgg, creditsAgg, refundsAgg] = await Promise.all([
      tx.orderFee.aggregate({
        where: { tenantId, orderId },
        _sum: { amount: true },
      }),
      tx.payment.aggregate({
        where: {
          tenantId,
          orderId,
          status: 'succeeded',
          type: { in: CREDIT_PAYMENT_TYPES },
        },
        _sum: { amount: true },
      }),
      tx.payment.aggregate({
        where: {
          tenantId,
          orderId,
          status: 'succeeded',
          type: { in: REFUND_PAYMENT_TYPES },
        },
        _sum: { amount: true },
      }),
    ]);

    const feeSum = new Prisma.Decimal(feesAgg._sum.amount ?? 0);
    const paidSucceeded = new Prisma.Decimal(creditsAgg._sum.amount ?? 0);
    const refundedSucceeded = new Prisma.Decimal(refundsAgg._sum.amount ?? 0);

    const balanceDue = subtotal
      .plus(taxTotal)
      .plus(feeSum)
      .minus(paidSucceeded)
      .plus(refundedSucceeded);

    return tx.rentalOrder.update({
      where: { id: orderId },
      data: { subtotal, taxTotal, depositTotal, balanceDue },
    });
  }

  // ─── Item helpers ────────────────────────────────────────────────────────

  private async createItem(
    tx: PrismaTx,
    user: AuthUser,
    orderId: string,
    dto: CreateOrderItemDto,
  ) {
    let unitPrice = dto.unitPrice;

    if (dto.itemType === OrderItemType.rental_unit) {
      if (!dto.inventoryUnitId) {
        throw new BadRequestException(
          'inventoryUnitId is required for rental_unit items',
        );
      }
      const unit = await tx.inventoryUnit.findFirst({
        where: { id: dto.inventoryUnitId, tenantId: user.tenantId },
        select: { id: true, rentalPrice: true },
      });
      if (!unit) {
        throw new NotFoundException('Inventory unit not found');
      }
      if (unitPrice === undefined) {
        unitPrice = Number(unit.rentalPrice);
      }
    } else if (dto.itemType === OrderItemType.retail) {
      if (!dto.retailSkuId) {
        throw new BadRequestException(
          'retailSkuId is required for retail items',
        );
      }
      const sku = await tx.retailSku.findFirst({
        where: { id: dto.retailSkuId, tenantId: user.tenantId },
        select: { id: true, sellPrice: true, qtyOnHand: true },
      });
      if (!sku) {
        throw new NotFoundException('Retail SKU not found');
      }
      if (sku.qtyOnHand < 1) {
        throw new BadRequestException('Retail SKU is out of stock');
      }
      if (unitPrice === undefined) {
        unitPrice = Number(sku.sellPrice);
      }
      await tx.retailSku.update({
        where: { id: sku.id },
        data: { qtyOnHand: { decrement: 1 } },
      });
    }

    if (dto.wearerCustomerId) {
      const wearer = await tx.customer.findFirst({
        where: {
          id: dto.wearerCustomerId,
          tenantId: user.tenantId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!wearer) {
        throw new NotFoundException('Wearer customer not found');
      }
    }

    return tx.orderItem.create({
      data: {
        tenantId: user.tenantId,
        orderId,
        itemType: dto.itemType,
        inventoryUnitId: dto.inventoryUnitId,
        retailSkuId: dto.retailSkuId,
        wearerCustomerId: dto.wearerCustomerId,
        size: dto.size?.trim(),
        unitPrice: (unitPrice ?? 0).toFixed(2),
        discount: (dto.discount ?? 0).toFixed(2),
        taxAmount: (dto.taxAmount ?? 0).toFixed(2),
        taxSplit: (dto.taxSplit ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  private async releaseUnitIfFree(
    tx: PrismaTx,
    user: AuthUser,
    inventoryUnitId: string,
    orderId: string,
  ) {
    const activeLeft = await tx.unitReservation.count({
      where: {
        tenantId: user.tenantId,
        inventoryUnitId,
        status: { in: ACTIVE_RESERVATIONS },
      },
    });
    if (activeLeft > 0) return;

    const unit = await tx.inventoryUnit.findFirst({
      where: { id: inventoryUnitId, tenantId: user.tenantId },
    });
    if (unit && unit.availabilityStatus === AvailabilityStatus.RESERVED) {
      await tx.inventoryUnit.update({
        where: { id: unit.id },
        data: { availabilityStatus: AvailabilityStatus.AVAILABLE },
      });
      await tx.inventoryMovement.create({
        data: {
          tenantId: user.tenantId,
          inventoryUnitId: unit.id,
          fromAvailability: AvailabilityStatus.RESERVED,
          toAvailability: AvailabilityStatus.AVAILABLE,
          reason: 'order.reservation_released',
          orderId,
          actorUserId: user.userId,
        },
      });
    }
  }

  private async generateOrderNumber(
    tx: PrismaTx,
    tenantId: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const random = Math.random().toString(36).slice(2, 6).toUpperCase();
      const candidate = `ORD-${Date.now().toString(36).toUpperCase()}-${random}`;
      const exists = await tx.rentalOrder.findFirst({
        where: { tenantId, orderNumber: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    throw new ConflictException(
      'Failed to generate a unique order number, please retry',
    );
  }

  // ─── Assertions ──────────────────────────────────────────────────────────

  private async getOrderOrThrow(user: AuthUser, id: string) {
    const order = await this.prisma.rentalOrder.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  private async assertStore(tenantId: string, id: string) {
    const store = await this.prisma.store.findFirst({
      where: { id, tenantId, isActive: true },
      select: { id: true },
    });
    if (!store) {
      throw new NotFoundException('Store not found or inactive');
    }
  }

  private async assertCustomer(tenantId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
  }

  private async assertParty(tenantId: string, id: string) {
    const party = await this.prisma.party.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!party) {
      throw new NotFoundException('Party not found');
    }
  }
}
