import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  OrderItemKind,
  OrderKind,
  OrderStatus,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { NotifyService } from '../notify/notify.service';
import { NotificationChannel } from '@prisma/client';
import type { AuthUser } from '../auth/types';
import type {
  MonthlyEmailScheduleDto,
  MonthlySalesQueryDto,
  UpsertMonthlyTargetDto,
} from './dto/reports.dto';
import {
  dayRange,
  daysInMonth,
  monthLabel,
  pad2,
  parseFiscalStartMonth,
  parseReportsSettings,
  pctChange,
  round2,
  shiftMonth,
  ymdInZone,
} from './reports.util';

@Injectable()
export class ReportsMonthlyService {
  private readonly log = new Logger(ReportsMonthlyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
  ) {}

  async monthlySales(user: AuthUser, query: MonthlySalesQueryDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: {
        timezone: true,
        currencyCode: true,
        settings: true,
        name: true,
        businessConfig: { select: { businessType: true } },
      },
    });
    const timezone = tenant?.timezone || 'Asia/Kolkata';
    const currencyCode = tenant?.currencyCode || 'INR';
    const fiscalStartMonth = parseFiscalStartMonth(tenant?.settings);
    const reportsCfg = parseReportsSettings(tenant?.settings);

    const { year, month } = this.resolveYearMonth(query, fiscalStartMonth);
    const periodKey = monthLabel(year, month);
    const range = this.monthRange(year, month, timezone);
    const prev = shiftMonth(year, month, -1);
    const prevRange = this.monthRange(prev.year, prev.month, timezone);
    const yoy = shiftMonth(year, month, -12);
    const yoyRange = this.monthRange(yoy.year, yoy.month, timezone);

    const locationIds = this.parseLocationIds(query.locationIds);
    const baseWhere = this.orderWhere(
      user.tenantId,
      range,
      locationIds,
      query.categoryId,
    );

    const [orders, items, locations, prevSnap, yoySnap, newCustomers] =
      await Promise.all([
        this.prisma.order.findMany({
          where: baseWhere,
          select: {
            id: true,
            orderNumber: true,
            locationId: true,
            customerId: true,
            subtotal: true,
            taxTotal: true,
            discountTotal: true,
            createdAt: true,
            customer: { select: { id: true, createdAt: true } },
            location: { select: { id: true, name: true } },
          },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.orderItem.findMany({
          where: {
            order: baseWhere,
            itemKind: {
              in: [
                OrderItemKind.product,
                OrderItemKind.service,
                OrderItemKind.stock_unit,
                OrderItemKind.custom,
              ],
            },
            ...(query.categoryId
              ? { product: { categoryId: query.categoryId } }
              : {}),
          },
          select: {
            quantity: true,
            lineTotal: true,
            product: {
              select: {
                categoryId: true,
                category: { select: { id: true, name: true } },
              },
            },
          },
        }),
        this.prisma.location.findMany({
          where: {
            tenantId: user.tenantId,
            ...(locationIds.length ? { id: { in: locationIds } } : {}),
          },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.periodSnapshot(
          user.tenantId,
          prevRange,
          locationIds,
          query.categoryId,
        ),
        this.periodSnapshot(
          user.tenantId,
          yoyRange,
          locationIds,
          query.categoryId,
        ),
        this.prisma.customer.count({
          where: {
            tenantId: user.tenantId,
            createdAt: { gte: range.start, lte: range.end },
          },
        }),
      ]);

    const saleOrders = orders.filter((o) => true); // already excludes returns in where
    const dim = daysInMonth(year, month);
    const dailyMap = new Map<
      string,
      { sales: number; orders: number; weekday: number }
    >();
    for (let d = 1; d <= dim; d++) {
      const ymd = `${year}-${pad2(month)}-${pad2(d)}`;
      const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
      dailyMap.set(ymd, { sales: 0, orders: 0, weekday: wd });
    }

    let revenue = 0;
    let orderCount = 0;
    const branchMap = new Map<
      string,
      { locationId: string; name: string; revenue: number; orders: number }
    >();

    for (const o of saleOrders) {
      const net = Number(o.subtotal) + Number(o.taxTotal);
      revenue += net;
      orderCount += 1;
      const ymd = ymdInZone(o.createdAt, timezone);
      const day = dailyMap.get(ymd);
      if (day) {
        day.sales += net;
        day.orders += 1;
      }
      const b = branchMap.get(o.locationId) ?? {
        locationId: o.locationId,
        name: o.location?.name ?? 'Branch',
        revenue: 0,
        orders: 0,
      };
      b.revenue += net;
      b.orders += 1;
      branchMap.set(o.locationId, b);
    }

    const daily = [...dailyMap.entries()].map(([date, v]) => ({
      date,
      sales: round2(v.sales),
      orders: v.orders,
      weekday: v.weekday,
      isWeekend: v.weekday === 0 || v.weekday === 6,
    }));

    const weeks = this.weekBuckets(daily);
    let bestDay: (typeof daily)[0] | null = null;
    let worstDay: (typeof daily)[0] | null = null;
    for (const d of daily) {
      if (!bestDay || d.sales > bestDay.sales) bestDay = d;
      if (d.orders > 0 && (!worstDay || d.sales < worstDay.sales)) worstDay = d;
    }

    const catMap = new Map<
      string,
      { categoryId: string | null; name: string; revenue: number; qty: number }
    >();
    for (const it of items) {
      const id = it.product?.category?.id ?? null;
      const name = it.product?.category?.name ?? 'Uncategorized';
      const key = id ?? 'uncategorized';
      const row = catMap.get(key) ?? {
        categoryId: id,
        name,
        revenue: 0,
        qty: 0,
      };
      row.revenue += Number(it.lineTotal);
      row.qty += Number(it.quantity);
      catMap.set(key, row);
    }
    const byCategory = [...catMap.values()]
      .map((c) => ({
        ...c,
        revenue: round2(c.revenue),
        pct: revenue > 0 ? round2((c.revenue / revenue) * 100) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const byBranch = [...branchMap.values()]
      .map((b) => ({
        ...b,
        revenue: round2(b.revenue),
        pct: revenue > 0 ? round2((b.revenue / revenue) * 100) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // Returning = ordered this month and customer existed before month start
    let returningCustomers = 0;
    const seen = new Set<string>();
    for (const o of saleOrders) {
      if (!o.customerId || seen.has(o.customerId)) continue;
      seen.add(o.customerId);
      if (o.customer && o.customer.createdAt < range.start) {
        returningCustomers += 1;
      }
    }
    // Prefer created-in-month count for "new acquired"; also count first-time buyers
    const newAcquired = newCustomers;

    const targetAmount =
      reportsCfg.monthlyTargets?.[periodKey] ??
      reportsCfg.monthlyTargetAmount ??
      null;
    const targetPct =
      targetAmount && targetAmount > 0
        ? round2((revenue / targetAmount) * 100)
        : null;

    const avgDailySales = dim ? round2(revenue / dim) : 0;
    const avgOrderValue = orderCount ? round2(revenue / orderCount) : 0;

    const summary = {
      revenue: round2(revenue),
      orderCount,
      avgDailySales,
      avgOrderValue,
      daysInMonth: dim,
    };

    return {
      period: {
        year,
        month,
        key: periodKey,
        label: new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }),
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        useFiscal: Boolean(query.useFiscal),
        fiscalStartMonth,
      },
      timezone,
      currencyCode,
      businessType:
        tenant?.businessConfig?.businessType ||
        (tenant?.settings as { businessType?: string } | null)?.businessType ||
        'general',
      tenantName: tenant?.name ?? 'Business',
      filters: {
        locationIds,
        categoryId: query.categoryId ?? null,
        compareTo: query.compareTo ?? 'previous_month',
      },
      summary,
      comparison: {
        previousMonth: {
          period: monthLabel(prev.year, prev.month),
          revenue: prevSnap.revenue,
          orderCount: prevSnap.orderCount,
          changePct: pctChange(summary.revenue, prevSnap.revenue),
        },
        sameMonthLastYear: {
          period: monthLabel(yoy.year, yoy.month),
          revenue: yoySnap.revenue,
          orderCount: yoySnap.orderCount,
          changePct: pctChange(summary.revenue, yoySnap.revenue),
        },
      },
      daily,
      weeks,
      bestDay,
      worstDay,
      target: {
        amount: targetAmount,
        achieved: round2(revenue),
        pct: targetPct,
      },
      byCategory,
      byBranch,
      customers: {
        newAcquired,
        returning: returningCustomers,
        withOrders: seen.size,
      },
      locations,
      emailSchedule: reportsCfg.monthlyEmail,
    };
  }

  async getSchedule(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    return parseReportsSettings(tenant?.settings).monthlyEmail;
  }

  async updateSchedule(user: AuthUser, dto: MonthlyEmailScheduleDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    const root =
      tenant?.settings && typeof tenant.settings === 'object'
        ? { ...(tenant.settings as Record<string, unknown>) }
        : {};
    const reports =
      root.reports && typeof root.reports === 'object'
        ? { ...(root.reports as Record<string, unknown>) }
        : {};
    const prev = parseReportsSettings(tenant?.settings).monthlyEmail;
    reports.monthlyEmail = {
      enabled: dto.enabled ?? prev?.enabled ?? false,
      recipients: dto.recipients ?? prev?.recipients ?? [],
      lastSentFor: prev?.lastSentFor ?? null,
    };
    root.reports = reports;
    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { settings: root as Prisma.InputJsonValue },
    });
    return reports.monthlyEmail;
  }

  async upsertTarget(user: AuthUser, dto: UpsertMonthlyTargetDto) {
    const key = monthLabel(dto.year, dto.month);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    const root =
      tenant?.settings && typeof tenant.settings === 'object'
        ? { ...(tenant.settings as Record<string, unknown>) }
        : {};
    const reports =
      root.reports && typeof root.reports === 'object'
        ? { ...(root.reports as Record<string, unknown>) }
        : {};
    const targets =
      reports.monthlyTargets && typeof reports.monthlyTargets === 'object'
        ? { ...(reports.monthlyTargets as Record<string, number>) }
        : {};
    if (dto.amount == null) {
      delete targets[key];
    } else {
      targets[key] = dto.amount;
    }
    reports.monthlyTargets = targets;
    if (dto.setAsDefault) {
      reports.monthlyTargetAmount = dto.amount ?? null;
    }
    root.reports = reports;
    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { settings: root as Prisma.InputJsonValue },
    });
    return { period: key, amount: dto.amount ?? null, targets };
  }

  /**
   * Send prior-month summary emails when schedule enabled.
   * Call daily via cron; only sends on the 1st (tenant TZ) unless force=true.
   */
  async sendScheduledPriorMonth(user: AuthUser, force = false) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true, timezone: true, name: true },
    });
    const timezone = tenant?.timezone || 'Asia/Kolkata';
    const cfg = parseReportsSettings(tenant?.settings).monthlyEmail;
    if (!cfg?.enabled || !cfg.recipients.length) {
      throw new BadRequestException(
        'Monthly email schedule is disabled or has no recipients',
      );
    }

    const todayYmd = ymdInZone(new Date(), timezone);
    const dayNum = Number(todayYmd.slice(8, 10));
    if (!force && dayNum !== 1) {
      return {
        sent: false,
        reason: 'Not the 1st of the month in business timezone',
        todayYmd,
      };
    }

    const [y, m] = todayYmd.split('-').map(Number);
    const prior = shiftMonth(y, m, -1);
    const periodKey = monthLabel(prior.year, prior.month);
    if (!force && cfg.lastSentFor === periodKey) {
      return { sent: false, reason: 'Already sent for prior month', periodKey };
    }

    const report = await this.monthlySales(user, {
      year: prior.year,
      month: prior.month,
    });
    const s = report.summary;
    const body = [
      `Monthly Sales Report — ${report.period.label}`,
      `${tenant?.name ?? 'Universal POS'}`,
      ``,
      `Revenue: ${s.revenue}`,
      `Orders: ${s.orderCount}`,
      `Avg daily: ${s.avgDailySales}`,
      `AOV: ${s.avgOrderValue}`,
      `vs prior month: ${report.comparison.previousMonth.changePct ?? '—'}%`,
      `vs same month LY: ${report.comparison.sameMonthLastYear.changePct ?? '—'}%`,
      report.target.amount != null
        ? `Target: ${report.target.amount} (${report.target.pct ?? 0}% achieved)`
        : null,
      `New customers: ${report.customers.newAcquired}`,
      `Returning: ${report.customers.returning}`,
      ``,
      `Open: /reports/monthly?year=${prior.year}&month=${prior.month}`,
    ]
      .filter(Boolean)
      .join('\n');

    const results: Array<{ email: string; status: string }> = [];
    for (const email of cfg.recipients) {
      try {
        await this.notify.send(user, {
          channel: NotificationChannel.email,
          email,
          templateKey: 'monthly_sales_report',
          payload: {
            subject: `Monthly Sales — ${report.period.label}`,
            body,
            period: periodKey,
          },
        });
        results.push({ email, status: 'queued' });
      } catch (e) {
        this.log.warn(`Monthly email failed for ${email}: ${String(e)}`);
        results.push({ email, status: 'failed' });
      }
    }

    const root =
      tenant?.settings && typeof tenant.settings === 'object'
        ? { ...(tenant.settings as Record<string, unknown>) }
        : {};
    const reports =
      root.reports && typeof root.reports === 'object'
        ? { ...(root.reports as Record<string, unknown>) }
        : {};
    reports.monthlyEmail = { ...cfg, lastSentFor: periodKey };
    root.reports = reports;
    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { settings: root as Prisma.InputJsonValue },
    });

    return { sent: true, periodKey, results };
  }

  private resolveYearMonth(
    query: MonthlySalesQueryDto,
    fiscalStartMonth: number,
  ): { year: number; month: number } {
    const now = new Date();
    let year = query.year ?? now.getUTCFullYear();
    let month = query.month ?? now.getUTCMonth() + 1;
    if (query.useFiscal && fiscalStartMonth !== 1) {
      // Interpret year as fiscal year starting at fiscalStartMonth
      // Fiscal month 1 = fiscalStartMonth of calendar year `year`
      const fm = query.month ?? 1;
      if (fm < 1 || fm > 12) throw new BadRequestException('Invalid month');
      const cal = shiftMonth(year, fiscalStartMonth, fm - 1);
      year = cal.year;
      month = cal.month;
    }
    if (month < 1 || month > 12) {
      throw new BadRequestException('month must be 1–12');
    }
    return { year, month };
  }

  private monthRange(year: number, month: number, timeZone: string) {
    const dim = daysInMonth(year, month);
    const startYmd = `${year}-${pad2(month)}-01`;
    const endYmd = `${year}-${pad2(month)}-${pad2(dim)}`;
    return {
      start: dayRange(startYmd, timeZone).start,
      end: dayRange(endYmd, timeZone).end,
    };
  }

  private parseLocationIds(raw?: string): string[] {
    if (!raw?.trim()) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private orderWhere(
    tenantId: string,
    range: { start: Date; end: Date },
    locationIds: string[],
    categoryId?: string,
  ): Prisma.OrderWhereInput {
    return {
      tenantId,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      kind: { not: OrderKind.return_order },
      createdAt: { gte: range.start, lte: range.end },
      ...(locationIds.length ? { locationId: { in: locationIds } } : {}),
      ...(categoryId
        ? {
            items: {
              some: { product: { categoryId } },
            },
          }
        : {}),
    };
  }

  private async periodSnapshot(
    tenantId: string,
    range: { start: Date; end: Date },
    locationIds: string[],
    categoryId?: string,
  ) {
    const where = this.orderWhere(tenantId, range, locationIds, categoryId);
    const agg = await this.prisma.order.aggregate({
      where,
      _sum: { subtotal: true, taxTotal: true },
      _count: { _all: true },
    });
    const refunds = await this.prisma.payment.aggregate({
      where: {
        tenantId,
        status: PaymentStatus.succeeded,
        type: { in: [PaymentType.refund, PaymentType.deposit_refund] },
        createdAt: { gte: range.start, lte: range.end },
        ...(locationIds.length
          ? { order: { locationId: { in: locationIds } } }
          : {}),
      },
      _sum: { amount: true },
    });
    const revenue = round2(
      Number(agg._sum.subtotal ?? 0) +
        Number(agg._sum.taxTotal ?? 0) -
        Math.abs(Number(refunds._sum.amount ?? 0)),
    );
    return { revenue, orderCount: agg._count._all };
  }

  private weekBuckets(
    daily: Array<{
      date: string;
      sales: number;
      orders: number;
      isWeekend: boolean;
    }>,
  ) {
    const weeks: Array<{
      week: number;
      label: string;
      from: string;
      to: string;
      sales: number;
      orders: number;
      weekendSales: number;
      weekdaySales: number;
    }> = [];
    let week = 1;
    let i = 0;
    while (i < daily.length) {
      const chunk = daily.slice(i, i + 7);
      const sales = round2(chunk.reduce((s, d) => s + d.sales, 0));
      const orders = chunk.reduce((s, d) => s + d.orders, 0);
      const weekendSales = round2(
        chunk.filter((d) => d.isWeekend).reduce((s, d) => s + d.sales, 0),
      );
      const weekdaySales = round2(sales - weekendSales);
      weeks.push({
        week,
        label: `Week ${week}`,
        from: chunk[0].date,
        to: chunk[chunk.length - 1].date,
        sales,
        orders,
        weekendSales,
        weekdaySales,
      });
      week += 1;
      i += 7;
    }
    return weeks;
  }
}
