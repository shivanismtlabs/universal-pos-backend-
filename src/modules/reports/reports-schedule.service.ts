import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { NotifyService } from '../notify/notify.service';
import type { AuthUser } from '../auth/types';
import type { UpsertReportSchedulesDto } from './dto/reports.dto';
import { ReportsService } from './reports.service';
import { ReportsModesService } from './reports-modes.service';
import {
  parseReportsSettings,
  type ReportSchedule,
  ymdInZone,
} from './reports.util';

@Injectable()
export class ReportsScheduleService {
  private readonly log = new Logger(ReportsScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
    private readonly reports: ReportsService,
    private readonly modes: ReportsModesService,
  ) {}

  async list(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    const packs = await this.modes.packs(user);
    return {
      schedules: parseReportsSettings(tenant?.settings).schedules ?? [],
      availableKeys: this.keysForPacks(packs),
      packs,
    };
  }

  async upsert(user: AuthUser, dto: UpsertReportSchedulesDto) {
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
    const prev = parseReportsSettings(tenant?.settings).schedules ?? [];
    const prevById = new Map(prev.map((s) => [s.id, s]));
    const schedules: ReportSchedule[] = dto.items.map((item, i) => {
      const id =
        item.id?.trim() ||
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `sch-${Date.now()}-${i}`);
      const existing = prevById.get(id);
      return {
        id,
        reportKey: item.reportKey,
        cadence: item.cadence,
        recipients: item.recipients.map((e) => e.trim()).filter(Boolean),
        enabled: item.enabled ?? existing?.enabled ?? true,
        lastSentFor: existing?.lastSentFor ?? null,
      };
    });
    reports.schedules = schedules;
    root.reports = reports;
    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { settings: root as Prisma.InputJsonValue },
    });
    return { schedules };
  }

  /**
   * Cron-friendly: send every enabled schedule that is due in the tenant TZ.
   */
  async sendDue(user: AuthUser, force = false) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true, timezone: true, name: true },
    });
    const timezone = tenant?.timezone || 'Asia/Kolkata';
    const today = ymdInZone(new Date(), timezone);
    const weekday = new Date(`${today}T12:00:00`).getDay(); // 0 Sun … 1 Mon
    const dayNum = Number(today.slice(8, 10));
    const monthKey = today.slice(0, 7);
    const packs = await this.modes.packs(user);
    const allowed = new Set(this.keysForPacks(packs));
    const cfg = parseReportsSettings(tenant?.settings).schedules ?? [];

    const results: Array<{
      id: string;
      reportKey: string;
      sent: boolean;
      reason?: string;
    }> = [];
    const next = [...cfg];

    for (let i = 0; i < next.length; i++) {
      const sch = next[i]!;
      if (!sch.enabled || !sch.recipients.length) {
        results.push({
          id: sch.id,
          reportKey: sch.reportKey,
          sent: false,
          reason: 'disabled or no recipients',
        });
        continue;
      }
      if (!allowed.has(sch.reportKey)) {
        results.push({
          id: sch.id,
          reportKey: sch.reportKey,
          sent: false,
          reason: 'report pack not enabled for this business',
        });
        continue;
      }
      const periodKey =
        sch.cadence === 'daily'
          ? today
          : sch.cadence === 'weekly'
            ? today
            : monthKey;
      const due =
        force ||
        (sch.cadence === 'daily' && sch.lastSentFor !== today) ||
        (sch.cadence === 'weekly' &&
          weekday === 1 &&
          sch.lastSentFor !== today) ||
        (sch.cadence === 'monthly' &&
          dayNum === 1 &&
          sch.lastSentFor !== monthKey);
      if (!due) {
        results.push({
          id: sch.id,
          reportKey: sch.reportKey,
          sent: false,
          reason: 'not due',
        });
        continue;
      }

      try {
        const body = await this.renderBody(user, sch.reportKey, today, tenant?.name);
        for (const email of sch.recipients) {
          await this.notify.send(user, {
            channel: NotificationChannel.email,
            email,
            templateKey: 'scheduled_report',
            payload: {
              subject: `Universal POS · ${this.label(sch.reportKey)} · ${periodKey}`,
              message: body,
              body,
            },
          });
        }
        next[i] = { ...sch, lastSentFor: periodKey };
        results.push({ id: sch.id, reportKey: sch.reportKey, sent: true });
      } catch (e) {
        this.log.warn(`Schedule ${sch.id} failed: ${String(e)}`);
        results.push({
          id: sch.id,
          reportKey: sch.reportKey,
          sent: false,
          reason: e instanceof Error ? e.message : 'send failed',
        });
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
    reports.schedules = next;
    root.reports = reports;
    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: { settings: root as Prisma.InputJsonValue },
    });

    return { today, sent: results.filter((r) => r.sent).length, results };
  }

  private keysForPacks(packs: {
    sale: boolean;
    rental: boolean;
    subscription: boolean;
    inventory: boolean;
  }) {
    const keys: string[] = ['sales_summary', 'daily_sales'];
    if (packs.rental) keys.push('rental_ops');
    if (packs.subscription) keys.push('subscriptions');
    if (packs.inventory) keys.push('inventory_utilization');
    return keys;
  }

  private label(key: string) {
    switch (key) {
      case 'daily_sales':
        return 'Daily activity';
      case 'rental_ops':
        return 'Rental / asset ops';
      case 'subscriptions':
        return 'Plans & memberships';
      case 'inventory_utilization':
        return 'Inventory';
      default:
        return 'Sales summary';
    }
  }

  private async renderBody(
    user: AuthUser,
    key: string,
    today: string,
    shopName?: string | null,
  ) {
    const header = `${shopName ?? 'Universal POS'} — ${this.label(key)}`;
    if (key === 'daily_sales') {
      const d = await this.reports.dailySales(user, { date: today });
      const s = d.summary;
      return [
        header,
        `Date: ${today}`,
        `Orders: ${s.orderCount}`,
        `Net revenue: ${s.netRevenue}`,
        `AOV: ${s.avgOrderValue}`,
        `Refunds: ${s.refunds}`,
      ].join('\n');
    }
    if (key === 'rental_ops') {
      const d = await this.modes.rentalOps(user, {});
      const s = d.summary;
      return [
        header,
        `Rental orders: ${s.orderCount}`,
        `Revenue: ${s.revenue}`,
        `Units out: ${s.unitsOut} / ${s.unitsTotal}`,
        `Utilization: ${s.utilizationPct ?? '—'}%`,
        `Overdue: ${s.overdueCount}`,
        `Open deposits: ${s.openDeposits}`,
      ].join('\n');
    }
    if (key === 'subscriptions') {
      const d = await this.modes.subscriptions(user, {});
      const s = d.summary;
      return [
        header,
        `Active plans: ${s.active}`,
        `Monthly recurring: ${s.monthlyRecurring}`,
        `Started: ${s.startedInPeriod}`,
        `Cancelled: ${s.cancelledInPeriod}`,
        `Check-ins: ${s.checkInsInPeriod}`,
      ].join('\n');
    }
    if (key === 'inventory_utilization') {
      const d = await this.reports.inventoryUtilization(user, {});
      return [
        header,
        `Tracked SKUs: ${d.saleStock.skuCount}`,
        `Qty on hand: ${d.saleStock.qtyOnHand}`,
        ...d.byAvailabilityStatus.map(
          (r) => `${r.availabilityStatus}: ${r.count}`,
        ),
      ].join('\n');
    }
    const d = await this.reports.salesSummary(user, {});
    return [
      header,
      `Orders: ${d.totals.orderCount}`,
      `Subtotal: ${d.totals.subtotal}`,
      `Tax: ${d.totals.taxTotal}`,
      `Balance due: ${d.totals.balanceDue}`,
      ...(d.byKind ?? []).map(
        (k) => `${k.kind}: ${k.count} / ${k.subtotal}`,
      ),
    ].join('\n');
  }
}
