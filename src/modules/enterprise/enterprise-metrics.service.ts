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

type KpiBlock = {
  todaySales: number;
  yesterdaySales: number;
  mtdSales: number;
  ytdSales: number;
  grossProfit: number;
  grossMarginPct: number | null;
  expenses: number;
  netProfit: number;
  cash: number;
  unclearedPayments: number;
  accountsReceivable: number;
  accountsPayable: number;
  inventoryValue: number;
  taxAccrued: number;
  lowStock: number;
  deadStock: number;
  fastMoving: number;
  slowMoving: number;
};

type BusinessRow = {
  tenantId: string;
  name: string;
  currencyCode: string;
  timezone: string;
  todaySales: number;
  yesterdaySales: number;
  periodSales: number;
  mtdSales: number;
  ytdSales: number;
  grossProfit: number;
  expenses: number;
  netProfit: number;
  cash: number;
  unclearedPayments: number;
  accountsReceivable: number;
  accountsPayable: number;
  inventoryValue: number;
  taxAccrued: number;
  lowStock: number;
  deadStock: number;
  fastMoving: number;
  slowMoving: number;
  period: { from: string; to: string };
};

type PnlRow = {
  tenantId: string;
  name: string;
  currencyCode: string;
  timezone: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  grossMarginPct: number | null;
  expenses: number;
  netProfit: number;
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
      p.groupRole === 'owner' ||
      p.groupRole === 'finance' ||
      p.groupRole === 'auditor'
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

  private emptyKpis(): KpiBlock {
    return {
      todaySales: 0,
      yesterdaySales: 0,
      mtdSales: 0,
      ytdSales: 0,
      grossProfit: 0,
      grossMarginPct: null,
      expenses: 0,
      netProfit: 0,
      cash: 0,
      unclearedPayments: 0,
      accountsReceivable: 0,
      accountsPayable: 0,
      inventoryValue: 0,
      taxAccrued: 0,
      lowStock: 0,
      deadStock: 0,
      fastMoving: 0,
      slowMoving: 0,
    };
  }

  private aggregateBusinessKpis(
    rows: Array<
      Pick<
        BusinessRow,
        | 'todaySales'
        | 'yesterdaySales'
        | 'periodSales'
        | 'mtdSales'
        | 'ytdSales'
        | 'grossProfit'
        | 'expenses'
        | 'netProfit'
        | 'cash'
        | 'unclearedPayments'
        | 'accountsReceivable'
        | 'accountsPayable'
        | 'inventoryValue'
        | 'taxAccrued'
        | 'lowStock'
        | 'deadStock'
        | 'fastMoving'
        | 'slowMoving'
      >
    >,
  ): KpiBlock {
    const sum = (fn: (r: (typeof rows)[number]) => number) =>
      round2(rows.reduce((a, r) => a + fn(r), 0));
    const periodSales = sum((r) => r.periodSales);
    const grossProfit = sum((r) => r.grossProfit);
    return {
      todaySales: sum((r) => r.todaySales),
      yesterdaySales: sum((r) => r.yesterdaySales),
      mtdSales: sum((r) => r.mtdSales),
      ytdSales: sum((r) => r.ytdSales),
      grossProfit,
      grossMarginPct:
        periodSales > 0 ? round2((grossProfit / periodSales) * 100) : null,
      expenses: sum((r) => r.expenses),
      netProfit: sum((r) => r.netProfit),
      cash: sum((r) => r.cash),
      unclearedPayments: sum((r) => r.unclearedPayments),
      accountsReceivable: sum((r) => r.accountsReceivable),
      accountsPayable: sum((r) => r.accountsPayable),
      inventoryValue: sum((r) => r.inventoryValue),
      taxAccrued: sum((r) => r.taxAccrued),
      lowStock: sum((r) => r.lowStock),
      deadStock: sum((r) => r.deadStock),
      fastMoving: sum((r) => r.fastMoving),
      slowMoving: sum((r) => r.slowMoving),
    };
  }

  private aggregatePnl(rows: PnlRow[]) {
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
      revenue: round2(totals.revenue),
      cogs: round2(totals.cogs),
      grossProfit: round2(totals.grossProfit),
      expenses: round2(totals.expenses),
      netProfit: round2(totals.netProfit),
      grossMarginPct:
        totals.revenue > 0
          ? round2((totals.grossProfit / totals.revenue) * 100)
          : null,
    };
  }

  async dashboard(p: EnterprisePrincipal, query: MetricsQuery) {
    if (!hasEntitlement(p.entitlements, 'GROUP_DASHBOARD')) {
      throw new ForbiddenException('GROUP_DASHBOARD entitlement required');
    }
    const tenants = await this.tenantScope(p, query);
    if (!tenants.length) {
      return {
        mixedCurrency: false,
        currencies: [] as string[],
        currencyCode: null as string | null,
        timezone: 'Asia/Kolkata',
        period: null as { mtdFrom: string; today: string; custom: boolean } | null,
        note: 'No businesses in scope.',
        kpis: null as Record<string, number | null> | null,
        byCurrency: [] as Array<{
          currencyCode: string;
          kpis: Record<string, number | null>;
        }>,
        businesses: [] as unknown[],
        businessCount: 0,
      };
    }

    const customPeriod = Boolean(query.from || query.to);
    const rows = await Promise.all(
      tenants.map(async (t) => {
        const tz = t.timezone || 'Asia/Kolkata';
        const today = ymdInZone(new Date(), tz);
        const yesterday = this.addCalendarDays(today, -1);
        const mtdFrom = `${today.slice(0, 7)}-01`;
        const ytdFrom = `${today.slice(0, 4)}-01-01`;
        const periodFrom = query.from || mtdFrom;
        const periodTo = query.to || today;
        const period = this.range({ from: periodFrom, to: periodTo }, tz);
        const loc = await this.locationFilter([t.id], query);

        const [
          todayS,
          yestS,
          periodSales,
          ytd,
          expenses,
          cogs,
          cash,
          uncleared,
          ar,
          ap,
          inv,
          tax,
          low,
          dead,
          movers,
        ] = await Promise.all([
          this.salesSum([t.id], loc, this.day(today, tz), query),
          this.salesSum([t.id], loc, this.day(yesterday, tz), query),
          this.salesSum([t.id], loc, period, query),
          this.salesSum(
            [t.id],
            loc,
            this.range({ from: ytdFrom, to: today }, tz),
            query,
          ),
          this.expenseSum([t.id], loc, period),
          this.cogsSum([t.id], loc, period),
          this.cashOnHand([t.id], loc),
          this.unclearedPayments([t.id], loc),
          this.arSum([t.id], loc),
          this.apSum([t.id]),
          this.inventoryValue([t.id], loc),
          this.taxAccrued([t.id], loc, period),
          this.lowStockCount([t.id], loc),
          this.deadStockCount([t.id], loc),
          this.movers([t.id], loc, period),
        ]);

        const grossProfit = round2(periodSales.netSales - cogs);
        const netProfit = round2(grossProfit - expenses);
        return {
          tenantId: t.id,
          name: t.name,
          currencyCode: t.currencyCode || 'INR',
          timezone: tz,
          todaySales: todayS.netSales,
          yesterdaySales: yestS.netSales,
          periodSales: periodSales.netSales,
          mtdSales: periodSales.netSales,
          ytdSales: ytd.netSales,
          grossProfit,
          expenses,
          netProfit,
          cash,
          unclearedPayments: uncleared,
          accountsReceivable: ar,
          accountsPayable: ap,
          inventoryValue: inv.value,
          taxAccrued: tax,
          lowStock: low,
          deadStock: dead,
          fastMoving: movers.fast,
          slowMoving: movers.slow,
          period: { from: periodFrom, to: periodTo },
        };
      }),
    );

    const currencies = [
      ...new Set(rows.map((r) => r.currencyCode).filter(Boolean)),
    ];
    const mixedCurrency = currencies.length > 1;

    const byCurrency = currencies.map((currencyCode) => {
      const subset = rows.filter((r) => r.currencyCode === currencyCode);
      const sum = (key: keyof (typeof rows)[0]) =>
        round2(subset.reduce((a, r) => a + Number(r[key] ?? 0), 0));
      const periodSales = sum('periodSales');
      const grossProfit = sum('grossProfit');
      const expenses = sum('expenses');
      return {
        currencyCode,
        kpis: {
          todaySales: sum('todaySales'),
          yesterdaySales: sum('yesterdaySales'),
          mtdSales: periodSales,
          ytdSales: sum('ytdSales'),
          grossProfit,
          grossMarginPct:
            periodSales > 0 ? round2((grossProfit / periodSales) * 100) : null,
          expenses,
          netProfit: round2(grossProfit - expenses),
          cash: sum('cash'),
          unclearedPayments: sum('unclearedPayments'),
          accountsReceivable: sum('accountsReceivable'),
          accountsPayable: sum('accountsPayable'),
          inventoryValue: sum('inventoryValue'),
          taxAccrued: sum('taxAccrued'),
          lowStock: sum('lowStock'),
          deadStock: sum('deadStock'),
          fastMoving: sum('fastMoving'),
          slowMoving: sum('slowMoving'),
        },
      };
    });

    const primaryTz = tenants[0]?.timezone || 'Asia/Kolkata';
    const anchorToday = ymdInZone(new Date(), primaryTz);

    return {
      mixedCurrency,
      currencies,
      currencyCode: mixedCurrency ? null : (currencies[0] ?? null),
      timezone: primaryTz,
      period: {
        mtdFrom: query.from || `${anchorToday.slice(0, 7)}-01`,
        today: query.to || anchorToday,
        custom: customPeriod,
      },
      note: mixedCurrency
        ? 'Mixed currencies — totals are shown per currency. Never summed across FX.'
        : customPeriod
          ? 'Period metrics use each shop’s local calendar; legal books stay per tenant.'
          : 'Each shop’s today/MTD uses its own timezone. Reporting rollup only.',
      kpis: mixedCurrency ? null : (byCurrency[0]?.kpis ?? null),
      byCurrency,
      businesses: rows,
      businessCount: rows.length,
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
    const rows: Array<{
      tenantId: string;
      name: string;
      currencyCode: string;
      timezone: string;
      revenue: number;
      cogs: number;
      grossProfit: number;
      grossMarginPct: number | null;
      expenses: number;
      netProfit: number;
      period: { from: string; to: string };
    }> = [];
    for (const t of tenants) {
      const tz = t.timezone || 'Asia/Kolkata';
      const range = this.range(query, tz);
      const loc = await this.locationFilter([t.id], query);
      const sales = await this.salesSum([t.id], loc, range, query);
      const cogs = await this.cogsSum([t.id], loc, range);
      const opex = await this.expenseSum([t.id], loc, range);
      const gross = round2(sales.netSales - cogs);
      rows.push({
        tenantId: t.id,
        name: t.name,
        currencyCode: t.currencyCode || 'INR',
        timezone: tz,
        revenue: sales.netSales,
        cogs,
        grossProfit: gross,
        grossMarginPct:
          sales.netSales > 0 ? round2((gross / sales.netSales) * 100) : null,
        expenses: opex,
        netProfit: round2(gross - opex),
        period: { from: range.fromYmd, to: range.toYmd },
      });
    }

    const currencies = [
      ...new Set(rows.map((r) => r.currencyCode).filter(Boolean)),
    ];
    const mixedCurrency = currencies.length > 1;

    const byCurrency = currencies.map((currencyCode) => {
      const subset = rows.filter((r) => r.currencyCode === currencyCode);
      const totals = subset.reduce(
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
        currencyCode,
        ...totals,
        grossMarginPct:
          totals.revenue > 0
            ? round2((totals.grossProfit / totals.revenue) * 100)
            : null,
      };
    });

    const tz = tenants[0]?.timezone || 'Asia/Kolkata';
    const range = this.range(query, tz);

    return {
      note: mixedCurrency
        ? 'Mixed currencies — group totals are per currency only. Legal books stay per tenant.'
        : 'Reporting rollup only — legal books stay per tenant.',
      mixedCurrency,
      currencies,
      period: { from: range.fromYmd, to: range.toYmd },
      group: mixedCurrency ? null : (byCurrency[0] ?? null),
      byCurrency,
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
    const prevMap = new Map(
      prev.businesses.map((b) => [b.tenantId, b.netProfit]),
    );
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
    return {
      period: pnl.period,
      mixedCurrency: pnl.mixedCurrency,
      currencies: pnl.currencies,
      note: pnl.note,
      rows,
    };
  }

  async drillOrders(
    p: EnterprisePrincipal,
    tenantId: string,
    query: MetricsQuery & { page?: number; limit?: number },
  ) {
    if (
      !canSeeGroupFinance(p) &&
      p.groupRole !== 'auditor' &&
      !p.tenantIds.includes(tenantId)
    ) {
      throw new ForbiddenException('No access to this business');
    }
    await this.tenantScope(p, { tenantId });
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const range = this.range(query, tenant?.timezone || 'Asia/Kolkata');
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

  /** Shift a YYYY-MM-DD calendar day (not a timezone-local Date). */
  private addCalendarDays(ymd: string, delta: number) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
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
          ...(locIds.length
            ? { order: { locationId: { in: locIds } } }
            : {}),
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

  /** Prisma binds JS strings as text; Postgres UUID columns need an explicit cast. */
  private uuidIn(ids: string[]) {
    return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  }

  private async cogsSum(
    tenantIds: string[],
    locIds: string[],
    range: { start: Date; end: Date },
  ) {
    if (!tenantIds.length) return 0;
    const locSql = locIds.length
      ? Prisma.sql`AND o.location_id IN (${this.uuidIn(locIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ cogs: Prisma.Decimal }>>`
      SELECT COALESCE(SUM(oi.quantity * COALESCE(p.cost_price, 0)), 0) AS cogs
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE o.tenant_id IN (${this.uuidIn(tenantIds)})
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

  private async cashMaps(tenantIds: string[], locIds: string[]) {
    const sessionWhere = {
      tenantId: { in: tenantIds },
      closedAt: null as null,
      ...(locIds.length ? { locationId: { in: locIds } } : {}),
    };
    const [sessions, moves] = await Promise.all([
      this.prisma.registerSession.groupBy({
        by: ['tenantId'],
        where: sessionWhere,
        _sum: { openingFloat: true },
      }),
      this.prisma.payment.groupBy({
        by: ['tenantId', 'type'],
        where: {
          tenantId: { in: tenantIds },
          status: PaymentStatus.succeeded,
          method: PaymentMethod.cash,
          registerSession: sessionWhere,
        },
        _sum: { amount: true },
      }),
    ]);
    const map = new Map<string, number>();
    for (const s of sessions) {
      map.set(s.tenantId, round2(Number(s._sum.openingFloat ?? 0)));
    }
    const inbound: PaymentType[] = [PaymentType.payment, PaymentType.deposit];
    for (const m of moves) {
      const amt = Number(m._sum.amount ?? 0);
      const signed = inbound.includes(m.type) ? amt : -Math.abs(amt);
      map.set(m.tenantId, round2((map.get(m.tenantId) ?? 0) + signed));
    }
    return map;
  }

  private async cashOnHand(tenantIds: string[], locIds: string[]) {
    const map = await this.cashMaps(tenantIds, locIds);
    let total = 0;
    for (const v of map.values()) total += v;
    return round2(total);
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
      ? Prisma.sql`AND sl.location_id IN (${this.uuidIn(locIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{ value: Prisma.Decimal; qty: Prisma.Decimal }>
    >`
      SELECT
        COALESCE(SUM(sl.qty_on_hand * COALESCE(p.cost_price, 0)), 0) AS value,
        COALESCE(SUM(sl.qty_on_hand), 0) AS qty
      FROM stock_levels sl
      JOIN products p ON p.id = sl.product_id
      WHERE sl.tenant_id IN (${this.uuidIn(tenantIds)})
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
      ? Prisma.sql`AND location_id IN (${this.uuidIn(locIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM stock_levels sl
      WHERE sl.tenant_id IN (${this.uuidIn(tenantIds)})
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
    const qtys = [...sorted.map((g) => Number(g._sum.quantity ?? 0))].sort(
      (a, b) => a - b,
    );
    const mid = Math.floor(qtys.length / 2);
    const median =
      qtys.length === 0
        ? 0
        : qtys.length % 2
          ? qtys[mid]
          : (qtys[mid - 1] + qtys[mid]) / 2;
    return {
      fast: sorted.filter(
        (g) => Number(g._sum.quantity ?? 0) > Math.max(1, median),
      ).length,
      slow: sorted.filter((g) => Number(g._sum.quantity ?? 0) <= 1).length,
    };
  }

  private async inventoryValueByTenant(tenantIds: string[], locIds: string[]) {
    if (!tenantIds.length) return new Map();
    const locSql = locIds.length
      ? Prisma.sql`AND sl.location_id IN (${this.uuidIn(locIds)})`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<
      Array<{ tenant_id: string; value: Prisma.Decimal }>
    >`
      SELECT sl.tenant_id, COALESCE(SUM(sl.qty_on_hand * COALESCE(p.cost_price, 0)), 0) AS value
      FROM stock_levels sl
      JOIN products p ON p.id = sl.product_id
      WHERE sl.tenant_id IN (${this.uuidIn(tenantIds)})
        ${locSql}
      GROUP BY sl.tenant_id
    `;
    return new Map(rows.map((r) => [r.tenant_id, round2(Number(r.value))]));
  }

  private async cashByTenant(tenantIds: string[], locIds: string[]) {
    return this.cashMaps(tenantIds, locIds);
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
