import { BadRequestException, Injectable } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type { CustomerReportsQueryDto } from './dto/reports.dto';
import {
  pctChange,
  round2,
  ymdInZone,
  zonedLocalToUtc,
} from './reports.util';

type RfmSegment = 'VIP' | 'Loyal' | 'At-Risk' | 'Lost' | 'New' | 'Regular';

const CLOSED_OUT: OrderStatus[] = [OrderStatus.cancelled, OrderStatus.draft];

/**
 * Customer Reports — purchase history, top customers, new vs returning,
 * RFM segments, outstanding credit aging, loyalty points.
 * Uses Order / Payment / LoyaltyLedger relationships (no duplicated history).
 */
@Injectable()
export class ReportsCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async purchaseHistory(user: AuthUser, query: CustomerReportsQueryDto) {
    if (!query.customerId) {
      throw new BadRequestException('customerId is required');
    }
    const ctx = await this.context(user);
    const { from, to } = this.resolveRange(query, ctx.timeZone);
    const customer = await this.prisma.customer.findFirst({
      where: {
        id: query.customerId,
        tenantId: user.tenantId,
        deletedAt: null,
      },
      select: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        loyaltyPoints: true,
        storeCreditBalance: true,
        createdAt: true,
      },
    });
    if (!customer) throw new BadRequestException('Customer not found');

    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        customerId: customer.id,
        status: { notIn: CLOSED_OUT },
        createdAt: { gte: from, lte: to },
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? 200, 500),
      include: {
        location: { select: { id: true, name: true } },
        items: {
          select: {
            description: true,
            quantity: true,
            unitPrice: true,
            lineTotal: true,
            product: { select: { name: true, skuCode: true } },
          },
        },
        payments: {
          where: { status: PaymentStatus.succeeded },
          select: { method: true, amount: true, type: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const items = orders.map((o) => {
      const spend =
        Number(o.subtotal) + Number(o.taxTotal) - Number(o.discountTotal);
      const methods = [
        ...new Set(
          o.payments
            .filter((p) => p.type === 'payment' || p.type === 'deposit')
            .map((p) => p.method),
        ),
      ];
      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        date: ymdInZone(o.createdAt, ctx.timeZone),
        createdAt: o.createdAt.toISOString(),
        status: o.status,
        branch: o.location.name,
        locationId: o.location.id,
        amount: round2(spend),
        balanceDue: round2(Number(o.balanceDue)),
        paymentMethods: methods,
        paymentMethodLabel: methods.length ? methods.join(', ') : '—',
        lineItems: o.items.map((it) => ({
          name: it.product?.name ?? it.description ?? 'Item',
          sku: it.product?.skuCode ?? null,
          qty: Number(it.quantity),
          unitPrice: Number(it.unitPrice),
          lineTotal: Number(it.lineTotal),
        })),
        href: `/orders/view?id=${o.id}`,
      };
    });

    return {
      ...this.meta(ctx, query, from, to),
      customer: {
        id: customer.id,
        fullName: customer.fullName,
        phone: customer.phone,
        email: customer.email,
        loyaltyPoints: customer.loyaltyPoints,
        storeCreditBalance: Number(customer.storeCreditBalance),
        profileHref: `/customers?id=${customer.id}`,
      },
      summary: {
        orderCount: items.length,
        totalSpent: round2(items.reduce((s, r) => s + r.amount, 0)),
        openDue: round2(items.reduce((s, r) => s + r.balanceDue, 0)),
      },
      items,
    };
  }

  async topCustomers(user: AuthUser, query: CustomerReportsQueryDto) {
    const ctx = await this.context(user);
    const { from, to } = this.resolveRange(query, ctx.timeZone);
    const rankBy = query.rankBy ?? 'spend';
    const minSpend = Number(query.minSpend ?? 0);
    const limit = Math.min(query.limit ?? 50, 200);

    const agg = await this.aggregateCustomers(
      user.tenantId,
      from,
      to,
      query,
      ctx.timeZone,
    );
    let rows = [...agg.values()].filter((r) => r.spend >= minSpend);

    if (query.segment?.trim()) {
      const seg = query.segment.trim();
      rows = rows.filter((r) => {
        if (r.rfmSegment === seg) return true;
        return r.tags.some((t) => t.toLowerCase() === seg.toLowerCase());
      });
    }
    if (query.q?.trim()) {
      const q = query.q.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.fullName.toLowerCase().includes(q) ||
          r.phone.includes(q) ||
          (r.email ?? '').toLowerCase().includes(q),
      );
    }

    rows.sort((a, b) => {
      if (rankBy === 'visits') return b.visits - a.visits;
      if (rankBy === 'profit') return b.profit - a.profit;
      return b.spend - a.spend;
    });

    const items = rows.slice(0, limit).map((r, i) => ({
      rank: i + 1,
      customerId: r.customerId,
      fullName: r.fullName,
      phone: r.phone,
      email: r.email,
      visits: r.visits,
      totalSpend: round2(r.spend),
      profitContributed: round2(r.profit),
      avgTicket: r.visits ? round2(r.spend / r.visits) : 0,
      lastVisit: r.lastVisitYmd,
      rfmSegment: r.rfmSegment,
      tags: r.tags,
      profileHref: `/customers?id=${r.customerId}`,
    }));

    return {
      ...this.meta(ctx, query, from, to),
      rankBy,
      summary: {
        customerCount: items.length,
        totalSpend: round2(items.reduce((s, r) => s + r.totalSpend, 0)),
        totalVisits: items.reduce((s, r) => s + r.visits, 0),
        totalProfit: round2(
          items.reduce((s, r) => s + r.profitContributed, 0),
        ),
      },
      items,
    };
  }

  async newVsReturning(user: AuthUser, query: CustomerReportsQueryDto) {
    const ctx = await this.context(user);
    const { from, to, fromYmd, toYmd } = this.resolveRangeLabeled(
      query,
      ctx.timeZone,
    );
    const days = this.inclusiveDays(fromYmd, toYmd);
    const prevTo = this.shiftYmd(fromYmd, -1);
    const prevFrom = this.shiftYmd(prevTo, -(days - 1));
    const prevRange = {
      start: zonedLocalToUtc(prevFrom, 0, 0, 0, 0, ctx.timeZone),
      end: zonedLocalToUtc(prevTo, 23, 59, 59, 999, ctx.timeZone),
    };

    const [currentOrders, prevOrders, firstOrders] = await Promise.all([
      this.loadCustomerOrders(user.tenantId, from, to, query.locationId),
      this.loadCustomerOrders(
        user.tenantId,
        prevRange.start,
        prevRange.end,
        query.locationId,
      ),
      this.firstOrderDates(user.tenantId, query.locationId),
    ]);

    const seriesMap = new Map<
      string,
      { date: string; newCustomers: number; returningVisits: number }
    >();
    const bump = (ymd: string, field: 'newCustomers' | 'returningVisits') => {
      const row = seriesMap.get(ymd) ?? {
        date: ymd,
        newCustomers: 0,
        returningVisits: 0,
      };
      row[field] += 1;
      seriesMap.set(ymd, row);
    };

    const newIds = new Set<string>();
    const returningIds = new Set<string>();
    for (const o of currentOrders) {
      if (!o.customerId) continue;
      const ymd = ymdInZone(o.createdAt, ctx.timeZone);
      const first = firstOrders.get(o.customerId);
      const firstYmd = first ? ymdInZone(first, ctx.timeZone) : null;
      const isNew = firstYmd != null && firstYmd >= fromYmd && firstYmd <= toYmd;
      if (isNew && firstYmd === ymd) {
        bump(ymd, 'newCustomers');
        newIds.add(o.customerId);
      } else if (!isNew || (firstYmd && firstYmd < fromYmd)) {
        bump(ymd, 'returningVisits');
        returningIds.add(o.customerId);
      } else {
        bump(ymd, 'returningVisits');
        returningIds.add(o.customerId);
      }
    }

    const series = [...seriesMap.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );

    const prevCustomerIds = new Set(
      prevOrders.map((o) => o.customerId).filter(Boolean) as string[],
    );
    const currentCustomerIds = new Set(
      currentOrders.map((o) => o.customerId).filter(Boolean) as string[],
    );
    let retained = 0;
    for (const id of prevCustomerIds) {
      if (currentCustomerIds.has(id)) retained += 1;
    }
    const retentionRate =
      prevCustomerIds.size > 0
        ? round2((retained / prevCustomerIds.size) * 100)
        : null;

    return {
      ...this.meta(ctx, query, from, to),
      comparisonPeriod: { from: prevFrom, to: prevTo },
      summary: {
        newCustomers: newIds.size,
        returningCustomers: returningIds.size,
        totalOrders: currentOrders.length,
        retentionRatePct: retentionRate,
        retainedFromPrior: retained,
        priorActiveCustomers: prevCustomerIds.size,
        newVsPriorPct: pctChange(newIds.size, 0),
      },
      series,
    };
  }

  async rfm(user: AuthUser, query: CustomerReportsQueryDto) {
    const ctx = await this.context(user);
    const { from, to } = this.resolveRange(query, ctx.timeZone);
    const minSpend = Number(query.minSpend ?? 0);
    const todayYmd = ymdInZone(new Date(), ctx.timeZone);

    const agg = await this.aggregateCustomers(
      user.tenantId,
      from,
      to,
      query,
      ctx.timeZone,
    );
    let rows = [...agg.values()].filter((r) => r.spend >= minSpend);
    if (query.q?.trim()) {
      const q = query.q.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.fullName.toLowerCase().includes(q) ||
          r.phone.includes(q) ||
          (r.email ?? '').toLowerCase().includes(q),
      );
    }
    if (query.segment?.trim()) {
      const seg = query.segment.trim();
      rows = rows.filter((r) => r.rfmSegment === seg);
    }

    const segments: RfmSegment[] = [
      'VIP',
      'Loyal',
      'At-Risk',
      'Lost',
      'New',
      'Regular',
    ];
    const pie = segments.map((name) => {
      const inSeg = rows.filter((r) => r.rfmSegment === name);
      return {
        segment: name,
        customerCount: inSeg.length,
        totalSpend: round2(inSeg.reduce((s, r) => s + r.spend, 0)),
      };
    });

    const items = rows
      .sort((a, b) => b.spend - a.spend)
      .slice(0, Math.min(query.limit ?? 100, 500))
      .map((r) => ({
        customerId: r.customerId,
        fullName: r.fullName,
        phone: r.phone,
        email: r.email,
        recencyDays: r.recencyDays,
        frequency: r.visits,
        monetary: round2(r.spend),
        rScore: r.rScore,
        fScore: r.fScore,
        mScore: r.mScore,
        segment: r.rfmSegment,
        lastVisit: r.lastVisitYmd,
        profileHref: `/customers?id=${r.customerId}`,
      }));

    return {
      ...this.meta(ctx, query, from, to),
      asOf: todayYmd,
      summary: {
        scoredCustomers: rows.length,
        bySegment: Object.fromEntries(
          pie.map((p) => [p.segment, p.customerCount]),
        ),
      },
      pie,
      items,
    };
  }

  async outstanding(user: AuthUser, query: CustomerReportsQueryDto) {
    const ctx = await this.context(user);
    const minDue = Number(query.minDue ?? 0);
    const todayYmd = ymdInZone(new Date(), ctx.timeZone);
    const today = new Date(`${todayYmd}T00:00:00.000Z`);

    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        customerId: { not: null },
        balanceDue: { gt: 0 },
        status: { notIn: CLOSED_OUT },
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
      select: {
        id: true,
        orderNumber: true,
        balanceDue: true,
        createdAt: true,
        customerId: true,
        location: { select: { name: true } },
        customer: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
            deletedAt: true,
            meta: true,
          },
        },
      },
      take: 5000,
    });

    type Bucket = '0_30' | '30_60' | '60_90' | '90_plus';
    const bucketOf = (days: number): Bucket => {
      if (days <= 30) return '0_30';
      if (days <= 60) return '30_60';
      if (days <= 90) return '60_90';
      return '90_plus';
    };

    const byCustomer = new Map<
      string,
      {
        customerId: string;
        fullName: string;
        phone: string;
        email: string | null;
        tags: string[];
        totalDue: number;
        oldestDays: number;
        buckets: Record<Bucket, number>;
        orders: Array<{
          orderId: string;
          orderNumber: string;
          balanceDue: number;
          daysOverdue: number;
          agingBucket: Bucket;
          branch: string;
          orderDate: string;
        }>;
      }
    >();

    for (const o of orders) {
      if (!o.customer || o.customer.deletedAt) continue;
      const due = Number(o.balanceDue);
      if (due <= 0) continue;
      const orderYmd = ymdInZone(o.createdAt, ctx.timeZone);
      const orderDay = new Date(`${orderYmd}T00:00:00.000Z`);
      const days = Math.max(
        0,
        Math.round((today.getTime() - orderDay.getTime()) / 86_400_000),
      );
      const bucket = bucketOf(days);
      const tags = this.metaTags(o.customer.meta);
      if (query.segment?.trim()) {
        const seg = query.segment.trim().toLowerCase();
        if (!tags.some((t) => t.toLowerCase() === seg)) continue;
      }
      if (query.q?.trim()) {
        const q = query.q.trim().toLowerCase();
        if (
          !o.customer.fullName.toLowerCase().includes(q) &&
          !o.customer.phone.includes(q) &&
          !(o.customer.email ?? '').toLowerCase().includes(q)
        ) {
          continue;
        }
      }

      const mutable = byCustomer.get(o.customer.id) ?? {
        customerId: o.customer.id,
        fullName: o.customer.fullName,
        phone: o.customer.phone,
        email: o.customer.email,
        tags,
        totalDue: 0,
        oldestDays: 0,
        buckets: { '0_30': 0, '30_60': 0, '60_90': 0, '90_plus': 0 },
        orders: [] as Array<{
          orderId: string;
          orderNumber: string;
          balanceDue: number;
          daysOverdue: number;
          agingBucket: Bucket;
          branch: string;
          orderDate: string;
        }>,
      };
      mutable.totalDue += due;
      mutable.oldestDays = Math.max(mutable.oldestDays, days);
      mutable.buckets[bucket] += due;
      mutable.orders.push({
        orderId: o.id,
        orderNumber: o.orderNumber,
        balanceDue: round2(due),
        daysOverdue: days,
        agingBucket: bucket,
        branch: o.location.name,
        orderDate: orderYmd,
      });
      byCustomer.set(o.customer.id, mutable);
    }

    let items = [...byCustomer.values()]
      .map((r) => ({
        ...r,
        totalDue: round2(r.totalDue),
        buckets: {
          '0_30': round2(r.buckets['0_30']),
          '30_60': round2(r.buckets['30_60']),
          '60_90': round2(r.buckets['60_90']),
          '90_plus': round2(r.buckets['90_plus']),
        },
        severity:
          r.oldestDays > 90
            ? ('critical' as const)
            : r.oldestDays > 60
              ? ('high' as const)
              : r.oldestDays > 30
                ? ('medium' as const)
                : ('watch' as const),
        profileHref: `/customers?id=${r.customerId}`,
      }))
      .filter((r) => r.totalDue >= minDue)
      .sort((a, b) => b.totalDue - a.totalDue)
      .slice(0, Math.min(query.limit ?? 200, 500));

    const aging = {
      '0_30': round2(items.reduce((s, r) => s + r.buckets['0_30'], 0)),
      '30_60': round2(items.reduce((s, r) => s + r.buckets['30_60'], 0)),
      '60_90': round2(items.reduce((s, r) => s + r.buckets['60_90'], 0)),
      '90_plus': round2(items.reduce((s, r) => s + r.buckets['90_plus'], 0)),
    };

    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      businessType: ctx.businessType,
      asOf: todayYmd,
      filters: {
        locationId: query.locationId ?? null,
        segment: query.segment ?? null,
        minDue,
        q: query.q ?? null,
      },
      summary: {
        customerCount: items.length,
        totalOutstanding: round2(items.reduce((s, r) => s + r.totalDue, 0)),
        criticalCount: items.filter((r) => r.severity === 'critical').length,
      },
      agingBuckets: [
        {
          key: '0_30',
          label: '0–30 days',
          amount: aging['0_30'],
          severity: 'watch',
        },
        {
          key: '30_60',
          label: '30–60 days',
          amount: aging['30_60'],
          severity: 'medium',
        },
        {
          key: '60_90',
          label: '60–90 days',
          amount: aging['60_90'],
          severity: 'high',
        },
        {
          key: '90_plus',
          label: '90+ days',
          amount: aging['90_plus'],
          severity: 'critical',
        },
      ],
      items,
    };
  }

  async loyalty(user: AuthUser, query: CustomerReportsQueryDto) {
    const ctx = await this.context(user);
    const { from, to } = this.resolveRange(query, ctx.timeZone);
    const loyaltySettings =
      ctx.settings.loyalty && typeof ctx.settings.loyalty === 'object'
        ? (ctx.settings.loyalty as Record<string, unknown>)
        : {};
    const enabled = loyaltySettings.enabled !== false;
    const expireDays =
      typeof loyaltySettings.expireDays === 'number'
        ? loyaltySettings.expireDays
        : null;

    const entries = await this.prisma.loyaltyLedgerEntry.findMany({
      where: {
        tenantId: user.tenantId,
        createdAt: { gte: from, lte: to },
        ...(query.customerId ? { customerId: query.customerId } : {}),
      },
      select: {
        customerId: true,
        kind: true,
        points: true,
        createdAt: true,
        customer: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
            loyaltyPoints: true,
            deletedAt: true,
            meta: true,
          },
        },
      },
      take: 20000,
    });

    const map = new Map<
      string,
      {
        customerId: string;
        fullName: string;
        phone: string;
        email: string | null;
        balance: number;
        earned: number;
        redeemed: number;
        adjusted: number;
        tags: string[];
      }
    >();

    for (const e of entries) {
      if (!e.customer || e.customer.deletedAt) continue;
      if (query.q?.trim()) {
        const q = query.q.trim().toLowerCase();
        if (
          !e.customer.fullName.toLowerCase().includes(q) &&
          !e.customer.phone.includes(q) &&
          !(e.customer.email ?? '').toLowerCase().includes(q)
        ) {
          continue;
        }
      }
      const tags = this.metaTags(e.customer.meta);
      if (query.segment?.trim()) {
        const seg = query.segment.trim().toLowerCase();
        if (!tags.some((t) => t.toLowerCase() === seg)) continue;
      }
      const row = map.get(e.customerId) ?? {
        customerId: e.customer.id,
        fullName: e.customer.fullName,
        phone: e.customer.phone,
        email: e.customer.email,
        balance: e.customer.loyaltyPoints,
        earned: 0,
        redeemed: 0,
        adjusted: 0,
        tags,
      };
      const pts = Math.abs(e.points);
      if (e.kind === 'earn') row.earned += pts;
      else if (e.kind === 'redeem') row.redeemed += pts;
      else row.adjusted += e.points;
      map.set(e.customerId, row);
    }

    // Also include customers with balance but no period activity if searching none
    if (!query.q && map.size < 50) {
      const withBal = await this.prisma.customer.findMany({
        where: {
          tenantId: user.tenantId,
          deletedAt: null,
          loyaltyPoints: { gt: 0 },
        },
        take: 100,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          loyaltyPoints: true,
          meta: true,
        },
      });
      for (const c of withBal) {
        if (map.has(c.id)) continue;
        map.set(c.id, {
          customerId: c.id,
          fullName: c.fullName,
          phone: c.phone,
          email: c.email,
          balance: c.loyaltyPoints,
          earned: 0,
          redeemed: 0,
          adjusted: 0,
          tags: this.metaTags(c.meta),
        });
      }
    }

    let expiringCutoff: Date | null = null;
    if (expireDays && expireDays > 0) {
      expiringCutoff = new Date();
      expiringCutoff.setUTCDate(expiringCutoff.getUTCDate() - expireDays);
    }

    const earnOld = expiringCutoff
      ? await this.prisma.loyaltyLedgerEntry.groupBy({
          by: ['customerId'],
          where: {
            tenantId: user.tenantId,
            kind: 'earn',
            createdAt: { lte: expiringCutoff },
            customerId: { in: [...map.keys()] },
          },
          _sum: { points: true },
        })
      : [];
    const expiringMap = new Map<string, number>();
    for (const e of earnOld) {
      expiringMap.set(e.customerId, Math.abs(Number(e._sum.points ?? 0)));
    }

    const items = [...map.values()]
      .map((r) => ({
        ...r,
        expiringPoints: Math.min(r.balance, expiringMap.get(r.customerId) ?? 0),
        profileHref: `/customers?id=${r.customerId}`,
      }))
      .sort((a, b) => b.balance - a.balance || b.earned - a.earned)
      .slice(0, Math.min(query.limit ?? 100, 500));

    return {
      ...this.meta(ctx, query, from, to),
      loyaltyEnabled: enabled,
      expireDaysConfigured: expireDays,
      summary: {
        customerCount: items.length,
        pointsEarned: items.reduce((s, r) => s + r.earned, 0),
        pointsRedeemed: items.reduce((s, r) => s + r.redeemed, 0),
        pointsOutstanding: items.reduce((s, r) => s + r.balance, 0),
        pointsExpiring: items.reduce((s, r) => s + r.expiringPoints, 0),
      },
      items,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async context(user: AuthUser) {
    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: {
        timezone: true,
        currencyCode: true,
        settings: true,
        businessConfig: { select: { businessType: true } },
      },
    });
    const settings =
      tenant.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    return {
      timeZone: tenant.timezone || 'Asia/Kolkata',
      currencyCode: tenant.currencyCode || 'INR',
      businessType:
        tenant.businessConfig?.businessType ||
        (typeof settings.businessType === 'string'
          ? settings.businessType
          : 'general'),
      settings,
    };
  }

  private meta(
    ctx: {
      timeZone: string;
      currencyCode: string;
      businessType: string;
    },
    query: CustomerReportsQueryDto,
    from: Date,
    to: Date,
  ) {
    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      businessType: ctx.businessType,
      period: {
        from: ymdInZone(from, ctx.timeZone),
        to: ymdInZone(to, ctx.timeZone),
      },
      filters: {
        locationId: query.locationId ?? null,
        segment: query.segment ?? null,
        minSpend: query.minSpend ?? null,
        q: query.q ?? null,
      },
    };
  }

  private resolveRange(query: CustomerReportsQueryDto, timeZone: string) {
    const today = ymdInZone(new Date(), timeZone);
    const toYmd = (query.to || today).slice(0, 10);
    const fromDefault = this.shiftYmd(toYmd, -29);
    const fromYmd = (query.from || fromDefault).slice(0, 10);
    return {
      from: zonedLocalToUtc(fromYmd, 0, 0, 0, 0, timeZone),
      to: zonedLocalToUtc(toYmd, 23, 59, 59, 999, timeZone),
      fromYmd,
      toYmd,
    };
  }

  private resolveRangeLabeled(
    query: CustomerReportsQueryDto,
    timeZone: string,
  ) {
    return this.resolveRange(query, timeZone);
  }

  private inclusiveDays(from: string, to: string): number {
    const a = Date.parse(`${from}T00:00:00.000Z`);
    const b = Date.parse(`${to}T00:00:00.000Z`);
    return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
  }

  private shiftYmd(ymd: string, deltaDays: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().slice(0, 10);
  }

  private metaTags(meta: unknown): string[] {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];
    const m = meta as Record<string, unknown>;
    const raw = m.tags ?? m.tag ?? m.segment ?? m.labels;
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw === 'string' && raw.trim()) {
      return raw
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [];
  }

  private async loadCustomerOrders(
    tenantId: string,
    from: Date,
    to: Date,
    locationId?: string,
  ) {
    return this.prisma.order.findMany({
      where: {
        tenantId,
        customerId: { not: null },
        status: { notIn: CLOSED_OUT },
        createdAt: { gte: from, lte: to },
        ...(locationId ? { locationId } : {}),
      },
      select: { customerId: true, createdAt: true },
      take: 50000,
    });
  }

  private async firstOrderDates(tenantId: string, locationId?: string) {
    const rows = await this.prisma.order.groupBy({
      by: ['customerId'],
      where: {
        tenantId,
        customerId: { not: null },
        status: { notIn: CLOSED_OUT },
        ...(locationId ? { locationId } : {}),
      },
      _min: { createdAt: true },
    });
    const map = new Map<string, Date>();
    for (const r of rows) {
      if (r.customerId && r._min.createdAt) {
        map.set(r.customerId, r._min.createdAt);
      }
    }
    return map;
  }

  private async aggregateCustomers(
    tenantId: string,
    from: Date,
    to: Date,
    query: CustomerReportsQueryDto,
    timeZone: string,
  ) {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        customerId: { not: null },
        status: { notIn: CLOSED_OUT },
        createdAt: { gte: from, lte: to },
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
      select: {
        id: true,
        customerId: true,
        subtotal: true,
        taxTotal: true,
        discountTotal: true,
        createdAt: true,
        customer: {
          select: {
            id: true,
            fullName: true,
            phone: true,
            email: true,
            createdAt: true,
            deletedAt: true,
            meta: true,
          },
        },
        items: {
          select: {
            quantity: true,
            lineTotal: true,
            product: { select: { costPrice: true } },
          },
        },
      },
      take: 30000,
    });

    const todayYmd = ymdInZone(new Date(), timeZone);
    const today = new Date(`${todayYmd}T00:00:00.000Z`);
    const map = new Map<
      string,
      {
        customerId: string;
        fullName: string;
        phone: string;
        email: string | null;
        tags: string[];
        visits: number;
        spend: number;
        profit: number;
        lastVisitAt: Date | null;
        lastVisitYmd: string | null;
        recencyDays: number;
        rScore: number;
        fScore: number;
        mScore: number;
        rfmSegment: RfmSegment;
        customerCreatedAt: Date;
      }
    >();

    for (const o of orders) {
      if (!o.customerId || !o.customer || o.customer.deletedAt) continue;
      const spend =
        Number(o.subtotal) + Number(o.taxTotal) - Number(o.discountTotal);
      let cost = 0;
      for (const it of o.items) {
        cost += Number(it.product?.costPrice ?? 0) * Number(it.quantity);
      }
      const row = map.get(o.customerId) ?? {
        customerId: o.customerId,
        fullName: o.customer.fullName,
        phone: o.customer.phone,
        email: o.customer.email,
        tags: this.metaTags(o.customer.meta),
        visits: 0,
        spend: 0,
        profit: 0,
        lastVisitAt: null as Date | null,
        lastVisitYmd: null as string | null,
        recencyDays: 999,
        rScore: 1,
        fScore: 1,
        mScore: 1,
        rfmSegment: 'Regular' as RfmSegment,
        customerCreatedAt: o.customer.createdAt,
      };
      row.visits += 1;
      row.spend += spend;
      row.profit += spend - cost;
      if (!row.lastVisitAt || o.createdAt > row.lastVisitAt) {
        row.lastVisitAt = o.createdAt;
      }
      map.set(o.customerId, row);
    }

    const spends = [...map.values()].map((r) => r.spend).sort((a, b) => a - b);
    const quantile = (p: number) => {
      if (!spends.length) return 0;
      const idx = Math.min(
        spends.length - 1,
        Math.floor(p * (spends.length - 1)),
      );
      return spends[idx]!;
    };
    const m1 = quantile(0.2);
    const m2 = quantile(0.4);
    const m3 = quantile(0.6);
    const m4 = quantile(0.8);

    for (const r of map.values()) {
      const last = r.lastVisitAt ?? new Date();
      r.lastVisitYmd = ymdInZone(last, timeZone);
      const lastDay = new Date(`${r.lastVisitYmd}T00:00:00.000Z`);
      r.recencyDays = Math.max(
        0,
        Math.round((today.getTime() - lastDay.getTime()) / 86_400_000),
      );
      r.rScore =
        r.recencyDays <= 7
          ? 5
          : r.recencyDays <= 30
            ? 4
            : r.recencyDays <= 60
              ? 3
              : r.recencyDays <= 90
                ? 2
                : 1;
      r.fScore =
        r.visits >= 20
          ? 5
          : r.visits >= 10
            ? 4
            : r.visits >= 5
              ? 3
              : r.visits >= 2
                ? 2
                : 1;
      r.mScore =
        r.spend >= m4
          ? 5
          : r.spend >= m3
            ? 4
            : r.spend >= m2
              ? 3
              : r.spend >= m1
                ? 2
                : 1;
      r.rfmSegment = this.classifyRfm(r);
    }

    return map;
  }

  private classifyRfm(r: {
    rScore: number;
    fScore: number;
    mScore: number;
    visits: number;
    recencyDays: number;
    customerCreatedAt: Date;
  }): RfmSegment {
    if (r.rScore >= 4 && r.fScore >= 4 && r.mScore >= 4) return 'VIP';
    if (r.fScore >= 4 && r.rScore >= 3) return 'Loyal';
    if (r.visits === 1 && r.rScore >= 4) return 'New';
    if (r.mScore >= 3 && r.rScore <= 2) return 'At-Risk';
    if (r.rScore === 1) return 'Lost';
    return 'Regular';
  }
}
