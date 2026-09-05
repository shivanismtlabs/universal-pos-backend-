import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomerSubscriptionStatus,
  FulfillmentMode,
  OrderItemKind,
  OrderKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { addServiceDuration } from '../../common/service-duration';
import { parseCommerceModes } from '../../common/commerce-schema';
import { validateSku } from '../../common/sell-units';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CheckInSubscriptionDto,
  CreatePlanDto,
  EnrollSubscriptionDto,
  ListSubscriptionsQueryDto,
  RenewSubscriptionDto,
  UpdatePlanDto,
} from './dto/subscriptions.dto';

function money(n: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(n);
}

function addDays(d: Date, days: number) {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertMode(tenantId: string, mode: 'subscription' | 'service') {
    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: tenantId },
      select: { settings: true, currencyCode: true, timezone: true },
    });
    const parsed = parseCommerceModes(tenant.settings);
    if (!parsed.modes.includes(mode)) {
      throw new BadRequestException(
        `Enable ${mode} mode in shop setup before using this feature`,
      );
    }
    return tenant;
  }

  private async defaultLocationId(tenantId: string, preferred?: string) {
    if (preferred) {
      const loc = await this.prisma.location.findFirst({
        where: { id: preferred, tenantId, isActive: true },
        select: { id: true },
      });
      if (!loc) throw new NotFoundException('Location not found');
      return loc.id;
    }
    const main = await this.prisma.location.findFirst({
      where: { tenantId, isActive: true, code: 'MAIN' },
      select: { id: true },
    });
    if (main) return main.id;
    const any = await this.prisma.location.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!any) throw new BadRequestException('No active location configured');
    return any.id;
  }

  private mapPlan(p: {
    id: string;
    name: string;
    skuCode: string;
    description: string | null;
    basePrice: Prisma.Decimal;
    isActive: boolean;
    meta: unknown;
    categoryId: string | null;
    category: { id: string; name: string } | null;
    createdAt: Date;
    _count?: { customerSubscriptions: number };
  }) {
    const meta =
      p.meta && typeof p.meta === 'object'
        ? (p.meta as Record<string, unknown>)
        : {};
    const days =
      typeof meta.billingPeriodDays === 'number'
        ? meta.billingPeriodDays
        : Number(meta.billingPeriodDays ?? 30);
    const durationUnit =
      typeof meta.durationUnit === 'string' && meta.durationUnit.trim()
        ? meta.durationUnit.trim()
        : null;
    const durationQuantity =
      typeof meta.durationQuantity === 'number' && meta.durationQuantity > 0
        ? meta.durationQuantity
        : null;

    return {
      id: p.id,
      title: p.name,
      sku: p.skuCode,
      description: p.description,
      price: p.basePrice,
      billingPeriodDays: Number.isFinite(days) && days > 0 ? days : 30,
      durationUnit,
      durationQuantity,
      isActive: p.isActive,
      category: p.category,
      categoryId: p.categoryId,
      activeMembers: p._count?.customerSubscriptions ?? 0,
      createdAt: p.createdAt,
    };
  }

  async listPlans(user: AuthUser) {
    await this.assertMode(user.tenantId, 'subscription');
    const rows = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.subscription,
      },
      include: {
        category: { select: { id: true, name: true } },
        _count: {
          select: {
            customerSubscriptions: {
              where: { status: CustomerSubscriptionStatus.active },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    return {
      items: rows.map((r) => this.mapPlan(r)),
      counts: {
        plans: rows.length,
        activePlans: rows.filter((r) => r.isActive).length,
      },
    };
  }

  async createPlan(user: AuthUser, dto: CreatePlanDto) {
    await this.assertMode(user.tenantId, 'subscription');
    const skuErr = validateSku(dto.sku);
    if (skuErr) throw new BadRequestException(skuErr);

    const cat = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!cat) throw new NotFoundException('Category not found');

    const durationDays = dto.billingPeriodDays ?? 30;

    try {
      const product = await this.prisma.product.create({
        data: {
          tenantId: user.tenantId,
          categoryId: dto.categoryId,
          name: dto.title.trim(),
          skuCode: dto.sku.trim().toUpperCase(),
          description: dto.description?.trim() || null,
          kind: 'digital',
          fulfillmentMode: FulfillmentMode.subscription,
          trackQty: false,
          trackSerial: false,
          basePrice: money(dto.price).toFixed(2),
          meta: {
            billingPeriodDays: durationDays,
            ...(dto.durationUnit ? { durationUnit: dto.durationUnit.trim() } : {}),
            ...(dto.durationQuantity != null ? { durationQuantity: dto.durationQuantity } : {}),
          },
        },
        include: { category: { select: { id: true, name: true } } },
      });
      return this.mapPlan({ ...product, _count: { customerSubscriptions: 0 } });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new BadRequestException('SKU already exists for this shop');
      }
      throw e;
    }
  }

  async updatePlan(user: AuthUser, id: string, dto: UpdatePlanDto) {
    await this.assertMode(user.tenantId, 'subscription');
    const existing = await this.prisma.product.findFirst({
      where: {
        id,
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.subscription,
      },
    });
    if (!existing) throw new NotFoundException('Plan not found');

    const meta =
      existing.meta && typeof existing.meta === 'object'
        ? { ...(existing.meta as Record<string, unknown>) }
        : {};
    if (dto.billingPeriodDays != null) {
      meta.billingPeriodDays = dto.billingPeriodDays;
    }
    if (dto.durationUnit !== undefined) {
      if (dto.durationUnit) meta.durationUnit = dto.durationUnit.trim();
      else delete meta.durationUnit;
    }
    if (dto.durationQuantity !== undefined) {
      if (dto.durationQuantity != null) meta.durationQuantity = dto.durationQuantity;
      else delete meta.durationQuantity;
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.title != null ? { name: dto.title.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description?.trim() || null }
          : {}),
        ...(dto.price != null
          ? { basePrice: money(dto.price).toFixed(2) }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        meta: meta as Prisma.InputJsonValue,
      },
      include: {
        category: { select: { id: true, name: true } },
        _count: {
          select: {
            customerSubscriptions: {
              where: { status: CustomerSubscriptionStatus.active },
            },
          },
        },
      },
    });
    return this.mapPlan(updated);
  }

  async listMembers(user: AuthUser, query: ListSubscriptionsQueryDto) {
    await this.assertMode(user.tenantId, 'subscription');
    const limit = query.limit ?? 50;

    // Auto-expire past-due actives (best-effort)
    await this.prisma.customerSubscription.updateMany({
      where: {
        tenantId: user.tenantId,
        status: CustomerSubscriptionStatus.active,
        currentPeriodEnd: { lt: new Date() },
      },
      data: { status: CustomerSubscriptionStatus.expired },
    });

    const items = await this.prisma.customerSubscription.findMany({
      where: {
        tenantId: user.tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.customerId ? { customerId: query.customerId } : {}),
      },
      include: {
        customer: {
          select: { id: true, fullName: true, phone: true, email: true },
        },
        product: {
          select: { id: true, name: true, skuCode: true, basePrice: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    const activeCount = await this.prisma.customerSubscription.count({
      where: {
        tenantId: user.tenantId,
        status: CustomerSubscriptionStatus.active,
      },
    });

    return {
      items: items.map((s) => ({
        id: s.id,
        status: s.status,
        billingPeriodDays: s.billingPeriodDays,
        price: s.price,
        startsAt: s.startsAt,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelledAt: s.cancelledAt,
        lastOrderId: s.lastOrderId,
        customer: s.customer,
        plan: {
          id: s.product.id,
          title: s.product.name,
          sku: s.product.skuCode,
          price: s.product.basePrice,
        },
        createdAt: s.createdAt,
      })),
      counts: { active: activeCount, listed: items.length },
    };
  }

  private async getSubscriptionForCheckIn(user: AuthUser, id: string) {
    await this.assertMode(user.tenantId, 'subscription');
    const sub = await this.prisma.customerSubscription.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        customer: {
          select: { id: true, fullName: true, phone: true, email: true },
        },
        product: {
          select: { id: true, name: true, skuCode: true, basePrice: true },
        },
      },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  async checkInStatus(user: AuthUser, id: string) {
    const sub = await this.getSubscriptionForCheckIn(user, id);
    const logs = await this.prisma.auditLog.findMany({
      where: {
        tenantId: user.tenantId,
        entityType: 'customer_subscription',
        entityId: id,
        action: { in: ['membership.check_in', 'membership.check_out'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    const latestIn = logs.find((l) => l.action === 'membership.check_in');
    const latestOut = logs.find((l) => l.action === 'membership.check_out');
    const isCheckedIn =
      !!latestIn &&
      (!latestOut || latestIn.createdAt.getTime() > latestOut.createdAt.getTime());

    return {
      subscriptionId: sub.id,
      status: sub.status,
      isCheckedIn,
      customer: sub.customer,
      plan: {
        id: sub.product.id,
        title: sub.product.name,
        sku: sub.product.skuCode,
        price: sub.price,
      },
      startsAt: sub.startsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelledAt: sub.cancelledAt,
      lastVisitAt: latestIn?.createdAt ?? null,
      currentSessionStartedAt: isCheckedIn ? latestIn?.createdAt ?? null : null,
      history: logs.map((l) => ({
        id: l.id,
        action: l.action,
        at: l.createdAt,
        note:
          l.beforeAfter && typeof l.beforeAfter === 'object'
            ? ((l.beforeAfter as Record<string, unknown>).note ?? null)
            : null,
      })),
    };
  }

  async checkIn(user: AuthUser, id: string, dto: CheckInSubscriptionDto) {
    const sub = await this.getSubscriptionForCheckIn(user, id);
    if (sub.status !== CustomerSubscriptionStatus.active) {
      throw new BadRequestException(
        `Membership is ${sub.status.toLowerCase()} and cannot be checked in`,
      );
    }
    if (sub.currentPeriodEnd < new Date()) {
      throw new BadRequestException('Membership has expired');
    }
    const state = await this.checkInStatus(user, id);
    if (state.isCheckedIn) {
      throw new BadRequestException('Member is already checked in');
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'customer_subscription',
        entityId: id,
        action: 'membership.check_in',
        beforeAfter: {
          customerId: sub.customerId,
          productId: sub.productId,
          locationId: dto.locationId ?? user.locationId ?? null,
          note: dto.note?.trim() || null,
        } as Prisma.InputJsonValue,
      },
    });

    return this.checkInStatus(user, id);
  }

  async checkOut(user: AuthUser, id: string, dto: CheckInSubscriptionDto) {
    const sub = await this.getSubscriptionForCheckIn(user, id);
    const state = await this.checkInStatus(user, id);
    if (!state.isCheckedIn) {
      throw new BadRequestException('Member is not currently checked in');
    }

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'customer_subscription',
        entityId: id,
        action: 'membership.check_out',
        beforeAfter: {
          customerId: sub.customerId,
          productId: sub.productId,
          locationId: dto.locationId ?? user.locationId ?? null,
          note: dto.note?.trim() || null,
        } as Prisma.InputJsonValue,
      },
    });

    return this.checkInStatus(user, id);
  }

  async enroll(user: AuthUser, dto: EnrollSubscriptionDto) {
    const tenant = await this.assertMode(user.tenantId, 'subscription');
    const locationId = await this.defaultLocationId(
      user.tenantId,
      dto.locationId,
    );

    const customer = await this.prisma.customer.findFirst({
      where: {
        id: dto.customerId,
        tenantId: user.tenantId,
        deletedAt: null,
      },
      select: { id: true, fullName: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    const product = await this.prisma.product.findFirst({
      where: {
        id: dto.productId,
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.subscription,
        isActive: true,
      },
    });
    if (!product) throw new NotFoundException('Plan not found or inactive');

    const meta =
      product.meta && typeof product.meta === 'object'
        ? (product.meta as Record<string, unknown>)
        : {};
    const periodDays = Math.max(
      1,
      Number(meta.billingPeriodDays ?? 30) || 30,
    );
    const price = money(product.basePrice);
    if (price.lte(0)) {
      throw new BadRequestException('Plan price must be greater than 0');
    }

    const existingActive = await this.prisma.customerSubscription.findFirst({
      where: {
        tenantId: user.tenantId,
        customerId: customer.id,
        productId: product.id,
        status: CustomerSubscriptionStatus.active,
        currentPeriodEnd: { gte: new Date() },
      },
    });
    if (existingActive) {
      throw new BadRequestException(
        'Customer already has an active membership for this plan',
      );
    }

    const method = dto.paymentMethod ?? PaymentMethod.cash;
    const idem =
      dto.idempotencyKey?.trim() ||
      `sub-enroll-${user.tenantId}-${customer.id}-${product.id}-${Date.now()}`;

    const durationUnit =
      typeof meta.durationUnit === 'string' && meta.durationUnit.trim()
        ? meta.durationUnit.trim()
        : 'day';
    const durationQuantity =
      typeof meta.durationQuantity === 'number' && meta.durationQuantity > 0
        ? meta.durationQuantity
        : periodDays;

    const now = new Date();
    const periodEnd = addServiceDuration({
      startDate: now,
      quantity: durationQuantity,
      durationUnitCode: durationUnit,
      timeZone: tenant.timezone ?? 'Asia/Kolkata',
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const orderCount = await tx.order.count({
        where: { tenantId: user.tenantId },
      });
      const orderNumber = `ORD-${String(orderCount + 1).padStart(5, '0')}`;

      const order = await tx.order.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          customerId: customer.id,
          orderNumber,
          kind: OrderKind.subscription,
          status: OrderStatus.confirmed,
          createdById: user.userId,
          currencyCode: tenant.currencyCode,
          subtotal: price.toFixed(2),
          taxTotal: '0.00',
          discountTotal: '0.00',
          balanceDue: price.toFixed(2),
          meta: {
            subscriptionEnroll: true,
            productId: product.id,
            billingPeriodDays: periodDays,
            durationUnit,
            durationQuantity,
          },
        },
      });

      await tx.orderItem.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          itemKind: OrderItemKind.product,
          productId: product.id,
          description: `${product.name} (${durationQuantity} ${durationUnit})`,
          quantity: 1,
          unitPrice: price.toFixed(2),
          lineTotal: price.toFixed(2),
          taxAmount: '0.00',
          meta: {
            billingPeriodDays: periodDays,
            durationUnit,
            durationQuantity,
          },
        },
      });

      const payment = await tx.payment.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          type: PaymentType.payment,
          method,
          amount: price.toFixed(2),
          status: PaymentStatus.succeeded,
          idempotencyKey: idem,
          takenByUserId: user.userId,
        },
      });

      await tx.order.update({
        where: { id: order.id },
        data: {
          balanceDue: '0.00',
          status: OrderStatus.closed,
        },
      });

      const sub = await tx.customerSubscription.create({
        data: {
          id: randomUUID(),
          tenantId: user.tenantId,
          customerId: customer.id,
          productId: product.id,
          status: CustomerSubscriptionStatus.active,
          billingPeriodDays: periodDays,
          price: price.toFixed(2),
          startsAt: now,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          lastOrderId: order.id,
          meta: {
            enrolledByUserId: user.userId,
            durationUnit,
            durationQuantity,
          },
        },
        include: {
          customer: {
            select: { id: true, fullName: true, phone: true },
          },
          product: { select: { id: true, name: true, skuCode: true } },
        },
      });

      return { sub, order, payment };
    });

    return {
      subscription: {
        id: result.sub.id,
        status: result.sub.status,
        billingPeriodDays: result.sub.billingPeriodDays,
        price: result.sub.price,
        startsAt: result.sub.startsAt,
        currentPeriodEnd: result.sub.currentPeriodEnd,
        customer: result.sub.customer,
        plan: {
          id: result.sub.product.id,
          title: result.sub.product.name,
          sku: result.sub.product.skuCode,
        },
      },
      order: {
        id: result.order.id,
        orderNumber: result.order.orderNumber,
      },
      payment: {
        id: result.payment.id,
        amount: result.payment.amount,
        method: result.payment.method,
      },
    };
  }

  async renew(user: AuthUser, id: string, dto: RenewSubscriptionDto) {
    const tenant = await this.assertMode(user.tenantId, 'subscription');
    const sub = await this.prisma.customerSubscription.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        product: true,
        customer: { select: { id: true, fullName: true } },
      },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (sub.status === CustomerSubscriptionStatus.cancelled) {
      throw new BadRequestException('Cancelled memberships cannot be renewed');
    }
    if (!sub.product.isActive) {
      throw new BadRequestException('Plan is inactive — reactivate the plan first');
    }

    const locationId = await this.defaultLocationId(user.tenantId);
    const periodDays = sub.billingPeriodDays;
    const price = money(sub.product.basePrice);
    const method = dto.paymentMethod ?? PaymentMethod.cash;
    const idem =
      dto.idempotencyKey?.trim() ||
      `sub-renew-${id}-${Date.now()}`;

    const planMeta =
      sub.product.meta && typeof sub.product.meta === 'object'
        ? (sub.product.meta as Record<string, unknown>)
        : {};
    const durationUnit =
      typeof planMeta.durationUnit === 'string' && planMeta.durationUnit.trim()
        ? planMeta.durationUnit.trim()
        : 'day';
    const durationQuantity =
      typeof planMeta.durationQuantity === 'number' && planMeta.durationQuantity > 0
        ? planMeta.durationQuantity
        : periodDays;

    const base =
      sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
    const nextStart = base;
    const nextEnd = addServiceDuration({
      startDate: base,
      quantity: durationQuantity,
      durationUnitCode: durationUnit,
      timeZone: tenant.timezone ?? 'Asia/Kolkata',
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const orderCount = await tx.order.count({
        where: { tenantId: user.tenantId },
      });
      const orderNumber = `ORD-${String(orderCount + 1).padStart(5, '0')}`;

      const order = await tx.order.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          customerId: sub.customerId,
          orderNumber,
          kind: OrderKind.subscription,
          status: OrderStatus.closed,
          createdById: user.userId,
          currencyCode: tenant.currencyCode,
          subtotal: price.toFixed(2),
          taxTotal: '0.00',
          discountTotal: '0.00',
          balanceDue: '0.00',
          meta: {
            subscriptionRenew: true,
            subscriptionId: sub.id,
            billingPeriodDays: periodDays,
          },
        },
      });

      await tx.orderItem.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          itemKind: OrderItemKind.product,
          productId: sub.productId,
          description: `Renew ${sub.product.name} (${periodDays} days)`,
          quantity: 1,
          unitPrice: price.toFixed(2),
          lineTotal: price.toFixed(2),
          taxAmount: '0.00',
        },
      });

      const payment = await tx.payment.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          type: PaymentType.payment,
          method,
          amount: price.toFixed(2),
          status: PaymentStatus.succeeded,
          idempotencyKey: idem,
          takenByUserId: user.userId,
        },
      });

      const updated = await tx.customerSubscription.update({
        where: { id: sub.id },
        data: {
          status: CustomerSubscriptionStatus.active,
          price: price.toFixed(2),
          currentPeriodStart: nextStart,
          currentPeriodEnd: nextEnd,
          cancelledAt: null,
          lastOrderId: order.id,
        },
        include: {
          customer: { select: { id: true, fullName: true, phone: true } },
          product: { select: { id: true, name: true, skuCode: true } },
        },
      });

      return { updated, order, payment };
    });

    return {
      subscription: {
        id: result.updated.id,
        status: result.updated.status,
        currentPeriodEnd: result.updated.currentPeriodEnd,
        price: result.updated.price,
        customer: result.updated.customer,
        plan: {
          id: result.updated.product.id,
          title: result.updated.product.name,
          sku: result.updated.product.skuCode,
        },
      },
      order: {
        id: result.order.id,
        orderNumber: result.order.orderNumber,
      },
      payment: {
        id: result.payment.id,
        amount: result.payment.amount,
        method: result.payment.method,
      },
    };
  }

  async cancel(user: AuthUser, id: string) {
    await this.assertMode(user.tenantId, 'subscription');
    const sub = await this.prisma.customerSubscription.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (sub.status === CustomerSubscriptionStatus.cancelled) {
      return { id: sub.id, status: sub.status, cancelledAt: sub.cancelledAt };
    }

    const updated = await this.prisma.customerSubscription.update({
      where: { id },
      data: {
        status: CustomerSubscriptionStatus.cancelled,
        cancelledAt: new Date(),
      },
    });
    return {
      id: updated.id,
      status: updated.status,
      cancelledAt: updated.cancelledAt,
      currentPeriodEnd: updated.currentPeriodEnd,
    };
  }

  async summary(user: AuthUser) {
    await this.assertMode(user.tenantId, 'subscription');
    const [plans, active, expired, cancelled] = await Promise.all([
      this.prisma.product.count({
        where: {
          tenantId: user.tenantId,
          fulfillmentMode: FulfillmentMode.subscription,
          isActive: true,
        },
      }),
      this.prisma.customerSubscription.count({
        where: {
          tenantId: user.tenantId,
          status: CustomerSubscriptionStatus.active,
        },
      }),
      this.prisma.customerSubscription.count({
        where: {
          tenantId: user.tenantId,
          status: CustomerSubscriptionStatus.expired,
        },
      }),
      this.prisma.customerSubscription.count({
        where: {
          tenantId: user.tenantId,
          status: CustomerSubscriptionStatus.cancelled,
        },
      }),
    ]);
    return { plans, activeMembers: active, expired, cancelled };
  }
}
