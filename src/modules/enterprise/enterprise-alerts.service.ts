import { Injectable } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { NotificationEngineService } from '../notify/notification-engine.service';
import { ymdInZone, zonedLocalToUtc } from '../reports/reports.util';

@Injectable()
export class EnterpriseAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotificationEngineService,
  ) {}

  async listRules(groupId: string) {
    return this.prisma.exceptionAlertRule.findMany({
      where: { businessGroupId: groupId },
      orderBy: { type: 'asc' },
    });
  }

  async updateRule(
    groupId: string,
    id: string,
    data: { enabled?: boolean; threshold?: number; cooldownMinutes?: number },
  ) {
    return this.prisma.exceptionAlertRule.update({
      where: { id },
      data: {
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        ...(data.threshold !== undefined ? { threshold: data.threshold } : {}),
        ...(data.cooldownMinutes !== undefined
          ? { cooldownMinutes: data.cooldownMinutes }
          : {}),
      },
    });
  }

  async evaluateGroup(groupId: string) {
    const rules = await this.prisma.exceptionAlertRule.findMany({
      where: { businessGroupId: groupId, enabled: true },
    });
    const tenants = await this.prisma.tenant.findMany({
      where: { businessGroupId: groupId, status: 'active' },
      select: { id: true, name: true, timezone: true },
    });
    const fired: Array<{ type: string; tenantId: string; message: string }> = [];
    for (const tenant of tenants) {
      for (const rule of rules) {
        if (rule.lastFiredAt) {
          const wait = (rule.cooldownMinutes || 360) * 60_000;
          if (Date.now() - rule.lastFiredAt.getTime() < wait) continue;
        }
        const hit = await this.check(rule.type, tenant.id, Number(rule.threshold ?? 0), tenant.timezone);
        if (!hit) continue;
        await this.notify.emit({
          tenantId: tenant.id,
          type: this.notifyType(rule.type),
          title: `Exception: ${rule.type.replace(/_/g, ' ')}`,
          body: `${tenant.name}: ${hit}`,
          severity: 'critical',
          href: '/group',
          recipientRoles: ['admin', 'manager', 'accountant'],
          dedupeKey: `ent:${rule.id}:${tenant.id}`,
          payload: { ruleId: rule.id, type: rule.type },
        });
        await this.prisma.exceptionAlertRule.update({
          where: { id: rule.id },
          data: { lastFiredAt: new Date() },
        });
        fired.push({ type: rule.type, tenantId: tenant.id, message: hit });
      }
    }
    return { fired };
  }

  private notifyType(ruleType: string) {
    if (ruleType.includes('stock')) return 'low_stock';
    if (ruleType.includes('ap') || ruleType.includes('ar') || ruleType.includes('expense')) {
      return 'payment_due';
    }
    return 'inventory_alert';
  }

  private async check(
    type: string,
    tenantId: string,
    threshold: number,
    timezone: string,
  ): Promise<string | null> {
    const today = ymdInZone(new Date(), timezone);
    const start = zonedLocalToUtc(today, 0, 0, 0, 0, timezone);
    const end = zonedLocalToUtc(today, 23, 59, 59, 999, timezone);
    switch (type) {
      case 'large_refund': {
        const agg = await this.prisma.payment.aggregate({
          where: {
            tenantId,
            type: { in: ['refund', 'deposit_refund'] },
            status: PaymentStatus.succeeded,
            createdAt: { gte: start, lte: end },
            amount: { gte: threshold || 5000 },
          },
          _max: { amount: true },
        });
        const amt = Number(agg._max.amount ?? 0);
        return amt > 0 ? `Refund of ${amt}` : null;
      }
      case 'unusual_discount': {
        const orders = await this.prisma.order.findMany({
          where: {
            tenantId,
            createdAt: { gte: start, lte: end },
            discountTotal: { gt: 0 },
            status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
          },
          select: { discountTotal: true, subtotal: true },
          take: 200,
        });
        const hit = orders.find((o) => {
          const sub = Number(o.subtotal);
          return sub > 0 && Number(o.discountTotal) / sub > 0.2;
        });
        return hit ? 'Discount over 20% on a sale' : null;
      }
      case 'overdue_ap': {
        const n = await this.prisma.supplierInvoice.count({
          where: {
            tenantId,
            status: { in: ['open', 'partial'] },
            dueDate: { lt: new Date() },
          },
        });
        return n > 0 ? `${n} overdue supplier invoices` : null;
      }
      case 'overdue_ar': {
        const n = await this.prisma.order.count({
          where: {
            tenantId,
            balanceDue: { gt: 0 },
            createdAt: { lt: new Date(Date.now() - 7 * 86400000) },
            status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
          },
        });
        return n > 0 ? `${n} overdue customer balances` : null;
      }
      case 'low_stock': {
        const rows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
          SELECT COUNT(*)::bigint AS n FROM stock_levels
          WHERE tenant_id = ${tenantId}::uuid
            AND reorder_point IS NOT NULL
            AND qty_on_hand <= reorder_point
        `;
        const n = Number(rows[0]?.n ?? 0);
        return n > 0 ? `${n} low-stock items` : null;
      }
      case 'negative_margin': {
        return null;
      }
      case 'sales_drop': {
        return null;
      }
      default:
        return null;
    }
  }
}
