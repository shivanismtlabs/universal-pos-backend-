import { Injectable } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { DateRangeQueryDto } from './dto/reports.dto';

/**
 * Universal reports against Order / Payment / StockUnit (not legacy rentalOrder).
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async salesSummary(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.buildDateFilter(query);
    const where: Prisma.OrderWhereInput = {
      tenantId: user.tenantId,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      ...(createdAt ? { createdAt } : {}),
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
      byMethod: byMethod.map((row) => ({
        method: row.method,
        count: row._count._all,
        amount: row._sum.amount ?? 0,
      })),
    };
  }

  async inventoryUtilization(user: AuthUser) {
    const rows = await this.prisma.stockUnit.groupBy({
      by: ['status'],
      where: { tenantId: user.tenantId },
      _count: { _all: true },
    });

    const saleStock = await this.prisma.stockLevel.aggregate({
      where: { tenantId: user.tenantId },
      _sum: { qtyOnHand: true },
      _count: { _all: true },
    });

    return {
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

  async balances(user: AuthUser) {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        balanceDue: { gt: 0 },
        status: { notIn: [OrderStatus.cancelled, OrderStatus.closed] },
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
}
