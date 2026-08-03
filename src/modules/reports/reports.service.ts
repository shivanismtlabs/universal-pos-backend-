import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { DateRangeQueryDto } from './dto/reports.dto';

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async salesSummary(user: AuthUser, query: DateRangeQueryDto) {
    const createdAt = this.buildDateFilter(query);
    const where: Prisma.RentalOrderWhereInput = {
      tenantId: user.tenantId,
      ...(createdAt ? { createdAt } : {}),
    };

    const [byStatus, totals] = await Promise.all([
      this.prisma.rentalOrder.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
      this.prisma.rentalOrder.aggregate({
        where,
        _sum: { subtotal: true, taxTotal: true, balanceDue: true },
      }),
    ]);

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      byStatus: byStatus.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      totals: {
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
    const rows = await this.prisma.inventoryUnit.groupBy({
      by: ['availabilityStatus'],
      where: { tenantId: user.tenantId },
      _count: { _all: true },
    });

    return {
      byAvailabilityStatus: rows.map((row) => ({
        availabilityStatus: row.availabilityStatus,
        count: row._count._all,
      })),
    };
  }

  async balances(user: AuthUser) {
    const orders = await this.prisma.rentalOrder.findMany({
      where: { tenantId: user.tenantId, balanceDue: { gt: 0 } },
      orderBy: { balanceDue: 'desc' },
      take: 50,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        balanceDue: true,
        pickupDate: true,
        returnDueDate: true,
        customer: { select: { id: true, fullName: true, phone: true } },
      },
    });

    return { items: orders };
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
