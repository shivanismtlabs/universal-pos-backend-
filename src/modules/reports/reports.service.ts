import { Injectable } from '@nestjs/common';
import {
  OrderItemKind,
  OrderStatus,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
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
}
