import { Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  OrderStatus,
  PaymentStatus,
  PaymentType,
} from '@prisma/client';
import {
  isKitchenContext,
  isServiceRevenueContext,
  reportContextFromSettings,
  type ReportContext,
} from '../../common/report-capabilities';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type { EmployeeSalesQueryDto } from './dto/reports.dto';
import { round2, ymdInZone, zonedLocalToUtc } from './reports.util';

type CommissionConfig = {
  enabled: boolean;
  type: 'flat_percent' | 'tiered';
  ratePercent: number;
  tiers: Array<{ minSales: number; ratePercent: number }>;
};

/**
 * Employee sales / commission / productivity report.
 * Sales attributed via Order.createdById; hours from AttendanceEntry;
 * refunds via ReturnEvent / refund payments; commission from tenant settings.
 */
@Injectable()
export class ReportsEmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async employeeSales(user: AuthUser, query: EmployeeSalesQueryDto) {
    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: {
        timezone: true,
        currencyCode: true,
        settings: true,
        businessConfig: { select: { businessType: true } },
        name: true,
      },
    });
    const timeZone = tenant.timezone || 'Asia/Kolkata';
    const currencyCode = tenant.currencyCode || 'INR';
    const settings =
      tenant.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const businessType = String(
      tenant.businessConfig?.businessType ||
        (typeof settings.businessType === 'string'
          ? settings.businessType
          : 'general'),
    ).toLowerCase();
    const reportCtx = reportContextFromSettings({
      ...settings,
      businessType,
    });
    const commission = this.parseCommission(settings);

    const today = ymdInZone(new Date(), timeZone);
    const toYmd = (query.to || today).slice(0, 10);
    const fromYmd = (query.from || this.shiftYmd(toYmd, -29)).slice(0, 10);
    const from = zonedLocalToUtc(fromYmd, 0, 0, 0, 0, timeZone);
    const to = zonedLocalToUtc(toYmd, 23, 59, 59, 999, timeZone);

    const employeeFilter = this.parseIds(query.employeeIds);
    const roleFilter = query.role?.trim().toLowerCase() || null;
    const shiftSalesOnly = Boolean(query.shiftSalesOnly);

    const users = await this.prisma.user.findMany({
      where: {
        tenantId: user.tenantId,
        ...(employeeFilter.length ? { id: { in: employeeFilter } } : {}),
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        userRoles: {
          select: { role: { select: { code: true, name: true } } },
        },
        employee: { select: { jobTitle: true, employeeCode: true } },
      },
      take: 500,
    });

    let staff = users.map((u) => ({
      userId: u.id,
      fullName: u.fullName,
      email: u.email,
      roles: u.userRoles.map((r) => r.role.code),
      roleLabel:
        u.userRoles.map((r) => r.role.name || r.role.code).join(', ') ||
        u.employee?.jobTitle ||
        'Staff',
      jobTitle: u.employee?.jobTitle ?? null,
      employeeCode: u.employee?.employeeCode ?? null,
    }));

    if (roleFilter) {
      staff = staff.filter((s) =>
        s.roles.some((c) => c.toLowerCase() === roleFilter),
      );
    }
    const staffIds = new Set(staff.map((s) => s.userId));

    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        status: { notIn: [OrderStatus.draft] },
        createdAt: { gte: from, lte: to },
        ...(query.locationId ? { locationId: query.locationId } : {}),
        createdById: staffIds.size
          ? { in: [...staffIds] }
          : { in: [] },
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        createdById: true,
        createdAt: true,
        subtotal: true,
        taxTotal: true,
        discountTotal: true,
        meta: true,
        location: { select: { id: true, name: true } },
        items: {
          select: {
            quantity: true,
            lineTotal: true,
            itemKind: true,
            meta: true,
            product: {
              select: { name: true, skuCode: true, meta: true, kind: true },
            },
          },
        },
        payments: {
          where: { status: PaymentStatus.succeeded },
          select: {
            type: true,
            method: true,
            amount: true,
            takenByUserId: true,
          },
        },
      },
      take: 40000,
    });

    const attendance = await this.prisma.attendanceEntry.findMany({
      where: {
        tenantId: user.tenantId,
        userId: { in: [...staffIds] },
        OR: [
          { clockInAt: { gte: from, lte: to } },
          {
            workDate: {
              gte: new Date(`${fromYmd}T00:00:00.000Z`),
              lte: new Date(`${toYmd}T00:00:00.000Z`),
            },
          },
        ],
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
      select: {
        userId: true,
        clockInAt: true,
        clockOutAt: true,
        breakMinutes: true,
        status: true,
      },
    });

    const returns = await this.prisma.returnEvent.findMany({
      where: {
        tenantId: user.tenantId,
        createdAt: { gte: from, lte: to },
        OR: [
          { receivedById: { in: [...staffIds] } },
          { approvedById: { in: [...staffIds] } },
        ],
      },
      select: {
        id: true,
        receivedById: true,
        approvedById: true,
        orderId: true,
        createdAt: true,
        order: {
          select: {
            orderNumber: true,
            payments: {
              where: {
                type: PaymentType.refund,
                status: PaymentStatus.succeeded,
              },
              select: { amount: true, takenByUserId: true },
            },
          },
        },
      },
      take: 5000,
    });

    const refundPayments = await this.prisma.payment.findMany({
      where: {
        tenantId: user.tenantId,
        type: PaymentType.refund,
        status: PaymentStatus.succeeded,
        takenByUserId: { in: [...staffIds] },
        createdAt: { gte: from, lte: to },
      },
      select: {
        id: true,
        amount: true,
        takenByUserId: true,
        createdAt: true,
        order: { select: { orderNumber: true, id: true } },
      },
      take: 5000,
    });

    type Agg = {
      userId: string;
      fullName: string;
      email: string;
      roleLabel: string;
      roles: string[];
      employeeCode: string | null;
      sales: number;
      salesInShift: number;
      transactions: number;
      cancelledCount: number;
      itemsSold: number;
      multiItemOrders: number;
      tips: number;
      tables: Set<string>;
      refundAmount: number;
      refundCount: number;
      voidCount: number;
      hoursWorked: number;
      productCommission: number;
    };

    const map = new Map<string, Agg>();
    for (const s of staff) {
      map.set(s.userId, {
        userId: s.userId,
        fullName: s.fullName,
        email: s.email,
        roleLabel: s.roleLabel,
        roles: s.roles,
        employeeCode: s.employeeCode,
        sales: 0,
        salesInShift: 0,
        transactions: 0,
        cancelledCount: 0,
        itemsSold: 0,
        multiItemOrders: 0,
        tips: 0,
        tables: new Set(),
        refundAmount: 0,
        refundCount: 0,
        voidCount: 0,
        hoursWorked: 0,
        productCommission: 0,
      });
    }

    const windowsByUser = new Map<
      string,
      Array<{ start: Date; end: Date }>
    >();
    for (const a of attendance) {
      if (!a.clockInAt) continue;
      const end = a.clockOutAt ?? to;
      const ms =
        end.getTime() -
        a.clockInAt.getTime() -
        (a.breakMinutes || 0) * 60_000;
      const hours = Math.max(0, ms / 3_600_000);
      const row = map.get(a.userId);
      if (row) row.hoursWorked += hours;
      const list = windowsByUser.get(a.userId) ?? [];
      list.push({ start: a.clockInAt, end });
      windowsByUser.set(a.userId, list);
    }

    const inWindow = (userId: string, at: Date) => {
      const wins = windowsByUser.get(userId) ?? [];
      if (!wins.length) return false;
      return wins.some((w) => at >= w.start && at <= w.end);
    };

    for (const o of orders) {
      if (!o.createdById) continue;
      const row = map.get(o.createdById);
      if (!row) continue;
      const meta =
        o.meta && typeof o.meta === 'object' && !Array.isArray(o.meta)
          ? (o.meta as Record<string, unknown>)
          : {};
      const spend =
        Number(o.subtotal) + Number(o.taxTotal) - Number(o.discountTotal);
      const tip = this.readTip(meta, o.payments.map((p) => Number(p.amount)));
      const table =
        meta.tableNumber != null
          ? String(meta.tableNumber)
          : meta.tableNo != null
            ? String(meta.tableNo)
            : null;

      if (o.status === OrderStatus.cancelled) {
        row.cancelledCount += 1;
        row.voidCount += 1;
        continue;
      }

      row.transactions += 1;
      row.sales += spend;
      row.tips += tip;
      if (table) row.tables.add(table);
      if (inWindow(o.createdById, o.createdAt)) row.salesInShift += spend;

      let lineCount = 0;
      for (const it of o.items) {
        const qty = Number(it.quantity);
        row.itemsSold += qty;
        lineCount += 1;
        const pMeta =
          it.product?.meta &&
          typeof it.product.meta === 'object' &&
          !Array.isArray(it.product.meta)
            ? (it.product.meta as Record<string, unknown>)
            : {};
        const itMeta =
          it.meta && typeof it.meta === 'object' && !Array.isArray(it.meta)
            ? (it.meta as Record<string, unknown>)
            : {};
        const rate =
          typeof pMeta.commissionPercent === 'number'
            ? pMeta.commissionPercent
            : typeof itMeta.commissionPercent === 'number'
              ? itMeta.commissionPercent
              : null;
        if (rate != null) {
          row.productCommission += (Number(it.lineTotal) * rate) / 100;
        }
      }
      if (lineCount > 1) row.multiItemOrders += 1;
    }

    for (const r of returns) {
      const amount = r.order.payments.reduce(
        (s, p) => s + Math.abs(Number(p.amount)),
        0,
      );
      const credited = new Set<string>();
      for (const uid of [r.receivedById, r.approvedById]) {
        if (!uid || credited.has(uid)) continue;
        const row = map.get(uid);
        if (!row) continue;
        row.refundCount += 1;
        row.refundAmount += amount;
        credited.add(uid);
      }
    }
    for (const p of refundPayments) {
      if (!p.takenByUserId) continue;
      const row = map.get(p.takenByUserId);
      if (!row) continue;
      // Count payment-taker refunds not already covered via return events
      row.refundCount += 1;
      row.refundAmount += Math.abs(Number(p.amount));
    }

    // Service: appointments / rebooking (capability, not industry pack)
    const appts =
      isServiceRevenueContext(reportCtx)
        ? await this.prisma.appointment.findMany({
            where: {
              tenantId: user.tenantId,
              assigneeId: { in: [...staffIds] },
              startsAt: { gte: from, lte: to },
              ...(query.locationId ? { locationId: query.locationId } : {}),
            },
            select: {
              assigneeId: true,
              customerId: true,
              status: true,
              meta: true,
            },
            take: 10000,
          })
        : [];

    const serviceByUser = new Map<
      string,
      {
        servicesPerformed: number;
        tips: number;
        customers: Map<string, number>;
      }
    >();
    for (const a of appts) {
      if (!a.assigneeId) continue;
      const s =
        serviceByUser.get(a.assigneeId) ??
        {
          servicesPerformed: 0,
          tips: 0,
          customers: new Map<string, number>(),
        };
      if (
        a.status === AppointmentStatus.completed ||
        a.status === AppointmentStatus.checked_in ||
        a.status === AppointmentStatus.scheduled
      ) {
        s.servicesPerformed += 1;
      }
      const meta =
        a.meta && typeof a.meta === 'object' && !Array.isArray(a.meta)
          ? (a.meta as Record<string, unknown>)
          : {};
      if (typeof meta.tipAmount === 'number') s.tips += meta.tipAmount;
      if (a.customerId) {
        s.customers.set(
          a.customerId,
          (s.customers.get(a.customerId) ?? 0) + 1,
        );
      }
      serviceByUser.set(a.assigneeId, s);
    }

    const ranked = [...map.values()]
      .map((r) => {
        const salesBase = shiftSalesOnly ? r.salesInShift : r.sales;
        const commissionEarned = this.computeCommission(
          commission,
          salesBase,
          r.productCommission,
        );
        const hours = round2(r.hoursWorked);
        const salesPerHour = hours > 0 ? round2(salesBase / hours) : null;
        const avgTicket =
          r.transactions > 0 ? round2(r.sales / r.transactions) : 0;
        const upsellRate =
          r.transactions > 0
            ? round2((r.multiItemOrders / r.transactions) * 100)
            : 0;
        const svc = serviceByUser.get(r.userId);
        let rebookingRate: number | null = null;
        if (svc && svc.customers.size) {
          let repeat = 0;
          for (const c of svc.customers.values()) if (c >= 2) repeat += 1;
          rebookingRate = round2((repeat / svc.customers.size) * 100);
        }
        const tipPct =
          r.sales > 0 ? round2((r.tips / r.sales) * 100) : null;

        return {
          userId: r.userId,
          fullName: r.fullName,
          email: r.email,
          roleLabel: r.roleLabel,
          roles: r.roles,
          employeeCode: r.employeeCode,
          totalSales: round2(r.sales),
          salesInShift: round2(r.salesInShift),
          transactions: r.transactions,
          avgTicket,
          itemsSold: round2(r.itemsSold),
          upsellRatePct: upsellRate,
          commissionEarned: round2(commissionEarned),
          refundAmount: round2(r.refundAmount),
          refundCount: r.refundCount,
          voidCount: r.voidCount,
          cancelledCount: r.cancelledCount,
          hoursWorked: hours,
          salesPerHour,
          tipsEarned: round2(r.tips + (svc?.tips ?? 0)),
          tipPct,
          tablesServed: r.tables.size,
          servicesPerformed: svc?.servicesPerformed ?? 0,
          rebookingRatePct: rebookingRate,
          profileDetailParam: r.userId,
        };
      })
      .filter((r) =>
        employeeFilter.length
          ? true
          : r.transactions > 0 ||
            r.hoursWorked > 0 ||
            r.refundCount > 0 ||
            r.servicesPerformed > 0,
      )
      .sort((a, b) => b.totalSales - a.totalSales)
      .slice(0, query.limit ?? 100)
      .map((r, i) => ({ rank: i + 1, ...r }));

    let detail: unknown = null;
    if (query.detailUserId) {
      detail = await this.transactionLog(
        user.tenantId,
        query.detailUserId,
        from,
        to,
        query.locationId,
        timeZone,
      );
    }

    const copy = this.copyFor(reportCtx);

    return {
      generatedAt: new Date().toISOString(),
      tenantName: tenant.name,
      timeZone,
      currencyCode,
      businessType,
      title: copy.title,
      labels: copy.labels,
      period: { from: fromYmd, to: toYmd },
      filters: {
        locationId: query.locationId ?? null,
        employeeIds: employeeFilter,
        role: roleFilter,
        shiftSalesOnly,
      },
      commission: {
        enabled: commission.enabled,
        type: commission.type,
        ratePercent: commission.ratePercent,
        tiers: commission.tiers,
        note: commission.enabled
          ? 'Commission from tenant settings (+ per-product commissionPercent in product.meta when set)'
          : 'No commission rules configured — set tenant.settings.commission',
      },
      summary: {
        staffCount: ranked.length,
        totalSales: round2(ranked.reduce((s, r) => s + r.totalSales, 0)),
        totalTransactions: ranked.reduce((s, r) => s + r.transactions, 0),
        totalCommission: round2(
          ranked.reduce((s, r) => s + r.commissionEarned, 0),
        ),
        totalRefunds: round2(ranked.reduce((s, r) => s + r.refundAmount, 0)),
        totalHours: round2(ranked.reduce((s, r) => s + r.hoursWorked, 0)),
      },
      chart: ranked.slice(0, 10).map((r) => ({
        rank: r.rank,
        name: r.fullName,
        sales: r.totalSales,
        transactions: r.transactions,
        salesPerHour: r.salesPerHour,
      })),
      leaderboard: ranked,
      detail,
    };
  }

  private async transactionLog(
    tenantId: string,
    userId: string,
    from: Date,
    to: Date,
    locationId: string | undefined,
    timeZone: string,
  ) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, fullName: true, email: true },
    });
    if (!user) return null;

    const orders = await this.prisma.order.findMany({
      where: {
        tenantId,
        createdById: userId,
        createdAt: { gte: from, lte: to },
        ...(locationId ? { locationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        createdAt: true,
        subtotal: true,
        taxTotal: true,
        discountTotal: true,
        location: { select: { name: true } },
        items: {
          select: {
            description: true,
            quantity: true,
            lineTotal: true,
            product: { select: { name: true, skuCode: true } },
          },
        },
        payments: {
          where: { status: PaymentStatus.succeeded },
          select: { method: true, type: true, amount: true },
        },
      },
    });

    return {
      user,
      transactions: orders.map((o) => ({
        orderId: o.id,
        orderNumber: o.orderNumber,
        date: ymdInZone(o.createdAt, timeZone),
        createdAt: o.createdAt.toISOString(),
        status: o.status,
        branch: o.location.name,
        amount: round2(
          Number(o.subtotal) + Number(o.taxTotal) - Number(o.discountTotal),
        ),
        paymentMethods: [
          ...new Set(
            o.payments
              .filter((p) => p.type === PaymentType.payment)
              .map((p) => p.method),
          ),
        ],
        items: o.items.map((it) => ({
          name: it.product?.name ?? it.description ?? 'Item',
          sku: it.product?.skuCode ?? null,
          qty: Number(it.quantity),
          lineTotal: Number(it.lineTotal),
        })),
        href: `/orders/view?id=${o.id}`,
      })),
    };
  }

  private parseCommission(settings: Record<string, unknown>): CommissionConfig {
    const raw =
      (settings.commission && typeof settings.commission === 'object'
        ? (settings.commission as Record<string, unknown>)
        : null) ||
      (settings.staff &&
      typeof settings.staff === 'object' &&
      (settings.staff as Record<string, unknown>).commission &&
      typeof (settings.staff as Record<string, unknown>).commission ===
        'object'
        ? ((settings.staff as Record<string, unknown>)
            .commission as Record<string, unknown>)
        : null) ||
      {};
    const type =
      raw.type === 'tiered' ? 'tiered' : ('flat_percent' as const);
    const tiers = Array.isArray(raw.tiers)
      ? (raw.tiers as Array<Record<string, unknown>>)
          .map((t) => ({
            minSales: Number(t.minSales ?? 0),
            ratePercent: Number(t.ratePercent ?? 0),
          }))
          .filter((t) => Number.isFinite(t.ratePercent))
          .sort((a, b) => a.minSales - b.minSales)
      : [];
    const ratePercent = Number(raw.ratePercent ?? raw.percent ?? 0);
    const enabled =
      raw.enabled === true ||
      (raw.enabled !== false && (ratePercent > 0 || tiers.length > 0));
    return {
      enabled,
      type,
      ratePercent: Number.isFinite(ratePercent) ? ratePercent : 0,
      tiers,
    };
  }

  private computeCommission(
    cfg: CommissionConfig,
    sales: number,
    productCommission: number,
  ) {
    if (!cfg.enabled) return productCommission;
    let base = 0;
    if (cfg.type === 'tiered' && cfg.tiers.length) {
      let rate = cfg.tiers[0]!.ratePercent;
      for (const t of cfg.tiers) {
        if (sales >= t.minSales) rate = t.ratePercent;
      }
      base = (sales * rate) / 100;
    } else {
      base = (sales * cfg.ratePercent) / 100;
    }
    return base + productCommission;
  }

  private readTip(
    meta: Record<string, unknown>,
    paymentAmounts: number[],
  ): number {
    if (typeof meta.tipAmount === 'number') return meta.tipAmount;
    if (typeof meta.tip === 'number') return meta.tip;
    void paymentAmounts;
    return 0;
  }

  private copyFor(ctx: ReportContext) {
    if (isKitchenContext(ctx)) {
      return {
        title: 'Server Sales Report',
        labels: {
          sales: 'Sales',
          extra: 'Tables · tip %',
        },
      };
    }
    if (isServiceRevenueContext(ctx)) {
      return {
        title: 'Staff Performance Report',
        labels: {
          sales: 'Service sales',
          extra: 'Tips · rebooking',
        },
      };
    }
    return {
      title: 'Employee Sales Report',
      labels: {
        sales: 'Total sales',
        extra: 'Commission · productivity',
      },
    };
  }

  private parseIds(raw?: string): string[] {
    if (!raw?.trim()) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private shiftYmd(ymd: string, deltaDays: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().slice(0, 10);
  }
}
