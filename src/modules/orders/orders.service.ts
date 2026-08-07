import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderItemKind,
  OrderKind,
  OrderStatus,
  Prisma,
  RentalOrderLifecycle,
  ReservationStatus,
  StockUnitStatus,
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
  UpdateRentalLifecycleDto,
} from './dto/orders.dto';

const MUTABLE: OrderStatus[] = [
  OrderStatus.draft,
  OrderStatus.quoted,
  OrderStatus.confirmed,
  OrderStatus.in_progress,
];

const TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  [OrderStatus.draft]: [OrderStatus.quoted, OrderStatus.confirmed, OrderStatus.cancelled],
  [OrderStatus.quoted]: [OrderStatus.confirmed, OrderStatus.cancelled],
  [OrderStatus.confirmed]: [OrderStatus.in_progress, OrderStatus.ready, OrderStatus.cancelled],
  [OrderStatus.in_progress]: [OrderStatus.ready, OrderStatus.fulfilled, OrderStatus.cancelled],
  [OrderStatus.ready]: [OrderStatus.fulfilled, OrderStatus.cancelled],
  [OrderStatus.fulfilled]: [OrderStatus.closed],
  [OrderStatus.closed]: [],
  [OrderStatus.cancelled]: [],
};

/** Rental-module lifecycle (independent of Core OrderStatus) */
const RENTAL_TRANSITIONS: Partial<
  Record<RentalOrderLifecycle, RentalOrderLifecycle[]>
> = {
  [RentalOrderLifecycle.quote]: [
    RentalOrderLifecycle.reserved,
    RentalOrderLifecycle.cancelled,
  ],
  [RentalOrderLifecycle.reserved]: [
    RentalOrderLifecycle.fitted,
    RentalOrderLifecycle.ready,
    RentalOrderLifecycle.checked_out,
    RentalOrderLifecycle.cancelled,
  ],
  [RentalOrderLifecycle.fitted]: [
    RentalOrderLifecycle.ready,
    RentalOrderLifecycle.checked_out,
    RentalOrderLifecycle.cancelled,
  ],
  [RentalOrderLifecycle.ready]: [
    RentalOrderLifecycle.checked_out,
    RentalOrderLifecycle.cancelled,
  ],
  [RentalOrderLifecycle.checked_out]: [RentalOrderLifecycle.returned],
  [RentalOrderLifecycle.returned]: [
    RentalOrderLifecycle.inspected,
    RentalOrderLifecycle.closed,
  ],
  [RentalOrderLifecycle.inspected]: [RentalOrderLifecycle.closed],
  [RentalOrderLifecycle.closed]: [],
  [RentalOrderLifecycle.cancelled]: [],
};

const LIFECYCLE_TO_CORE: Partial<Record<RentalOrderLifecycle, OrderStatus>> = {
  [RentalOrderLifecycle.reserved]: OrderStatus.confirmed,
  [RentalOrderLifecycle.fitted]: OrderStatus.in_progress,
  [RentalOrderLifecycle.ready]: OrderStatus.ready,
  [RentalOrderLifecycle.checked_out]: OrderStatus.fulfilled,
  [RentalOrderLifecycle.returned]: OrderStatus.fulfilled,
  [RentalOrderLifecycle.inspected]: OrderStatus.fulfilled,
  [RentalOrderLifecycle.closed]: OrderStatus.closed,
  [RentalOrderLifecycle.cancelled]: OrderStatus.cancelled,
};

function mapItemKind(raw: string): OrderItemKind {
  switch (raw) {
    case 'rental_unit':
      return OrderItemKind.stock_unit;
    case 'retail':
      return OrderItemKind.product;
    case 'special':
      return OrderItemKind.custom;
    default:
      return raw as OrderItemKind;
  }
}

function money(n: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(n);
}

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateOrderDto) {
    const locationId = dto.locationId ?? dto.storeId;
    if (!locationId) {
      throw new BadRequestException('locationId (or storeId) is required');
    }
    await this.assertLocation(user.tenantId, locationId);
    if (dto.customerId) {
      await this.assertCustomer(user.tenantId, dto.customerId);
    }

    const isRental =
      dto.kind === OrderKind.rental ||
      Boolean(dto.pickupDate || dto.returnDueDate || dto.partyId);

    const kind = dto.kind ?? (isRental ? OrderKind.rental : OrderKind.sale);
    const orderNumber = await this.nextOrderNumber(user.tenantId);

    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { currencyCode: true },
    });

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          customerId: dto.customerId,
          orderNumber,
          kind,
          status: OrderStatus.draft,
          createdById: user.userId,
          currencyCode: tenant.currencyCode,
        },
      });

      if (isRental) {
        await tx.modRentalOrder.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            partyId: dto.partyId,
            lifecycle: RentalOrderLifecycle.quote,
            eventDate: dto.eventDate ? new Date(dto.eventDate) : null,
            pickupDate: dto.pickupDate ? new Date(dto.pickupDate) : null,
            returnDueDate: dto.returnDueDate
              ? new Date(dto.returnDueDate)
              : null,
          },
        });
      }

      for (const item of dto.items ?? []) {
        await this.createItemTx(tx, user.tenantId, created.id, item);
      }

      await this.recalculateTotals(tx, user.tenantId, created.id);
      return created.id;
    });

    return this.getById(user, order);
  }

  async list(user: AuthUser, query: ListOrdersQueryDto) {
    const { skip, take, page, limit } = (() => {
      const p = paginate(query.page, query.limit);
      return { ...p, take: p.limit };
    })();
    const locationId = query.locationId ?? query.storeId;
    const where: Prisma.OrderWhereInput = {
      tenantId: user.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(query.q
        ? {
            orderNumber: { contains: query.q.trim(), mode: 'insensitive' },
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          customer: { select: { id: true, fullName: true, phone: true } },
          location: { select: { id: true, name: true, code: true } },
          rentalExt: true,
          _count: { select: { items: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items: items.map((o) => ({
        ...o,
        store: o.location,
        storeId: o.locationId,
      })),
        meta: pageMeta(total, page, limit),
    };
  }

  async getById(user: AuthUser, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        customer: true,
        location: true,
        items: {
          include: {
            product: true,
            stockUnit: true,
            stockLevel: true,
          },
        },
        payments: { orderBy: { createdAt: 'desc' } },
        fees: true,
        invoices: true,
        rentalExt: { include: { party: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return {
      ...order,
      store: order.location,
      storeId: order.locationId,
    };
  }

  async update(user: AuthUser, id: string, dto: UpdateOrderDto) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId: user.tenantId },
      include: { rentalExt: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!MUTABLE.includes(order.status)) {
      throw new BadRequestException(
        `Cannot update order in status ${order.status}`,
      );
    }

    if (order.rentalExt) {
      await this.prisma.modRentalOrder.update({
        where: { orderId: id },
        data: {
          ...(dto.partyId !== undefined ? { partyId: dto.partyId } : {}),
          ...(dto.eventDate !== undefined
            ? { eventDate: dto.eventDate ? new Date(dto.eventDate) : null }
            : {}),
          ...(dto.pickupDate !== undefined
            ? { pickupDate: dto.pickupDate ? new Date(dto.pickupDate) : null }
            : {}),
          ...(dto.returnDueDate !== undefined
            ? {
                returnDueDate: dto.returnDueDate
                  ? new Date(dto.returnDueDate)
                  : null,
              }
            : {}),
        },
      });
    }

    return this.getById(user, id);
  }

  async addItem(user: AuthUser, orderId: string, dto: CreateOrderItemDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!MUTABLE.includes(order.status)) {
      throw new BadRequestException('Order items are locked for this status');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.createItemTx(tx, user.tenantId, orderId, dto);
      await this.recalculateTotals(tx, user.tenantId, orderId);
    });

    return this.getById(user, orderId);
  }

  async removeItem(user: AuthUser, orderId: string, itemId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!MUTABLE.includes(order.status)) {
      throw new BadRequestException('Order items are locked for this status');
    }

    const item = await this.prisma.orderItem.findFirst({
      where: { id: itemId, orderId, tenantId: user.tenantId },
    });
    if (!item) throw new NotFoundException('Order item not found');

    await this.prisma.$transaction(async (tx) => {
      if (item.stockLevelId && item.itemKind === OrderItemKind.product) {
        await tx.stockLevel.update({
          where: { id: item.stockLevelId },
          data: { qtyOnHand: { increment: Number(item.quantity) } },
        });
      }
      await tx.orderItem.delete({ where: { id: itemId } });
      await this.recalculateTotals(tx, user.tenantId, orderId);
    });

    return this.getById(user, orderId);
  }

  async changeStatus(
    user: AuthUser,
    id: string,
    dto: UpdateOrderStatusDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!order) throw new NotFoundException('Order not found');

    const allowed = TRANSITIONS[order.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Cannot transition ${order.status} → ${dto.status}`,
      );
    }

    await this.prisma.order.update({
      where: { id },
      data: { status: dto.status },
    });

    await this.prisma.outboxEvent.create({
      data: {
        tenantId: user.tenantId,
        eventType: 'order.status_changed',
        aggregateType: 'order',
        aggregateId: id,
        payload: { from: order.status, to: dto.status },
      },
    });

    return this.getById(user, id);
  }

  /**
   * Advance rental-module lifecycle and apply stock side-effects.
   * Core OrderStatus is synced via LIFECYCLE_TO_CORE — no industry strings in Core.
   */
  async changeRentalLifecycle(
    user: AuthUser,
    id: string,
    dto: UpdateRentalLifecycleDto,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        rentalExt: true,
        items: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.rentalExt) {
      throw new BadRequestException('Order has no rental extension');
    }

    const from = order.rentalExt.lifecycle;
    const to = dto.lifecycle;
    const allowed = RENTAL_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(
        `Cannot transition rental lifecycle ${from} → ${to}`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (to === RentalOrderLifecycle.reserved) {
        await this.reserveRentalUnits(tx, user, order);
      }
      if (to === RentalOrderLifecycle.checked_out) {
        await this.checkoutRentalUnits(tx, user, order);
      }
      if (to === RentalOrderLifecycle.cancelled) {
        await this.releaseRentalHolds(tx, user, order);
      }

      await tx.modRentalOrder.update({
        where: { orderId: id },
        data: { lifecycle: to },
      });

      const coreStatus = LIFECYCLE_TO_CORE[to];
      if (coreStatus && coreStatus !== order.status) {
        await tx.order.update({
          where: { id },
          data: { status: coreStatus },
        });
      }

      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'rental.lifecycle_changed',
          aggregateType: 'order',
          aggregateId: id,
          payload: { from, to, coreStatus: coreStatus ?? order.status },
        },
      });
    });

    return this.getById(user, id);
  }

  private dateOnly(d: Date) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private async reserveRentalUnits(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    order: {
      id: string;
      tenantId: string;
      rentalExt: {
        pickupDate: Date | null;
        returnDueDate: Date | null;
      } | null;
      items: Array<{
        id: string;
        stockUnitId: string | null;
        itemKind: OrderItemKind;
      }>;
    },
  ) {
    const pickup = order.rentalExt?.pickupDate;
    const ret = order.rentalExt?.returnDueDate;
    if (!pickup || !ret) {
      throw new BadRequestException(
        'pickupDate and returnDueDate required to reserve',
      );
    }
    const start = this.dateOnly(pickup);
    const end = this.dateOnly(ret);
    if (end < start) {
      throw new BadRequestException('returnDueDate must be on or after pickupDate');
    }

    const unitItems = order.items.filter(
      (i) => i.stockUnitId && i.itemKind === OrderItemKind.stock_unit,
    );
    if (unitItems.length === 0) {
      throw new BadRequestException('No stock units on order to reserve');
    }

    for (const item of unitItems) {
      const stockUnitId = item.stockUnitId!;
      const unit = await tx.stockUnit.findFirst({
        where: { id: stockUnitId, tenantId: user.tenantId },
      });
      if (!unit) throw new NotFoundException('Stock unit not found');
      if (
        unit.status !== StockUnitStatus.available &&
        unit.status !== StockUnitStatus.reserved
      ) {
        throw new BadRequestException(
          `Unit ${unit.barcodeSku} cannot be reserved (status ${unit.status})`,
        );
      }

      const overlap = await tx.stockReservation.findFirst({
        where: {
          stockUnitId,
          tenantId: user.tenantId,
          status: {
            in: [ReservationStatus.held, ReservationStatus.checked_out],
          },
          startDate: { lte: end },
          endDate: { gte: start },
          NOT: { orderItemId: item.id },
        },
      });
      if (overlap) {
        throw new BadRequestException(
          `Unit ${unit.barcodeSku} already reserved for overlapping dates`,
        );
      }

      const existing = await tx.stockReservation.findFirst({
        where: {
          tenantId: user.tenantId,
          orderItemId: item.id,
          status: ReservationStatus.held,
        },
      });
      if (!existing) {
        await tx.stockReservation.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId,
            orderItemId: item.id,
            startDate: start,
            endDate: end,
            status: ReservationStatus.held,
          },
        });
      }

      if (unit.status === StockUnitStatus.available) {
        await tx.stockUnit.update({
          where: { id: stockUnitId },
          data: { status: StockUnitStatus.reserved },
        });
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId,
            fromStatus: StockUnitStatus.available,
            toStatus: StockUnitStatus.reserved,
            reason: 'rental.reserved',
            actorUserId: user.userId,
            orderId: order.id,
          },
        });
      }
    }
  }

  private async checkoutRentalUnits(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    order: {
      id: string;
      tenantId: string;
      items: Array<{
        id: string;
        stockUnitId: string | null;
        itemKind: OrderItemKind;
      }>;
    },
  ) {
    const unitItems = order.items.filter(
      (i) => i.stockUnitId && i.itemKind === OrderItemKind.stock_unit,
    );
    for (const item of unitItems) {
      const stockUnitId = item.stockUnitId!;
      const unit = await tx.stockUnit.findFirst({
        where: { id: stockUnitId, tenantId: user.tenantId },
      });
      if (!unit) throw new NotFoundException('Stock unit not found');

      await tx.stockReservation.updateMany({
        where: {
          tenantId: user.tenantId,
          orderItemId: item.id,
          status: ReservationStatus.held,
        },
        data: { status: ReservationStatus.checked_out },
      });

      if (unit.status !== StockUnitStatus.checked_out) {
        await tx.stockUnit.update({
          where: { id: stockUnitId },
          data: { status: StockUnitStatus.checked_out },
        });
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId,
            fromStatus: unit.status,
            toStatus: StockUnitStatus.checked_out,
            reason: 'rental.checked_out',
            actorUserId: user.userId,
            orderId: order.id,
          },
        });
      }
    }
  }

  private async releaseRentalHolds(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    order: {
      id: string;
      items: Array<{
        id: string;
        stockUnitId: string | null;
        itemKind: OrderItemKind;
      }>;
    },
  ) {
    for (const item of order.items) {
      if (!item.stockUnitId || item.itemKind !== OrderItemKind.stock_unit) {
        continue;
      }
      await tx.stockReservation.updateMany({
        where: {
          tenantId: user.tenantId,
          orderItemId: item.id,
          status: ReservationStatus.held,
        },
        data: { status: ReservationStatus.cancelled },
      });
      const unit = await tx.stockUnit.findFirst({
        where: { id: item.stockUnitId, tenantId: user.tenantId },
      });
      if (unit?.status === StockUnitStatus.reserved) {
        const active = await tx.stockReservation.count({
          where: {
            stockUnitId: unit.id,
            tenantId: user.tenantId,
            status: {
              in: [ReservationStatus.held, ReservationStatus.checked_out],
            },
          },
        });
        if (active === 0) {
          await tx.stockUnit.update({
            where: { id: unit.id },
            data: { status: StockUnitStatus.available },
          });
          await tx.stockMovement.create({
            data: {
              tenantId: user.tenantId,
              stockUnitId: unit.id,
              fromStatus: StockUnitStatus.reserved,
              toStatus: StockUnitStatus.available,
              reason: 'rental.cancelled',
              actorUserId: user.userId,
              orderId: order.id,
            },
          });
        }
      }
    }
  }

  private async createItemTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    dto: CreateOrderItemDto,
  ) {
    const rawKind = dto.itemKind ?? dto.itemType;
    if (!rawKind) {
      throw new BadRequestException('itemKind or itemType is required');
    }
    const kind = mapItemKind(rawKind);
    const qty = dto.quantity ?? 1;
    let unitPrice = dto.unitPrice ?? 0;
    let productId = dto.productId ?? null;
    let stockUnitId = dto.stockUnitId ?? dto.inventoryUnitId ?? null;
    let stockLevelId = dto.stockLevelId ?? dto.retailSkuId ?? null;
    let description = dto.description ?? null;

    if (kind === OrderItemKind.stock_unit) {
      if (!stockUnitId) {
        throw new BadRequestException('stockUnitId required for stock_unit');
      }
      const unit = await tx.stockUnit.findFirst({
        where: { id: stockUnitId, tenantId },
        include: { product: true },
      });
      if (!unit) throw new NotFoundException('Stock unit not found');
      productId = unit.productId;
      if (dto.unitPrice === undefined) {
        unitPrice = Number(unit.product.basePrice);
      }
      description = description ?? unit.product.name;
    }

    if (kind === OrderItemKind.product) {
      if (stockLevelId) {
        const level = await tx.stockLevel.findFirst({
          where: { id: stockLevelId, tenantId },
          include: { product: true },
        });
        if (!level) throw new NotFoundException('Stock level not found');
        if (Number(level.qtyOnHand) < qty) {
          throw new BadRequestException('Insufficient stock');
        }
        productId = level.productId;
        if (dto.unitPrice === undefined) unitPrice = Number(level.sellPrice);
        description = description ?? level.product.name;
        await tx.stockLevel.update({
          where: { id: level.id },
          data: { qtyOnHand: { decrement: qty } },
        });
      } else if (productId) {
        const product = await tx.product.findFirst({
          where: { id: productId, tenantId },
        });
        if (!product) throw new NotFoundException('Product not found');
        if (dto.unitPrice === undefined) unitPrice = Number(product.basePrice);
        description = description ?? product.name;
      } else {
        throw new BadRequestException(
          'productId or stockLevelId required for product line',
        );
      }
    }

    const lineTotal = money(unitPrice).mul(qty);
    const taxAmount = money(dto.taxAmount ?? 0);

    await tx.orderItem.create({
      data: {
        tenantId,
        orderId,
        itemKind: kind,
        productId,
        stockUnitId,
        stockLevelId,
        wearerCustomerId: dto.wearerCustomerId,
        description,
        quantity: qty,
        unitPrice: money(unitPrice).toFixed(2),
        lineTotal: lineTotal.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
      },
    });
  }

  async recalculateTotals(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ) {
    const order = await tx.order.findFirstOrThrow({
      where: { id: orderId, tenantId },
      select: { discountTotal: true },
    });
    const items = await tx.orderItem.findMany({ where: { orderId, tenantId } });
    const fees = await tx.orderFee.findMany({ where: { orderId, tenantId } });
    const payments = await tx.payment.findMany({
      where: { orderId, tenantId, status: 'succeeded' },
    });

    let subtotal = money(0);
    let taxTotal = money(0);
    for (const i of items) {
      subtotal = subtotal.add(i.lineTotal);
      taxTotal = taxTotal.add(i.taxAmount);
    }
    for (const f of fees) {
      subtotal = subtotal.add(f.amount);
    }

    let paid = money(0);
    let deposits = money(0);
    for (const p of payments) {
      if (p.type === 'refund' || p.type === 'deposit_refund') {
        paid = paid.sub(p.amount);
      } else if (p.type === 'deposit') {
        deposits = deposits.add(p.amount);
        paid = paid.add(p.amount);
      } else {
        paid = paid.add(p.amount);
      }
    }

    const discount = money(order.discountTotal ?? 0);
    const grand = Prisma.Decimal.max(
      subtotal.add(taxTotal).sub(discount),
      money(0),
    );
    const balanceDue = Prisma.Decimal.max(grand.sub(paid), money(0));

    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal: subtotal.toFixed(2),
        taxTotal: taxTotal.toFixed(2),
        depositTotal: deposits.toFixed(2),
        balanceDue: balanceDue.toFixed(2),
      },
    });
  }

  private async nextOrderNumber(tenantId: string) {
    const count = await this.prisma.order.count({ where: { tenantId } });
    const n = String(count + 1).padStart(5, '0');
    return `ORD-${n}`;
  }

  private async assertLocation(tenantId: string, id: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id, tenantId, isActive: true },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
  }

  private async assertCustomer(tenantId: string, id: string) {
    const c = await this.prisma.customer.findFirst({
      where: { id, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!c) throw new NotFoundException('Customer not found');
  }
}
