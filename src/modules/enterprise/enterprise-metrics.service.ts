import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  OrderKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { hasEntitlement } from '../../common/entitlements';
import { PrismaService } from '../../database/database.module';
import { ymdInZone, zonedLocalToUtc, round2 } from '../reports/reports.util';
import {
  canSeeGroupFinance,
  type EnterprisePrincipal,
} from './enterprise.types';

export type MetricsQuery = {
  from?: string;
  to?: string;
  tenantId?: string;
  locationId?: string;
  region?: string;
  categoryId?: string;
  employeeId?: string;
  tender?: string;
};

@Injectable()
export class EnterpriseMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  private async tenantScope(p: EnterprisePrincipal, query: MetricsQuery) {
    const all = await this.prisma.tenant.findMany({
      where: {
        businessGroupId: p.groupId,
        status: 'active',
        ...(query.tenantId ? { id: query.tenantId } : {}),
      },
      select: {
        id: true,
        name: true,
        timezone: true,
        currencyCode: true,
        settings: true,
      },
    });
    const allowed =
      p.groupRole === 'owner' || p.groupRole === 'finance'
        ? all
        : all.filter((t) => p.tenantIds.includes(t.id));
    if (query.tenantId && !allowed.some((t) => t.id === query.tenantId)) {
      throw new ForbiddenException('No access to this business');
    }
    return allowed;
  }

  private range(query: MetricsQuery, timezone: string) {
    const today = ymdInZone(new Date(), timezone);
    const fromYmd = query.from || `${today.slice(0, 7)}-01`;
    const toYmd = query.to || today;
    return {
      fromYmd,
      toYmd,
      start: zonedLocalToUtc(fromYmd, 0, 0, 0, 0, timezone),
      end: zonedLocalToUtc(toYmd, 23, 59, 59, 999, timezone),
    };
  }

  async dashboard(p: EnterprisePrincipal, query: MetricsQuery) {
    if (!hasEntitlement(p.entitlements, 'GROUP_DASHBOARD')) {
      throw new ForbiddenException('GROUP_DASHBOARD entitlement required');
    }
    const tenants = await this.tenantScope(p, query);
    const tz = tenants[0]?.timezone || 'Asia/Kolkata';
    const today = ymdInZone(new Date(), tz);
    const yestDate = new Date();
    yestDate.setDate(yestDate.getDate() - 1);
    const yesterday = ymdInZone(yestDate, tz);
    const mtdFrom = `${today.slice(0, 7)}-01`;
    const ytdFrom = `${today.slice(0, 4)}-01-01`;

    const ids = tenants.map((t) => t.id);
    const locFilter = await this.locationFilter(ids, query);

    const [todayS, yestS, mtd, ytd, expenses, cogsMtd, cash, uncleared, ar, ap, inv, tax, low, dead] =
      await Promise.all([
        this.salesSum(ids, locFilter, this.day(today, tz), query),
        this.salesSum(ids, locFilter, this.day(yesterday, tz), query),
        this.salesSum(ids, locFilter, this.range({ from: mtdFrom, to: today }, tz), query),
        this.salesSum(ids, locFilter, this.range({ from: ytdFrom, to: today }, tz), query),
        this.expenseSum(ids, locFilter, this.range({ from: mtdFrom, to: today }, tz)),
        this.cogsSum(ids, locFilter, this.range({ from: mtdFrom, to: today }, tz)),
        this.cashOnHand(ids, locFilter),
        this.unclearedPayments(ids, locFilter),
        this.arSum(ids, locFilter),
        this.apSum(ids),
        this.inventoryValue(ids, locFilter),
        this.taxAccrued(ids, locFilter, this.range({ from: mtdFrom, to: today }, tz)),
        this.lowStockCount(ids, locFilter),
        this.deadStockCount(ids, locFilter),
      ]);

    const grossProfit = round2(mtd.netSales - cogsMtd);
    const netProfit = round2(grossProfit - expenses);
    const margin = mtd.netSales > 0 ? round2((grossProfit / mtd.netSales) * 100) : null;

    const movers = await this.movers(ids, locFilter, this.range({ from: mtdFrom, to: today }, tz));

    return {
      timezone: tz,
      currencyCode: tenants[0]?.currencyCode ?? 'INR',
      period: { mtdFrom, today },
      kpis: {
        todaySales: todayS.netSales,
        yesterdaySales: yestS.netSales,
        mtdSales: mtd.netSales,
        ytdSales: ytd.netSales,
        grossProfit,
        grossMarginPct: margin,
        expenses,
        netProfit,
        cash: cash,
        unclearedPayments: uncleared,
        accountsReceivable: ar,
        accountsPayable: ap,
        inventoryValue: inv.value,
        taxAccrued: tax,
        lowStock: low,
        deadStock: dead,
        fastMoving: movers.fast,
        slowMoving: movers.slow,
      },
      businesses: tenants.length,
    };
  }

  async groupPnl(p: EnterprisePrincipal, query: MetricsQuery) {
    if (!hasEntitlement(p.entitlements, 'GROUP_PNL')) {
      throw new ForbiddenException('GROUP_PNL entitlement required');
    }
    if (!canSeeGroupFinance(p)) {
      throw new ForbiddenException('Finance access required for group P&L');
    }
    const tenants = await this.tenantScope(p, query);
    const tz = tenants[0]?.timezone || 'Asia/Kolkata';
    const range = this.range(query, tz);
    const ids = tenants.map((t) => t.id);
    const locFilter = await this.locationFilter(ids, query);

    const rows = [];
    for (const t of tenants) {
      const loc = query.locationId
        ? locFilter
        : await this.locationFilter([t.id], query);
      const sales = await this.salesSum([t.id], loc, range, query);
      const cogs = await this.cogsSum([t.id], loc, range);
      const opex = await this.expenseSum([t.id], loc, range);
      const gross = round2(sales.netSales - cogs);
      rows.push({
        tenantId: t.id,
        name: t.name,
        revenue: sales.netSales,
        cogs,
        grossProfit: gross,
        grossMarginPct:
          sales.netSales > 0 ? round2((gross / sales.netSales) * 100) : null,
        expenses: opex,
        netProfit: round2(gross - opex),
      });
    }
    const totals = rows.reduce(
      (a, r) => ({
        revenue: a.revenue + r.revenue,
        cogs: a.cogs + r.cogs,
        grossProfit: a.grossProfit + r.grossProfit,
        expenses: a.expenses + r.expenses,
        netProfit: a.netProfit + r.netProfit,
      }),
      { revenue: 0, cogs: 0, grossProfit: 0, expenses: 0, netProfit: 0 },
    );
    return {
      note: 'Reporting rollup only — legal books stay per tenant.',
      period: { from: range.fromYmd, to: range.toYmd },
      group: {
        ...totals,
        grossMarginPct:
          totals.revenue > 0
            ? round2((totals.grossProfit / totals.revenue) * 100)
            : null,
      },
      businesses: rows,
    };
  }

  async comparison(p: EnterprisePrincipal, query: MetricsQuery) {
    if (!hasEntitlement(p.entitlements, 'BUSINESS_COMPARISON')) {
      throw new ForbiddenException('BUSINESS_COMPARISON entitlement required');
    }
    if (!canSeeGroupFinance(p)) {
      throw new ForbiddenException('Finance access required');
    }
    const pnl = await this.groupPnl(p, query);
    const tenants = await this.tenantScope(p, query);
    const ids = tenants.map((t) => t.id);
    const locFilter = await this.locationFilter(ids, query);
    const [inv, cash, ar, ap] = await Promise.all([
      this.inventoryValueByTenant(ids, locFilter),
      this.cashByTenant(ids, locFilter),
      this.arByTenant(ids, locFilter),
      this.apByTenant(ids),
    ]);
    const prev = await this.groupPnl(p, {
      ...query,
      from: this.shiftPeriod(query.from, query.to, tenants[0]?.timezone).from,
      to: this.shiftPeriod(query.from, query.to, tenants[0]?.timezone).to,
    });
    const prevMap = new Map(prev.businesses.map((b) => [b.tenantId, b.netProfit]));
    const rows = pnl.businesses.map((b) => {
      const prevNet = prevMap.get(b.tenantId) ?? 0;
      return {
        ...b,
        inventoryValue: inv.get(b.tenantId) ?? 0,
        cash: cash.get(b.tenantId) ?? 0,
        ar: ar.get(b.tenantId) ?? 0,
        ap: ap.get(b.tenantId) ?? 0,
        growth:
          prevNet === 0
            ? b.netProfit === 0
              ? 0
              : null
            : round2(((b.netProfit - prevNet) / Math.abs(prevNet)) * 100),
      };
    });
    return { period: pnl.period, rows };
  }

  async drillOrders(
    p: EnterprisePrincipal,
    tenantId: string,
    query: MetricsQuery & { page?: number; limit?: number },
  ) {
    if (!canSeeGroupFinance(p) && !p.tenantIds.includes(tenantId)) {
      throw new ForbiddenException('No access to this business');
    }
    await this.tenantScope(p, { tenantId });
    const tz = 'Asia/Kolkata';
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const range = this.range(query, tenant?.timezone || tz);
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 25));
    const where: Prisma.OrderWhereInput = {
      tenantId,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      createdAt: { gte: range.start, lte: range.end },
      ...(query.locationId ? { locationId: query.locationId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          orderNumber: true,
          createdAt: true,
          subtotal: true,
          taxTotal: true,
          discountTotal: true,
          balanceDue: true,
          status: true,
          locationId: true,
          createdById: true,
          location: { select: { name: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);
    return {
      tenantId,
      items,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  private day(ymd: string, tz: string) {
    return this.range({ from: ymd, to: ymd }, tz);
  }

  private shiftPeriod(from: string | undefined, to: string | undefined, tz?: string) {
    const timezone = tz || 'Asia/Kolkata';
    const range = this.range({ from, to }, timezone);
    const ms = range.end.getTime() - range.start.getTime();
    const prevEnd = new Date(range.start.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - ms);
    return {
      from: ymdInZone(prevStart, timezone),
      to: ymdInZone(prevEnd, timezone),
    };
  }

  private async locationFilter(tenantIds: string[], query: MetricsQuery) {
    if (query.locationId) return [query.locationId];
    if (!query.region) return [] as string[];
    const locs = await this.prisma.location.findMany({
      where: {
        tenantId: { in: tenantIds },
        regionCode: query.region,
        isActive: true,
      },
      select: { id: true },
    });
    return locs.map((l) => l.id);
  }

  private orderWhere(
    tenantIds: string[],
    locIds: string[],
    range: { start: Date; end: Date },
    query: MetricsQuery,
  ): Prisma.OrderWhereInput {
    return {
      tenantId: { in: tenantIds },
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      kind: { not: OrderKind.return_order },
      createdAt: { gte: range.start, lte: range.end },
      ...(locIds.length ? { locationId: { in: locIds } } : {}),
      ...(query.employeeId ? { createdById: query.employeeId } : {}),
    };
  }

  private async salesSum(
    tenantIds: string[],
    locIds: string[],
    range: { start: Date; end: Date },
    query: MetricsQuery,
  ) {
    if (!tenantIds.length) return { netSales: 0, discounts: 0 };
    const where = this.orderWhere(tenantIds, locIds, range, query);
    const [sales, refunds] = await Promise.all([
      this.prisma.order.aggregate({
        where,
        _sum: { subtotal: true, discountTotal: true, taxTotal: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          tenantId: { in: tenantIds },
          status: PaymentStatus.succeeded,
          type: { in: [PaymentType.refund, PaymentType.deposit_refund] },
          createdAt: { gte: range.start, lte: range.end },
        },
        _sum: { amount: true },
      }),
    ]);
    const net = round2(
      Number(sales._sum.subtotal ?? 0) - Number(refunds._sum.amount ?? 0),
    );
    return {
      netSales: net,
      discounts: round2(Number(sales._sum.discountTotal ?? 0)),
    };
  }

  private async cogsSum(
    tenantIds: string[],
    locIds: string[],
    range: { start: Date; end: Date },
  ) {
    if (!tenantIds.length) return 0;
    const locSql = locIds.length
      ? Prisma.sql`AND o.location_id IN (${Prisma.join(locIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ cogs: Prisma.Decimal }>>`
      SELECT COALESCE(SUM(oi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.tenant_id IN (${Prisma.join(tenantIds)})
        AND o.status NOT IN ('cancelled', 'draft')
        AND o.kind <> 'return_order'
        AND o.created_at >= ${range.start}
        AND o.created_at <= ${range.end}
        ${locSql}
    `;
    return round2(Number(rows[0]?.cogs ?? 0));
  }

  private async expenseSum(
    tenantIds: string[],
    locIds: string[],
    range: { start: Date; end: Date },
  ) {
    if (!tenantIds.length) return 0;
    const agg = await this.prisma.expense.aggregate({
      where: {
        tenantId: { in: tenantIds },
        status: 'approved',
        spentAt: { gte: range.start, lte: range.end },
        ...(locIds.length ? { locationId: { in: locIds } } : {}),
      },
      _sum: { amount: true },
    });
    return round2(Number(agg._sum.amount ?? 0));
  }

  private async cashOnHand(tenantIds: string[], locIds: string[]) {
    const open = await this.prisma.registerSession.aggregate({
      where: {
        tenantId: { in: tenantIds },
        closedAt: null,
        ...(locIds.length ? { locationId: { in: locIds } } : {}),
      },
      _sum: { openingFloat: true },
    });
    const cashPays = await this.prisma.payment.aggregate({
      where: {
        tenantId: { in: tenantIds },
        status: PaymentStatus.succeeded,
        method: PaymentMethod.cash,
        registerSession: { closedAt: null },
      },
      _sum: { amount: true },
    });
    return round2(
      Number(open._sum.openingFloat ?? 0) + Number(cashPays._sum.amount ?? 0),
    );
  }

  private async unclearedPayments(tenantIds: string[], _locIds: string[]) {
    const agg = await this.prisma.payment.aggregate({
      where: {
        tenantId: { in: tenantIds },
        status: { in: [PaymentStatus.pending, PaymentStatus.processing] },
      },
      _sum: { amount: true },
    });
    return round2(Number(agg._sum.amount ?? 0));
  }

  private async arSum(tenantIds: string[], locIds: string[]) {
    const agg = await this.prisma.order.aggregate({
      where: {
        tenantId: { in: tenantIds },
        status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
        balanceDue: { gt: 0 },
        ...(locIds.length ? { locationId: { in: locIds } } : {}),
      },
      _sum: { balanceDue: true },
    });
    return round2(Number(agg._sum.balanceDue ?? 0));
  }

  private async apSum(tenantIds: string[]) {
    const agg = await this.prisma.supplierInvoice.aggregate({
      where: {
        tenantId: { in: tenantIds },
        status: { in: ['open', 'partial'] },
      },
      _sum: { grandTotal: true, amountPaid: true },
    });
    return round2(
      Number(agg._sum.grandTotal ?? 0) - Number(agg._sum.amountPaid ?? 0),
    );
  }

  private async inventoryValue(tenantIds: string[], locIds: string[]) {
    if (!tenantIds.length) return { value: 0, qty: 0 };
    const locSql = locIds.length
      ? Prisma.sql`AND sl.location_id IN (${Prisma.join(locIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{ value: Prisma.Decimal; qty: Prisma.Decimal }>
    >`
      SELECT
        COALESCE(SUM(sl.qty_on_hand * COALESCE(p.cost_price, 0)), 0) AS value,
        COALESCE(SUM(sl.qty_on_hand), 0) AS qty
      FROM stock_levels sl
      JOIN products p ON p.id = sl.product_id
      WHERE sl.tenant_id IN (${Prisma.join(tenantIds)})
        ${locSql}
    `;
    return {
      value: round2(Number(rows[0]?.value ?? 0)),
      qty: Number(rows[0]?.qty ?? 0),
    };
  }

  private async taxAccrued(
    tenantIds: string[],
    locIds: string[],
    range: { start: Date; end: Date },
  ) {
    const agg = await this.prisma.order.aggregate({
      where: this.orderWhere(tenantIds, locIds, range, {}),
      _sum: { taxTotal: true },
    });
    return round2(Number(agg._sum.taxTotal ?? 0));
  }

  private async lowStockCount(tenantIds: string[], locIds: string[]) {
    if (!tenantIds.length) return 0;
    const locSql = locIds.length
      ? Prisma.sql`AND location_id IN (${Prisma.join(locIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM stock_levels sl
      WHERE sl.tenant_id IN (${Prisma.join(tenantIds)})
        AND sl.reorder_point IS NOT NULL
        AND sl.qty_on_hand <= sl.reorder_point
        ${locSql}
    `;
    return Number(rows[0]?.n ?? 0);
  }

  private async deadStockCount(tenantIds: string[], locIds: string[]) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const recent = await this.prisma.orderItem.findMany({
      where: {
        tenantId: { in: tenantIds },
        createdAt: { gte: cutoff },
        productId: { not: null },
      },
      select: { productId: true },
      distinct: ['productId'],
      take: 5000,
    });
    const sold = new Set(recent.map((r) => r.productId).filter(Boolean));
    const levels = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: { in: tenantIds },
        qtyOnHand: { gt: 0 },
        ...(locIds.length ? { locationId: { in: locIds } } : {}),
      },
      select: { productId: true },
      take: 8000,
    });
    return levels.filter((l) => !sold.has(l.productId)).length;
  }

  private async movers(
    tenantIds: string[],
    locIds: string[],
    range: { start: Date; end: Date },
  ) {
    const grouped = await this.prisma.orderItem.groupBy({
      by: ['productId'],
      where: {
        tenantId: { in: tenantIds },
        productId: { not: null },
        order: {
          createdAt: { gte: range.start, lte: range.end },
          status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
          ...(locIds.length ? { locationId: { in: locIds } } : {}),
        },
      },
      _sum: { quantity: true },
    });
    const sorted = grouped
      .filter((g) => g.productId)
      .sort((a, b) => Number(b._sum.quantity ?? 0) - Number(a._sum.quantity ?? 0));
    return {
      fast: sorted.slice(0, 5).length,
      slow: sorted.filter((g) => Number(g._sum.quantity ?? 0) <= 1).length,
    };
  }

  private async inventoryValueByTenant(tenantIds: string[], locIds: string[]) {
    if (!tenantIds.length) return new Map();
    const locSql = locIds.length
      ? Prisma.sql`AND sl.location_id IN (${Prisma.join(locIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{ tenant_id: string; value: Prisma.Decimal }>
    >`
      SELECT sl.tenant_id, COALESCE(SUM(sl.qty_on_hand * COALESCE(p.cost_price, 0)), 0) AS value
      FROM stock_levels sl
      JOIN products p ON p.id = sl.product_id
      WHERE sl.tenant_id IN (${Prisma.join(tenantIds)})
        ${locSql}
      GROUP BY sl.tenant_id
    `;
    return new Map(rows.map((r) => [r.tenant_id, round2(Number(r.value))]));
  }

  private async cashByTenant(tenantIds: string[], locIds: string[]) {
    const sessions = await this.prisma.registerSession.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { in: tenantIds },
        closedAt: null,
        ...(locIds.length ? { locationId: { in: locIds } } : {}),
      },
      _sum: { openingFloat: true },
    });
    return new Map(
      sessions.map((s) => [s.tenantId, round2(Number(s._sum.openingFloat ?? 0))]),
    );
  }

  private async arByTenant(tenantIds: string[], locIds: string[]) {
    const rows = await this.prisma.order.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { in: tenantIds },
        balanceDue: { gt: 0 },
        status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
        ...(locIds.length ? { locationId: { in: locIds } } : {}),
      },
      _sum: { balanceDue: true },
    });
    return new Map(
      rows.map((r) => [r.tenantId, round2(Number(r._sum.balanceDue ?? 0))]),
    );
  }

  private async apByTenant(tenantIds: string[]) {
    const rows = await this.prisma.supplierInvoice.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { in: tenantIds },
        status: { in: ['open', 'partial'] },
      },
      _sum: { grandTotal: true, amountPaid: true },
    });
    return new Map(
      rows.map((r) => [
        r.tenantId,
        round2(Number(r._sum.grandTotal ?? 0) - Number(r._sum.amountPaid ?? 0)),
      ]),
    );
  }
}
