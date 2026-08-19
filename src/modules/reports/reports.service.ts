import { Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  OrderItemKind,
  OrderKind,
  OrderStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { DailySalesQueryDto, DateRangeQueryDto } from './dto/reports.dto';

type MoneyTotals = {
  orderCount: number;
  grossSales: number;
  discounts: number;
  tax: number;
  netSales: number;
  refunds: number;
  netRevenue: number;
  avgOrderValue: number;
};

/**
 * Universal reports against Order / Payment / StockUnit (not legacy rentalOrder).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Single business-day sales snapshot for owner/manager.
   * Scoped by tenant; optional branch, cashier, payment method, register session.
   */
  async dailySales(user: AuthUser, query: DailySalesQueryDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: {
        timezone: true,
        currencyCode: true,
        settings: true,
      },
    });
    const timezone = tenant?.timezone || 'Asia/Kolkata';
    const currencyCode = tenant?.currencyCode || 'INR';

    const day = this.dayRange(query.date, timezone);
    const prevDay = this.shiftYmd(query.date, -1);
    const weekAgo = this.shiftYmd(query.date, -7);
    const prevRange = this.dayRange(prevDay, timezone);
    const weekRange = this.dayRange(weekAgo, timezone);

    let registerWindow: { gte: Date; lte: Date } | null = null;
    if (query.registerSessionId) {
      const session = await this.prisma.registerSession.findFirst({
        where: { id: query.registerSessionId, tenantId: user.tenantId },
      });
      if (session) {
        registerWindow = {
          gte: session.openedAt,
          lte: session.closedAt ?? day.end,
        };
      }
    }

    const orderWhere = this.dailyOrderWhere(user.tenantId, day, query, registerWindow);
    const compareBase = {
      tenantId: user.tenantId,
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.employeeId ? { createdById: query.employeeId } : {}),
    };

    const [
      orders,
      refundAgg,
      items,
      payments,
      registerSessions,
      appointments,
      prevTotals,
      weekTotals,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where: orderWhere,
        select: {
          id: true,
          orderNumber: true,
          kind: true,
          status: true,
          subtotal: true,
          taxTotal: true,
          discountTotal: true,
          balanceDue: true,
          currencyCode: true,
          meta: true,
          createdAt: true,
          createdById: true,
          locationId: true,
          customer: { select: { id: true, fullName: true, phone: true } },
          createdBy: { select: { id: true, fullName: true } },
          location: { select: { id: true, name: true } },
          payments: {
            where: { status: PaymentStatus.succeeded },
            select: {
              id: true,
              type: true,
              method: true,
              amount: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.payment.aggregate({
        where: {
          tenantId: user.tenantId,
          status: PaymentStatus.succeeded,
          type: { in: [PaymentType.refund, PaymentType.deposit_refund] },
          createdAt: { gte: day.start, lte: day.end },
          ...(query.locationId
            ? { order: { locationId: query.locationId } }
            : {}),
          ...(query.employeeId
            ? { order: { createdById: query.employeeId } }
            : {}),
          ...(query.paymentMethod
            ? { method: query.paymentMethod as never }
            : {}),
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.orderItem.findMany({
        where: {
          order: orderWhere,
          itemKind: {
            in: [
              OrderItemKind.product,
              OrderItemKind.service,
              OrderItemKind.stock_unit,
              OrderItemKind.custom,
            ],
          },
        },
        select: {
          quantity: true,
          lineTotal: true,
          description: true,
          product: {
            select: {
              id: true,
              name: true,
              skuCode: true,
              category: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.payment.findMany({
        where: {
          tenantId: user.tenantId,
          status: PaymentStatus.succeeded,
          type: PaymentType.payment,
          createdAt: { gte: day.start, lte: day.end },
          ...(query.locationId
            ? { order: { locationId: query.locationId } }
            : {}),
          ...(query.employeeId
            ? { order: { createdById: query.employeeId } }
            : {}),
          ...(query.paymentMethod
            ? { method: query.paymentMethod as never }
            : {}),
        },
        select: { method: true, amount: true },
      }),
      this.prisma.registerSession.findMany({
        where: {
          tenantId: user.tenantId,
          openedAt: { lte: day.end },
          OR: [{ closedAt: null }, { closedAt: { gte: day.start } }],
          ...(query.locationId ? { locationId: query.locationId } : {}),
          ...(query.registerSessionId
            ? { id: query.registerSessionId }
            : {}),
        },
        include: {
          openedBy: { select: { id: true, fullName: true } },
          location: { select: { id: true, name: true } },
        },
        orderBy: { openedAt: 'asc' },
      }),
      this.prisma.appointment.groupBy({
        by: ['status'],
        where: {
          tenantId: user.tenantId,
          startsAt: { gte: day.start, lte: day.end },
          ...(query.locationId ? { locationId: query.locationId } : {}),
        },
        _count: { _all: true },
      }),
      this.periodTotals(user.tenantId, {
        ...compareBase,
        createdAt: { gte: prevRange.start, lte: prevRange.end },
        status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
        kind: { not: OrderKind.return_order },
      }),
      this.periodTotals(user.tenantId, {
        ...compareBase,
        createdAt: { gte: weekRange.start, lte: weekRange.end },
        status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
        kind: { not: OrderKind.return_order },
      }),
    ]);

    // Optional payment-method filter on order list (orders that have that tender)
    let filteredOrders = orders;
    if (query.paymentMethod) {
      filteredOrders = orders.filter((o) =>
        o.payments.some(
          (p) =>
            p.type === PaymentType.payment &&
            String(p.method) === query.paymentMethod,
        ),
      );
    }

    const saleOrders = filteredOrders.filter(
      (o) => o.kind !== OrderKind.return_order,
    );
    const totals = this.computeTotals(
      saleOrders.map((o) => ({
        subtotal: Number(o.subtotal),
        discountTotal: Number(o.discountTotal),
        taxTotal: Number(o.taxTotal),
      })),
      Number(refundAgg._sum.amount ?? 0),
    );

    const hourlyMap = new Map<number, { sales: number; orders: number }>();
    for (let h = 0; h < 24; h++) hourlyMap.set(h, { sales: 0, orders: 0 });
    for (const o of saleOrders) {
      const hour = this.hourInZone(o.createdAt, timezone);
      const row = hourlyMap.get(hour)!;
      row.orders += 1;
      row.sales += Number(o.subtotal) + Number(o.taxTotal);
    }
    const hourly = [...hourlyMap.entries()].map(([hour, v]) => ({
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      sales: round2(v.sales),
      orders: v.orders,
    }));

    const payMap = new Map<string, { amount: number; count: number }>();
    for (const p of payments) {
      const key = String(p.method);
      const row = payMap.get(key) ?? { amount: 0, count: 0 };
      row.amount += Number(p.amount);
      row.count += 1;
      payMap.set(key, row);
    }
    const payTotal = [...payMap.values()].reduce((s, r) => s + r.amount, 0) || 1;
    const byPaymentMethod = [...payMap.entries()]
      .map(([method, v]) => ({
        method,
        amount: round2(v.amount),
        count: v.count,
        pct: round2((v.amount / payTotal) * 100),
      }))
      .sort((a, b) => b.amount - a.amount);

    const catMap = new Map<
      string,
      { categoryId: string | null; name: string; qty: number; revenue: number }
    >();
    const productMap = new Map<
      string,
      {
        productId: string | null;
        name: string;
        sku: string;
        qty: number;
        revenue: number;
      }
    >();
    for (const it of items) {
      const catId = it.product?.category?.id ?? null;
      const catName = it.product?.category?.name ?? 'Uncategorized';
      const catKey = catId ?? 'uncategorized';
      const cat = catMap.get(catKey) ?? {
        categoryId: catId,
        name: catName,
        qty: 0,
        revenue: 0,
      };
      cat.qty += Number(it.quantity);
      cat.revenue += Number(it.lineTotal);
      catMap.set(catKey, cat);

      const pKey = it.product?.id ?? it.description ?? 'item';
      const prod = productMap.get(pKey) ?? {
        productId: it.product?.id ?? null,
        name: it.product?.name ?? it.description ?? 'Item',
        sku: it.product?.skuCode ?? '—',
        qty: 0,
        revenue: 0,
      };
      prod.qty += Number(it.quantity);
      prod.revenue += Number(it.lineTotal);
      productMap.set(pKey, prod);
    }
    const byCategory = [...catMap.values()]
      .map((c) => ({ ...c, revenue: round2(c.revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
    const topProducts = [...productMap.values()]
      .map((p) => ({ ...p, revenue: round2(p.revenue) }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);

    // Cash expected from succeeded cash payments that day (per location sessions)
    const cashPaid = payments
      .filter((p) => String(p.method) === 'cash')
      .reduce((s, p) => s + Number(p.amount), 0);
    const registerReconciliation = registerSessions.map((s) => {
      const opening = Number(s.openingFloat);
      const closing = s.closingCash != null ? Number(s.closingCash) : null;
      const expectedCash = opening + cashPaid; // simplified when single-location day
      const variance =
        closing != null ? round2(closing - expectedCash) : null;
      return {
        id: s.id,
        locationId: s.locationId,
        locationName: s.location.name,
        openedBy: s.openedBy.fullName,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
        openingFloat: opening,
        closingCash: closing,
        expectedCash: round2(expectedCash),
        variance,
        status: s.closedAt ? 'closed' : 'open',
      };
    });

    const channelSplit = this.metaSplit(
      saleOrders.map((o) => ({
        meta: o.meta,
        sales: Number(o.subtotal),
      })),
      ['channel', 'source', 'orderSource'],
    );
    const fulfillmentSplit = this.metaSplit(
      saleOrders.map((o) => ({
        meta: o.meta,
        sales: Number(o.subtotal),
      })),
      ['fulfillment', 'orderType', 'serviceType'],
    );

    let tableTurnover: number | null = null;
    let avgDiningMinutes: number | null = null;
    // Use order meta signals, not hardcoded businessType, to decide whether
    // table/dining metrics are relevant. Any business that records tableNumber
    // or seatedAt in order.meta will get these analytics automatically.
    const hasTableMeta = fulfillmentSplit.some((f) =>
      /dine|table|takeaway|delivery/i.test(f.key),
    ) || saleOrders.some((o) => {
      const m = (o.meta ?? {}) as Record<string, unknown>;
      return m.tableNumber != null || m.tableId != null || m.seatedAt != null;
    });
    if (hasTableMeta) {
      const tables = new Set<string>();
      let dineMs = 0;
      let dineCount = 0;
      for (const o of saleOrders) {
        const meta = (o.meta ?? {}) as Record<string, unknown>;
        const table =
          meta.tableNumber ?? meta.tableId ?? meta.table ?? null;
        if (table != null) tables.add(String(table));
        const start = meta.seatedAt ?? meta.startedAt;
        const end = meta.closedAt ?? meta.leftAt;
        if (typeof start === 'string' && typeof end === 'string') {
          const a = Date.parse(start);
          const b = Date.parse(end);
          if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
            dineMs += b - a;
            dineCount += 1;
          }
        }
      }
      tableTurnover = tables.size || null;
      avgDiningMinutes =
        dineCount > 0 ? Math.round(dineMs / dineCount / 60000) : null;
    }

    const appointmentSummary = {
      completed:
        appointments.find((a) => a.status === AppointmentStatus.completed)
          ?._count._all ?? 0,
      noShows:
        appointments.find((a) => a.status === AppointmentStatus.no_show)
          ?._count._all ?? 0,
      scheduled:
        appointments.find((a) => a.status === AppointmentStatus.scheduled)
          ?._count._all ?? 0,
      checkedIn:
        appointments.find((a) => a.status === AppointmentStatus.checked_in)
          ?._count._all ?? 0,
      cancelled:
        appointments.find((a) => a.status === AppointmentStatus.cancelled)
          ?._count._all ?? 0,
    };

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const sortBy = query.sortBy ?? 'createdAt';
    const sortDir = query.sortDir ?? 'desc';
    const txRows = filteredOrders.map((o) => {
      const net = Number(o.subtotal) + Number(o.taxTotal);
      const tender = o.payments
        .filter((p) => p.type === PaymentType.payment)
        .map((p) => String(p.method));
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        kind: o.kind,
        status: o.status,
        createdAt: o.createdAt,
        customerName: o.customer?.fullName ?? 'Walk-in',
        cashierName: o.createdBy?.fullName ?? '—',
        locationName: o.location?.name ?? '—',
        subtotal: Number(o.subtotal),
        discountTotal: Number(o.discountTotal),
        taxTotal: Number(o.taxTotal),
        net,
        balanceDue: Number(o.balanceDue),
        paymentMethods: [...new Set(tender)],
      };
    });
    txRows.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortBy === 'orderNumber')
        return a.orderNumber.localeCompare(b.orderNumber) * dir;
      if (sortBy === 'net') return (a.net - b.net) * dir;
      if (sortBy === 'status') return a.status.localeCompare(b.status) * dir;
      return (
        (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) *
        dir
      );
    });
    const startIdx = (page - 1) * pageSize;
    const transactions = {
      page,
      pageSize,
      total: txRows.length,
      items: txRows.slice(startIdx, startIdx + pageSize).map((r) => ({
        ...r,
        subtotal: round2(r.subtotal),
        discountTotal: round2(r.discountTotal),
        taxTotal: round2(r.taxTotal),
        net: round2(r.net),
        balanceDue: round2(r.balanceDue),
      })),
    };

    return {
      date: query.date,
      timezone,
      currencyCode,
      filters: {
        locationId: query.locationId ?? null,
        employeeId: query.employeeId ?? null,
        paymentMethod: query.paymentMethod ?? null,
        registerSessionId: query.registerSessionId ?? null,
      },
      summary: totals,
      comparison: {
        previousDay: {
          date: prevDay,
          netRevenue: prevTotals.netRevenue,
          orderCount: prevTotals.orderCount,
          changePct: pctChange(totals.netRevenue, prevTotals.netRevenue),
        },
        sameDayLastWeek: {
          date: weekAgo,
          netRevenue: weekTotals.netRevenue,
          orderCount: weekTotals.orderCount,
          changePct: pctChange(totals.netRevenue, weekTotals.netRevenue),
        },
      },
      hourly,
      byPaymentMethod,
      byCategory,
      topProducts,
      registerReconciliation,
      variations: {
        channelSplit,
        fulfillmentSplit,
        tableTurnover,
        avgDiningMinutes,
        appointments: appointmentSummary,
      },
      transactions,
      registerSessions: registerSessions.map((s) => ({
        id: s.id,
        label: `${s.location.name} · ${s.openedBy.fullName} · ${s.openedAt.toISOString().slice(11, 16)}`,
        locationId: s.locationId,
        openedAt: s.openedAt,
        closedAt: s.closedAt,
      })),
    };
  }

  async salesSummary(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.buildDateFilter(query);
    const where: Prisma.OrderWhereInput = {
      tenantId: user.tenantId,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      ...(createdAt ? { createdAt } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
    };

    const [byStatus, byKind, totals] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['kind'],
        where,
        _count: { _all: true },
        _sum: { subtotal: true, taxTotal: true, balanceDue: true },
      }),
      this.prisma.order.aggregate({
        where,
        _sum: { subtotal: true, taxTotal: true, balanceDue: true },
        _count: { _all: true },
      }),
    ]);

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      locationId: query.locationId ?? null,
      byStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      byKind: byKind.map((row) => ({
        kind: row.kind,
        count: row._count._all,
        subtotal: row._sum.subtotal ?? 0,
        taxTotal: row._sum.taxTotal ?? 0,
        balanceDue: row._sum.balanceDue ?? 0,
      })),
      totals: {
        orderCount: totals._count._all,
        subtotal: totals._sum.subtotal ?? 0,
        taxTotal: totals._sum.taxTotal ?? 0,
        balanceDue: totals._sum.balanceDue ?? 0,
      },
    };
  }

  async paymentsSummary(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.buildDateFilter(query);
    const where: Prisma.PaymentWhereInput = {
      tenantId: user.tenantId,
      status: PaymentStatus.succeeded,
      ...(createdAt ? { createdAt } : {}),
      ...(query.locationId
        ? { order: { locationId: query.locationId } }
        : {}),
    };

    const byMethod = await this.prisma.payment.groupBy({
      by: ['method'],
      where,
      _sum: { amount: true },
      _count: { _all: true },
    });

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      locationId: query.locationId ?? null,
      byMethod: byMethod.map((row) => ({
        method: row.method,
        count: row._count._all,
        amount: row._sum.amount ?? 0,
      })),
    };
  }

  async inventoryUtilization(user: AuthUser, query?: DateRangeQueryDto) {
    const rows = await this.prisma.stockUnit.groupBy({
      by: ['status'],
      where: { tenantId: user.tenantId },
      _count: { _all: true },
    });

    const saleStock = await this.prisma.stockLevel.aggregate({
      where: {
        tenantId: user.tenantId,
        ...(query?.locationId ? { locationId: query.locationId } : {}),
      },
      _sum: { qtyOnHand: true },
      _count: { _all: true },
    });

    return {
      locationId: query?.locationId ?? null,
      byAvailabilityStatus: rows.map((row) => ({
        availabilityStatus: row.status,
        count: row._count._all,
      })),
      saleStock: {
        skuCount: saleStock._count._all,
        qtyOnHand: saleStock._sum.qtyOnHand ?? 0,
      },
    };
  }

  async balances(user: AuthUser, query?: DateRangeQueryDto) {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        balanceDue: { gt: 0 },
        status: { notIn: [OrderStatus.cancelled, OrderStatus.closed] },
        ...(query?.locationId ? { locationId: query.locationId } : {}),
      },
      orderBy: { balanceDue: 'desc' },
      take: 50,
      select: {
        id: true,
        orderNumber: true,
        kind: true,
        status: true,
        balanceDue: true,
        customer: { select: { id: true, fullName: true, phone: true } },
        rentalExt: {
          select: { pickupDate: true, returnDueDate: true, lifecycle: true },
        },
      },
    });

    return {
      locationId: query?.locationId ?? null,
      items: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        kind: o.kind,
        status: o.status,
        balanceDue: o.balanceDue,
        pickupDate: o.rentalExt?.pickupDate ?? null,
        returnDueDate: o.rentalExt?.returnDueDate ?? null,
        lifecycle: o.rentalExt?.lifecycle ?? null,
        customer: o.customer,
      })),
    };
  }

  /** Top / slow movers by qty sold */
  async productVelocity(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.buildDateFilter(query);
    const items = await this.prisma.orderItem.findMany({
      where: {
        order: {
          tenantId: user.tenantId,
          status: {
            notIn: [OrderStatus.cancelled, OrderStatus.draft],
          },
          ...(createdAt ? { createdAt } : {}),
          ...(query.locationId ? { locationId: query.locationId } : {}),
        },
        itemKind: OrderItemKind.product,
      },
      select: {
        quantity: true,
        lineTotal: true,
        description: true,
        product: { select: { id: true, name: true, skuCode: true } },
        stockLevel: { select: { sku: true } },
      },
    });

    const map = new Map<
      string,
      { key: string; name: string; sku: string; qty: number; revenue: number }
    >();
    for (const it of items) {
      const key =
        it.product?.id ??
        it.stockLevel?.sku ??
        it.description ??
        'unknown';
      const row = map.get(key) ?? {
        key,
        name: it.product?.name ?? it.description ?? 'Item',
        sku: it.product?.skuCode ?? it.stockLevel?.sku ?? '—',
        qty: 0,
        revenue: 0,
      };
      row.qty += Number(it.quantity);
      row.revenue += Number(it.lineTotal);
      map.set(key, row);
    }
    const ranked = [...map.values()].sort((a, b) => b.qty - a.qty);
    return {
      from: query.from ?? null,
      to: query.to ?? null,
      locationId: query.locationId ?? null,
      topMovers: ranked.slice(0, 20),
      slowMovers: [...ranked].reverse().slice(0, 20),
    };
  }

  async staffSales(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.buildDateFilter(query);
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
        ...(createdAt ? { createdAt } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        createdById: { not: null },
      },
      select: {
        createdById: true,
        subtotal: true,
        taxTotal: true,
        createdBy: { select: { fullName: true, email: true } },
      },
    });

    const map = new Map<
      string,
      {
        userId: string;
        name: string;
        email: string | null;
        orderCount: number;
        subtotal: number;
        taxTotal: number;
      }
    >();
    for (const o of orders) {
      if (!o.createdById) continue;
      const row = map.get(o.createdById) ?? {
        userId: o.createdById,
        name: o.createdBy?.fullName ?? 'Staff',
        email: o.createdBy?.email ?? null,
        orderCount: 0,
        subtotal: 0,
        taxTotal: 0,
      };
      row.orderCount += 1;
      row.subtotal += Number(o.subtotal);
      row.taxTotal += Number(o.taxTotal);
      map.set(o.createdById, row);
    }

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      locationId: query.locationId ?? null,
      staff: [...map.values()].sort((a, b) => b.subtotal - a.subtotal),
    };
  }

  async taxSummary(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.buildDateFilter(query);
    const where: Prisma.OrderWhereInput = {
      tenantId: user.tenantId,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      ...(createdAt ? { createdAt } : {}),
      ...(query.locationId ? { locationId: query.locationId } : {}),
    };

    const totals = await this.prisma.order.aggregate({
      where,
      _sum: { taxTotal: true, subtotal: true },
      _count: { _all: true },
    });

    const invoices = await this.prisma.invoice.aggregate({
      where: {
        tenantId: user.tenantId,
        ...(createdAt ? { createdAt } : {}),
      },
      _sum: { cgst: true, sgst: true, igst: true, grandTotal: true },
      _count: { _all: true },
    });

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      locationId: query.locationId ?? null,
      orders: {
        count: totals._count._all,
        subtotal: totals._sum.subtotal ?? 0,
        taxTotal: totals._sum.taxTotal ?? 0,
      },
      invoices: {
        count: invoices._count._all,
        cgst: invoices._sum.cgst ?? 0,
        sgst: invoices._sum.sgst ?? 0,
        igst: invoices._sum.igst ?? 0,
        grandTotal: invoices._sum.grandTotal ?? 0,
      },
    };
  }

  private buildDateFilter(
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

  private dailyOrderWhere(
    tenantId: string,
    day: { start: Date; end: Date },
    query: DailySalesQueryDto,
    registerWindow: { gte: Date; lte: Date } | null,
  ): Prisma.OrderWhereInput {
    return {
      tenantId,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      createdAt: registerWindow
        ? { gte: registerWindow.gte, lte: registerWindow.lte }
        : { gte: day.start, lte: day.end },
      ...(query.locationId ? { locationId: query.locationId } : {}),
      ...(query.employeeId ? { createdById: query.employeeId } : {}),
      ...(query.paymentMethod
        ? {
            payments: {
              some: {
                status: PaymentStatus.succeeded,
                type: PaymentType.payment,
                method: query.paymentMethod as never,
              },
            },
          }
        : {}),
    };
  }

  private async periodTotals(
    tenantId: string,
    where: Prisma.OrderWhereInput,
  ): Promise<MoneyTotals> {
    const [agg, refunds] = await Promise.all([
      this.prisma.order.aggregate({
        where,
        _sum: { subtotal: true, discountTotal: true, taxTotal: true },
        _count: { _all: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          tenantId,
          status: PaymentStatus.succeeded,
          type: { in: [PaymentType.refund, PaymentType.deposit_refund] },
          ...(where.createdAt
            ? { createdAt: where.createdAt as Prisma.DateTimeFilter }
            : {}),
          ...(typeof where.locationId === 'string'
            ? { order: { locationId: where.locationId } }
            : {}),
        },
        _sum: { amount: true },
      }),
    ]);
    return this.computeTotals(
      [
        {
          subtotal: Number(agg._sum.subtotal ?? 0),
          discountTotal: Number(agg._sum.discountTotal ?? 0),
          taxTotal: Number(agg._sum.taxTotal ?? 0),
          __count: agg._count._all,
        },
      ],
      Number(refunds._sum.amount ?? 0),
      true,
    );
  }

  private computeTotals(
    rows: Array<{
      subtotal: number;
      discountTotal: number;
      taxTotal: number;
      __count?: number;
    }>,
    refunds: number,
    aggregated = false,
  ): MoneyTotals {
    let orderCount = 0;
    let subtotal = 0;
    let discounts = 0;
    let tax = 0;
    if (aggregated && rows.length === 1 && rows[0].__count != null) {
      orderCount = rows[0].__count;
      subtotal = rows[0].subtotal;
      discounts = rows[0].discountTotal;
      tax = rows[0].taxTotal;
    } else {
      orderCount = rows.length;
      for (const r of rows) {
        subtotal += r.subtotal;
        discounts += r.discountTotal;
        tax += r.taxTotal;
      }
    }
    const grossSales = subtotal + discounts;
    const netSales = subtotal;
    const refundAbs = Math.abs(refunds);
    const netRevenue = netSales + tax - refundAbs;
    return {
      orderCount,
      grossSales: round2(grossSales),
      discounts: round2(discounts),
      tax: round2(tax),
      netSales: round2(netSales),
      refunds: round2(refundAbs),
      netRevenue: round2(netRevenue),
      avgOrderValue: orderCount ? round2(netSales / orderCount) : 0,
    };
  }

  /** Calendar day bounds in tenant timezone → UTC Date range */
  private dayRange(ymd: string, timeZone: string): { start: Date; end: Date } {
    const start = zonedLocalToUtc(ymd, 0, 0, 0, 0, timeZone);
    const end = zonedLocalToUtc(ymd, 23, 59, 59, 999, timeZone);
    return { start, end };
  }

  private shiftYmd(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  private hourInZone(date: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    return hour === 24 ? 0 : hour;
  }

  private metaSplit(
    orders: Array<{ meta: unknown; sales: number }>,
    keys: string[],
  ): Array<{ key: string; count: number; sales: number }> {
    const map = new Map<string, { count: number; sales: number }>();
    for (const o of orders) {
      const meta = (o.meta ?? {}) as Record<string, unknown>;
      let val: string | null = null;
      for (const k of keys) {
        if (meta[k] != null && String(meta[k]).trim()) {
          val = String(meta[k]).trim().toLowerCase();
          break;
        }
      }
      if (!val) continue;
      const row = map.get(val) ?? { count: 0, sales: 0 };
      row.count += 1;
      row.sales += o.sales;
      map.set(val, row);
    }
    return [...map.entries()]
      .map(([key, v]) => ({
        key,
        count: v.count,
        sales: round2(v.sales),
      }))
      .sort((a, b) => b.count - a.count);
  }
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function pctChange(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return round2(((current - baseline) / Math.abs(baseline)) * 100);
}

/**
 * Convert a local wall-clock time in `timeZone` on calendar day `ymd` to UTC Date.
 */
function zonedLocalToUtc(
  ymd: string,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const [y, mo, d] = ymd.split('-').map(Number);
  // Guess UTC then correct using timezone offset at that instant
  let utc = Date.UTC(y, mo - 1, d, hour, minute, second, ms);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utc));
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') === 24 ? 0 : get('hour'),
      get('minute'),
      get('second'),
    );
    const target = Date.UTC(y, mo - 1, d, hour, minute, second, ms);
    utc += target - asUtc;
  }
  return new Date(utc);
}
