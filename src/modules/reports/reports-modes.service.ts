import { Injectable } from '@nestjs/common';
import {
  CustomerSubscriptionStatus,
  OrderKind,
  OrderStatus,
  Prisma,
  StockUnitStatus,
} from '@prisma/client';
import {
  enabledReportPacks,
  reportContextFromSettings,
} from '../../common/report-capabilities';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type { DateRangeQueryDto } from './dto/reports.dto';
import { round2 } from './reports.util';

/**
 * Capability / commerce-mode report packs.
 * Same endpoints for every industry — packs hide when the tenant does not run
 * that mode (rental gym equipment, studio rooms, clothing hire, etc.).
 */
@Injectable()
export class ReportsModesService {
  constructor(private readonly prisma: PrismaService) {}

  async packs(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    const ctx = reportContextFromSettings(tenant?.settings);
    return {
      ...enabledReportPacks(ctx),
      commerceModes: ctx.commerceModes,
    };
  }

  async rentalOps(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.dateFilter(query);
    const now = new Date();
    const loc = query.locationId;

    const orderWhere: Prisma.OrderWhereInput = {
      tenantId: user.tenantId,
      kind: OrderKind.rental,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      ...(createdAt ? { createdAt } : {}),
      ...(loc ? { locationId: loc } : {}),
    };

    const [
      revenue,
      byLifecycle,
      overdue,
      units,
      damages,
      cleaning,
      openDeposits,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        where: orderWhere,
        _sum: { subtotal: true, taxTotal: true, balanceDue: true },
        _count: { _all: true },
      }),
      this.prisma.modRentalOrder.groupBy({
        by: ['lifecycle'],
        where: {
          tenantId: user.tenantId,
          ...(loc ? { order: { locationId: loc } } : {}),
        },
        _count: { _all: true },
      }),
      this.prisma.modRentalOrder.findMany({
        where: {
          tenantId: user.tenantId,
          returnDueDate: { lt: now },
          lifecycle: { in: ['checked_out', 'ready', 'fitted'] },
          ...(loc ? { order: { locationId: loc } } : {}),
        },
        take: 40,
        orderBy: { returnDueDate: 'asc' },
        select: {
          returnDueDate: true,
          lifecycle: true,
          pickupDate: true,
          order: {
            select: {
              id: true,
              orderNumber: true,
              balanceDue: true,
              customer: { select: { fullName: true, phone: true } },
              location: { select: { name: true } },
            },
          },
        },
      }),
      this.prisma.stockUnit.groupBy({
        by: ['status'],
        where: {
          tenantId: user.tenantId,
          ...(loc ? { locationId: loc } : {}),
        },
        _count: { _all: true },
      }),
      this.prisma.modRentalDamageRecord.aggregate({
        where: {
          tenantId: user.tenantId,
          ...(createdAt ? { createdAt } : {}),
          ...(loc ? { stockUnit: { locationId: loc } } : {}),
        },
        _count: { _all: true },
        _sum: { chargeAmount: true },
      }),
      this.prisma.modRentalCleaningJob.count({
        where: {
          tenantId: user.tenantId,
          status: { in: ['queued', 'in_progress'] },
          ...(loc ? { stockUnit: { locationId: loc } } : {}),
        },
      }),
      this.prisma.stockUnit.aggregate({
        where: {
          tenantId: user.tenantId,
          status: StockUnitStatus.checked_out,
          depositAmount: { gt: 0 },
          ...(loc ? { locationId: loc } : {}),
        },
        _sum: { depositAmount: true },
        _count: { _all: true },
      }),
    ]);

    const unitTotal = units.reduce((s, r) => s + r._count._all, 0);
    const outCount =
      units.find((r) => r.status === StockUnitStatus.checked_out)?._count
        ._all ?? 0;
    const available =
      units.find((r) => r.status === StockUnitStatus.available)?._count._all ??
      0;

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      locationId: loc ?? null,
      summary: {
        orderCount: revenue._count._all,
        revenue: round2(Number(revenue._sum.subtotal ?? 0)),
        tax: round2(Number(revenue._sum.taxTotal ?? 0)),
        balanceDue: round2(Number(revenue._sum.balanceDue ?? 0)),
        overdueCount: overdue.length,
        utilizationPct:
          unitTotal > 0 ? round2((outCount / unitTotal) * 100) : null,
        availableUnits: available,
        unitsOut: outCount,
        unitsTotal: unitTotal,
        openDeposits: round2(Number(openDeposits._sum.depositAmount ?? 0)),
        openDepositUnits: openDeposits._count._all,
        damageEvents: damages._count._all,
        damageCharges: round2(Number(damages._sum.chargeAmount ?? 0)),
        cleaningQueue: cleaning,
      },
      byLifecycle: byLifecycle.map((r) => ({
        lifecycle: r.lifecycle,
        count: r._count._all,
      })),
      byUnitStatus: units.map((r) => ({
        status: r.status,
        count: r._count._all,
      })),
      overdue: overdue.map((r) => ({
        orderId: r.order.id,
        orderNumber: r.order.orderNumber,
        customerName: r.order.customer?.fullName ?? 'Walk-in',
        phone: r.order.customer?.phone ?? null,
        locationName: r.order.location?.name ?? '—',
        lifecycle: r.lifecycle,
        pickupDate: r.pickupDate,
        returnDueDate: r.returnDueDate,
        balanceDue: Number(r.order.balanceDue),
      })),
    };
  }

  async subscriptions(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.dateFilter(query);
    const loc = query.locationId;
    const now = new Date();
    const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const [byStatus, active, started, cancelled, expiring, checkIns] =
      await Promise.all([
        this.prisma.customerSubscription.groupBy({
          by: ['status'],
          where: { tenantId: user.tenantId },
          _count: { _all: true },
          _sum: { price: true },
        }),
        this.prisma.customerSubscription.findMany({
          where: {
            tenantId: user.tenantId,
            status: CustomerSubscriptionStatus.active,
          },
          select: { price: true, billingPeriodDays: true },
        }),
        this.prisma.customerSubscription.count({
          where: {
            tenantId: user.tenantId,
            ...(createdAt ? { startsAt: createdAt } : {}),
          },
        }),
        this.prisma.customerSubscription.count({
          where: {
            tenantId: user.tenantId,
            status: CustomerSubscriptionStatus.cancelled,
            ...(createdAt ? { cancelledAt: createdAt } : {}),
          },
        }),
        this.prisma.customerSubscription.findMany({
          where: {
            tenantId: user.tenantId,
            status: CustomerSubscriptionStatus.active,
            currentPeriodEnd: { gte: now, lte: horizon },
          },
          take: 40,
          orderBy: { currentPeriodEnd: 'asc' },
          select: {
            id: true,
            currentPeriodEnd: true,
            price: true,
            billingPeriodDays: true,
            customer: { select: { fullName: true, phone: true } },
            product: { select: { name: true } },
          },
        }),
        this.prisma.auditLog.count({
          where: {
            tenantId: user.tenantId,
            action: 'membership.check_in',
            ...(createdAt ? { createdAt } : {}),
          },
        }),
      ]);

    let monthlyRecurring = 0;
    for (const row of active) {
      const days = row.billingPeriodDays > 0 ? row.billingPeriodDays : 30;
      monthlyRecurring += (Number(row.price) * 30) / days;
    }

    const activeCount =
      byStatus.find((r) => r.status === CustomerSubscriptionStatus.active)
        ?._count._all ?? 0;
    const churnDenom = activeCount + cancelled;
    const churnPct =
      churnDenom > 0 ? round2((cancelled / churnDenom) * 100) : 0;

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      locationId: loc ?? null,
      summary: {
        active: activeCount,
        startedInPeriod: started,
        cancelledInPeriod: cancelled,
        checkInsInPeriod: checkIns,
        monthlyRecurring: round2(monthlyRecurring),
        churnPct,
      },
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: r._count._all,
        priceSum: round2(Number(r._sum.price ?? 0)),
      })),
      upcomingRenewals: expiring.map((r) => ({
        id: r.id,
        planName: r.product.name,
        customerName: r.customer.fullName,
        phone: r.customer.phone,
        renewsAt: r.currentPeriodEnd,
        price: Number(r.price),
        billingPeriodDays: r.billingPeriodDays,
      })),
    };
  }

  private dateFilter(
    query: DateRangeQueryDto,
  ): Prisma.DateTimeFilter | undefined {
    if (!query.from && !query.to) return undefined;
    const filter: Prisma.DateTimeFilter = {};
    if (query.from) filter.gte = new Date(query.from);
    if (query.to) {
      const end = new Date(query.to);
      end.setHours(23, 59, 59, 999);
      filter.lte = end;
    }
    return filter;
  }
}
