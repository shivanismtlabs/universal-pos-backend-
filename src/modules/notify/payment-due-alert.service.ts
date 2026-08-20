import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { NotificationEngineService } from './notification-engine.service';

const DAY_MS = 86_400_000;

@Injectable()
export class PaymentDueAlertService {
  private readonly log = new Logger(PaymentDueAlertService.name);
  private lastScan = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: NotificationEngineService,
  ) {}

  /** At most once per 20 minutes per tenant. */
  async scanTenant(tenantId: string) {
    const prev = this.lastScan.get(tenantId) ?? 0;
    if (Date.now() - prev < 20 * 60_000) return { skipped: true };
    this.lastScan.set(tenantId, Date.now());
    try {
      await this.scanUnsafe(tenantId);
      return { ok: true };
    } catch (e) {
      this.log.warn(
        `due-scan failed: ${e instanceof Error ? e.message : e}`,
      );
      return { ok: false };
    }
  }

  private async scanUnsafe(tenantId: string) {
    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const weekAhead = new Date(startOfToday.getTime() + 7 * DAY_MS);

    const invoices = await this.prisma.supplierInvoice.findMany({
      where: {
        tenantId,
        status: { in: ['open', 'partial'] },
        dueDate: { not: null, lte: weekAhead },
      },
      include: { supplier: { select: { name: true } } },
      take: 40,
    });
    for (const inv of invoices) {
      const due = inv.dueDate!;
      const overdue = due < startOfToday;
      const dueToday =
        due >= startOfToday && due < new Date(startOfToday.getTime() + DAY_MS);
      if (!overdue && !dueToday && due > weekAhead) continue;
      const ymd = due.toISOString().slice(0, 10);
      await this.engine.emit({
        tenantId,
        type: 'payment_due',
        severity: overdue ? 'critical' : 'info',
        title: overdue
          ? `Overdue bill — ${inv.supplier.name}`
          : dueToday
            ? `Pay today — ${inv.supplier.name}`
            : `Bill due this week — ${inv.supplier.name}`,
        body: overdue
          ? `${inv.invoiceNumber} was due on ${ymd}. Pay the supplier now.`
          : `${inv.invoiceNumber} is due on ${ymd}. Open Purchases → Outstanding.`,
        href: `/purchases/invoices/${inv.id}`,
        dedupeKey: `ap-due:${inv.id}:${ymd}`,
        payload: { invoiceId: inv.id, dueDate: ymd },
      });
    }

    const creditSales = await this.prisma.order.findMany({
      where: {
        tenantId,
        balanceDue: { gt: 0 },
        status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      },
      include: { customer: { select: { fullName: true } } },
      take: 40,
      orderBy: { createdAt: 'asc' },
    });
    for (const o of creditSales) {
      const due = new Date(o.createdAt.getTime() + DAY_MS);
      const overdue = due < startOfToday;
      const ymd = due.toISOString().slice(0, 10);
      await this.engine.emit({
        tenantId,
        type: 'payment_due',
        severity: overdue ? 'critical' : 'info',
        title: overdue
          ? `Customer payment overdue — ${o.customer?.fullName ?? 'Walk-in'}`
          : `Collect payment — ${o.customer?.fullName ?? 'Walk-in'}`,
        body: `${o.orderNumber} still has money due. Open the order and collect.`,
        href: `/orders/view?id=${o.id}`,
        dedupeKey: `ar-due:${o.id}:${ymd}`,
        payload: { orderId: o.id },
      });
    }

    const emis = await this.prisma.payment.findMany({
      where: {
        tenantId,
        method: PaymentMethod.emi,
        status: PaymentStatus.succeeded,
      },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            customer: { select: { fullName: true } },
          },
        },
      },
      take: 80,
    });
    for (const p of emis) {
      const payload =
        p.gatewayPayload && typeof p.gatewayPayload === 'object'
          ? (p.gatewayPayload as Record<string, unknown>)
          : {};
      const months = Number(payload.emiTenureMonths ?? 0);
      if (!(months > 0)) continue;
      const start = p.createdAt;
      for (let i = 1; i <= months; i++) {
        const inst = new Date(start);
        inst.setUTCMonth(inst.getUTCMonth() + i);
        const weekStart = new Date(inst.getTime() - 7 * DAY_MS);
        if (now < weekStart || now > new Date(inst.getTime() + DAY_MS)) {
          continue;
        }
        const ymd = inst.toISOString().slice(0, 10);
        await this.engine.emit({
          tenantId,
          type: 'payment_due',
          severity: 'info',
          title: `EMI installment ${i}/${months} — ${p.order.customer?.fullName ?? 'Customer'}`,
          body: `${p.order.orderNumber}: EMI is due on ${ymd} (${payload.emiProvider ?? 'EMI'}).`,
          href: `/orders/view?id=${p.order.id}`,
          dedupeKey: `emi:${p.id}:${i}`,
          payload: { paymentId: p.id, installment: i },
        });
      }
    }
  }
}
