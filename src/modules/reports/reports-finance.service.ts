import { Injectable } from '@nestjs/common';
import {
  OrderStatus,
  PaymentStatus,
  PaymentType,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type { DateRangeQueryDto } from './dto/reports.dto';
import { round2, ymdInZone, zonedLocalToUtc } from './reports.util';

/**
 * Finance reports — tax, suppliers/AP, cash flow, expenses.
 * Reuses Order/Payment/Invoice/Expense/SupplierInvoice data (no duplicates).
 */
@Injectable()
export class ReportsFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async taxReport(user: AuthUser, query: DateRangeQueryDto) {
    const ctx = await this.context(user);
    const { from, to, fromYmd, toYmd } = this.range(query, ctx.timeZone);

    const orderWhere = {
      tenantId: user.tenantId,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      createdAt: { gte: from, lte: to },
      ...(query.locationId ? { locationId: query.locationId } : {}),
    };

    const invoiceWhere = {
      tenantId: user.tenantId,
      createdAt: { gte: from, lte: to },
      ...(query.locationId
        ? { order: { locationId: query.locationId } }
        : {}),
    };

    const [ordersAgg, invoices, invoiceRows, purchaseTax] = await Promise.all([
      this.prisma.order.aggregate({
        where: orderWhere,
        _sum: { taxTotal: true, subtotal: true, discountTotal: true },
        _count: { _all: true },
      }),
      this.prisma.invoice.aggregate({
        where: invoiceWhere,
        _sum: { cgst: true, sgst: true, igst: true, grandTotal: true },
        _count: true,
      }),
      this.prisma.invoice.findMany({
        where: invoiceWhere,
        select: {
          invoiceNumber: true,
          createdAt: true,
          cgst: true,
          sgst: true,
          igst: true,
          grandTotal: true,
          order: {
            select: {
              orderNumber: true,
              subtotal: true,
              location: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      this.prisma.supplierInvoice.aggregate({
        where: {
          tenantId: user.tenantId,
          invoiceDate: {
            gte: new Date(`${fromYmd}T00:00:00.000Z`),
            lte: new Date(`${toYmd}T00:00:00.000Z`),
          },
          status: { not: 'void' },
        },
        _sum: { taxTotal: true, subtotal: true, grandTotal: true },
        _count: true,
      }),
    ]);

    const outputTax = round2(Number(ordersAgg._sum.taxTotal ?? 0));
    const cgst = round2(Number(invoices._sum?.cgst ?? 0));
    const sgst = round2(Number(invoices._sum?.sgst ?? 0));
    const igst = round2(Number(invoices._sum?.igst ?? 0));
    const invoiceTax = round2(cgst + sgst + igst);
    const inputTax = round2(Number(purchaseTax._sum?.taxTotal ?? 0));
    const netTaxPayable = round2(Math.max(outputTax, invoiceTax) - inputTax);

    return {
      generatedAt: new Date().toISOString(),
      ...this.meta(ctx, fromYmd, toYmd, query.locationId),
      summary: {
        taxableSales: round2(Number(ordersAgg._sum.subtotal ?? 0)),
        outputTax,
        invoiceTax,
        cgst,
        sgst,
        igst,
        inputTax,
        netTaxPayable,
        orderCount: ordersAgg._count._all,
        invoiceCount: invoices._count,
        purchaseInvoiceCount: purchaseTax._count,
      },
      breakdown: [
        { key: 'cgst', label: 'CGST', amount: cgst },
        { key: 'sgst', label: 'SGST', amount: sgst },
        { key: 'igst', label: 'IGST', amount: igst },
        { key: 'output', label: 'Output tax (orders)', amount: outputTax },
        { key: 'input', label: 'Input tax (purchases)', amount: inputTax },
        { key: 'net', label: 'Net tax payable', amount: netTaxPayable },
      ],
      invoices: invoiceRows.map((r) => ({
        invoiceNumber: r.invoiceNumber,
        orderNumber: r.order?.orderNumber ?? null,
        branch: r.order?.location?.name ?? null,
        date: ymdInZone(r.createdAt, ctx.timeZone),
        taxable: round2(Number(r.order?.subtotal ?? 0)),
        cgst: round2(Number(r.cgst ?? 0)),
        sgst: round2(Number(r.sgst ?? 0)),
        igst: round2(Number(r.igst ?? 0)),
        grandTotal: round2(Number(r.grandTotal ?? 0)),
      })),
    };
  }

  async supplierReport(user: AuthUser, query: DateRangeQueryDto) {
    const ctx = await this.context(user);
    const { from, to, fromYmd, toYmd } = this.range(query, ctx.timeZone);
    const todayYmd = ymdInZone(new Date(), ctx.timeZone);
    const today = new Date(`${todayYmd}T00:00:00.000Z`);

    const [invoices, payments, pos] = await Promise.all([
      this.prisma.supplierInvoice.findMany({
        where: {
          tenantId: user.tenantId,
          status: { not: 'void' },
          invoiceDate: {
            gte: new Date(`${fromYmd}T00:00:00.000Z`),
            lte: new Date(`${toYmd}T00:00:00.000Z`),
          },
        },
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          dueDate: true,
          grandTotal: true,
          amountPaid: true,
          taxTotal: true,
          status: true,
          supplier: { select: { id: true, name: true } },
        },
        take: 5000,
      }),
      this.prisma.supplierPayment.findMany({
        where: {
          tenantId: user.tenantId,
          paidAt: { gte: from, lte: to },
        },
        select: {
          amount: true,
          method: true,
          paidAt: true,
          supplier: { select: { id: true, name: true } },
        },
        take: 5000,
      }),
      this.prisma.purchaseOrder.findMany({
        where: {
          tenantId: user.tenantId,
          createdAt: { gte: from, lte: to },
        },
        select: {
          id: true,
          status: true,
          supplierId: true,
          supplier: { select: { id: true, name: true } },
        },
        take: 3000,
      }),
    ]);

    type Row = {
      supplierId: string;
      supplierName: string;
      invoiceCount: number;
      billed: number;
      paid: number;
      outstanding: number;
      tax: number;
      poCount: number;
      aging: { d0_30: number; d30_60: number; d60_90: number; d90: number };
    };
    const map = new Map<string, Row>();
    const ensure = (id: string, name: string) => {
      const r =
        map.get(id) ??
        ({
          supplierId: id,
          supplierName: name,
          invoiceCount: 0,
          billed: 0,
          paid: 0,
          outstanding: 0,
          tax: 0,
          poCount: 0,
          aging: { d0_30: 0, d30_60: 0, d60_90: 0, d90: 0 },
        } satisfies Row);
      map.set(id, r);
      return r;
    };

    for (const inv of invoices) {
      const r = ensure(inv.supplier.id, inv.supplier.name);
      const total = Number(inv.grandTotal);
      const paid = Number(inv.amountPaid);
      const due = Math.max(0, total - paid);
      r.invoiceCount += 1;
      r.billed += total;
      r.paid += paid;
      r.outstanding += due;
      r.tax += Number(inv.taxTotal);
      if (due > 0) {
        const dueDate = inv.dueDate ?? inv.invoiceDate;
        const dueYmd = dueDate.toISOString().slice(0, 10);
        const days = Math.max(
          0,
          Math.round(
            (today.getTime() - new Date(`${dueYmd}T00:00:00.000Z`).getTime()) /
              86_400_000,
          ),
        );
        if (days <= 30) r.aging.d0_30 += due;
        else if (days <= 60) r.aging.d30_60 += due;
        else if (days <= 90) r.aging.d60_90 += due;
        else r.aging.d90 += due;
      }
    }
    for (const p of payments) {
      const r = ensure(p.supplier.id, p.supplier.name);
      // period payments may exceed invoice.paid in window — track separately via billed/paid from invoices
      void p;
    }
    for (const po of pos) {
      const r = ensure(po.supplier.id, po.supplier.name);
      r.poCount += 1;
    }

    const suppliers = [...map.values()]
      .map((r) => ({
        ...r,
        billed: round2(r.billed),
        paid: round2(r.paid),
        outstanding: round2(r.outstanding),
        tax: round2(r.tax),
        aging: {
          d0_30: round2(r.aging.d0_30),
          d30_60: round2(r.aging.d30_60),
          d60_90: round2(r.aging.d60_90),
          d90: round2(r.aging.d90),
        },
      }))
      .sort((a, b) => b.billed - a.billed);

    const agingTotals = {
      d0_30: round2(suppliers.reduce((s, r) => s + r.aging.d0_30, 0)),
      d30_60: round2(suppliers.reduce((s, r) => s + r.aging.d30_60, 0)),
      d60_90: round2(suppliers.reduce((s, r) => s + r.aging.d60_90, 0)),
      d90: round2(suppliers.reduce((s, r) => s + r.aging.d90, 0)),
    };

    return {
      generatedAt: new Date().toISOString(),
      ...this.meta(ctx, fromYmd, toYmd, query.locationId),
      summary: {
        supplierCount: suppliers.length,
        totalBilled: round2(suppliers.reduce((s, r) => s + r.billed, 0)),
        totalPaid: round2(suppliers.reduce((s, r) => s + r.paid, 0)),
        totalOutstanding: round2(
          suppliers.reduce((s, r) => s + r.outstanding, 0),
        ),
        purchaseTax: round2(suppliers.reduce((s, r) => s + r.tax, 0)),
        poCount: pos.length,
        paymentsInPeriod: round2(
          payments.reduce((s, p) => s + Number(p.amount), 0),
        ),
      },
      agingBuckets: [
        { key: '0_30', label: '0–30 days', amount: agingTotals.d0_30, severity: 'watch' },
        { key: '30_60', label: '30–60 days', amount: agingTotals.d30_60, severity: 'medium' },
        { key: '60_90', label: '60–90 days', amount: agingTotals.d60_90, severity: 'high' },
        { key: '90_plus', label: '90+ days', amount: agingTotals.d90, severity: 'critical' },
      ],
      suppliers,
    };
  }

  async cashFlow(user: AuthUser, query: DateRangeQueryDto) {
    const ctx = await this.context(user);
    const { from, to, fromYmd, toYmd } = this.range(query, ctx.timeZone);

    const [payments, expenses, supplierPays, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          tenantId: user.tenantId,
          status: PaymentStatus.succeeded,
          type: { in: [PaymentType.payment, PaymentType.deposit] },
          createdAt: { gte: from, lte: to },
          ...(query.locationId
            ? { order: { locationId: query.locationId } }
            : {}),
        },
        select: { amount: true, method: true, createdAt: true, type: true },
        take: 50000,
      }),
      this.prisma.expense.findMany({
        where: {
          tenantId: user.tenantId,
          status: 'approved',
          spentAt: {
            gte: new Date(`${fromYmd}T00:00:00.000Z`),
            lte: new Date(`${toYmd}T00:00:00.000Z`),
          },
          ...(query.locationId ? { locationId: query.locationId } : {}),
        },
        select: { amount: true, spentAt: true, paymentMethod: true, isPettyCash: true },
        take: 10000,
      }),
      this.prisma.supplierPayment.findMany({
        where: {
          tenantId: user.tenantId,
          paidAt: { gte: from, lte: to },
        },
        select: { amount: true, paidAt: true, method: true },
        take: 10000,
      }),
      this.prisma.payment.findMany({
        where: {
          tenantId: user.tenantId,
          status: PaymentStatus.succeeded,
          type: {
            in: [PaymentType.refund, PaymentType.deposit_refund],
          },
          createdAt: { gte: from, lte: to },
          ...(query.locationId
            ? { order: { locationId: query.locationId } }
            : {}),
        },
        select: { amount: true, createdAt: true },
        take: 10000,
      }),
    ]);

    const cashIn = payments.reduce((s, p) => s + Number(p.amount), 0);
    const cashOutExpenses = expenses.reduce((s, e) => s + Number(e.amount), 0);
    const cashOutSuppliers = supplierPays.reduce(
      (s, p) => s + Number(p.amount),
      0,
    );
    const cashOutRefunds = refunds.reduce(
      (s, p) => s + Math.abs(Number(p.amount)),
      0,
    );
    const cashOut = cashOutExpenses + cashOutSuppliers + cashOutRefunds;
    const netCash = cashIn - cashOut;

    const byDay = new Map<
      string,
      { date: string; inflow: number; outflow: number; net: number }
    >();
    const bump = (ymd: string, field: 'inflow' | 'outflow', amt: number) => {
      const row = byDay.get(ymd) ?? {
        date: ymd,
        inflow: 0,
        outflow: 0,
        net: 0,
      };
      row[field] += amt;
      row.net = row.inflow - row.outflow;
      byDay.set(ymd, row);
    };

    for (const p of payments) {
      bump(ymdInZone(p.createdAt, ctx.timeZone), 'inflow', Number(p.amount));
    }
    for (const e of expenses) {
      bump(e.spentAt.toISOString().slice(0, 10), 'outflow', Number(e.amount));
    }
    for (const p of supplierPays) {
      bump(ymdInZone(p.paidAt, ctx.timeZone), 'outflow', Number(p.amount));
    }
    for (const p of refunds) {
      bump(
        ymdInZone(p.createdAt, ctx.timeZone),
        'outflow',
        Math.abs(Number(p.amount)),
      );
    }

    const series = [...byDay.values()]
      .map((r) => ({
        ...r,
        inflow: round2(r.inflow),
        outflow: round2(r.outflow),
        net: round2(r.net),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const byMethodIn = new Map<string, number>();
    for (const p of payments) {
      byMethodIn.set(
        p.method,
        (byMethodIn.get(p.method) ?? 0) + Number(p.amount),
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      ...this.meta(ctx, fromYmd, toYmd, query.locationId),
      summary: {
        cashIn: round2(cashIn),
        cashOut: round2(cashOut),
        netCash: round2(netCash),
        customerReceipts: round2(cashIn),
        expenses: round2(cashOutExpenses),
        supplierPayments: round2(cashOutSuppliers),
        refunds: round2(cashOutRefunds),
        pettyCash: round2(
          expenses
            .filter((e) => e.isPettyCash)
            .reduce((s, e) => s + Number(e.amount), 0),
        ),
      },
      operating: [
        { key: 'receipts', label: 'Customer receipts', amount: round2(cashIn) },
        {
          key: 'expenses',
          label: 'Operating expenses',
          amount: -round2(cashOutExpenses),
        },
        {
          key: 'suppliers',
          label: 'Supplier / AP payments',
          amount: -round2(cashOutSuppliers),
        },
        {
          key: 'refunds',
          label: 'Refunds to customers',
          amount: -round2(cashOutRefunds),
        },
        { key: 'net', label: 'Net operating cash', amount: round2(netCash) },
      ],
      inflowByMethod: [...byMethodIn.entries()]
        .map(([method, amount]) => ({ method, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount),
      series,
    };
  }

  async expenseReport(user: AuthUser, query: DateRangeQueryDto) {
    const ctx = await this.context(user);
    const { fromYmd, toYmd } = this.range(query, ctx.timeZone);

    const items = await this.prisma.expense.findMany({
      where: {
        tenantId: user.tenantId,
        status: 'approved',
        spentAt: {
          gte: new Date(`${fromYmd}T00:00:00.000Z`),
          lte: new Date(`${toYmd}T00:00:00.000Z`),
        },
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
      include: {
        category: { select: { id: true, name: true } },
        location: { select: { id: true, name: true } },
        createdBy: { select: { fullName: true } },
      },
      orderBy: { spentAt: 'desc' },
      take: 2000,
    });

    const byCategory = new Map<
      string,
      { categoryId: string | null; name: string; amount: number; count: number }
    >();
    const byDay = new Map<string, number>();
    let pettyCash = 0;

    for (const e of items) {
      const key = e.categoryId ?? 'uncategorized';
      const name = e.category?.name ?? 'Uncategorized';
      const row = byCategory.get(key) ?? {
        categoryId: e.categoryId,
        name,
        amount: 0,
        count: 0,
      };
      row.amount += Number(e.amount);
      row.count += 1;
      byCategory.set(key, row);
      const day = e.spentAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + Number(e.amount));
      if (e.isPettyCash) pettyCash += Number(e.amount);
    }

    const total = items.reduce((s, e) => s + Number(e.amount), 0);

    return {
      generatedAt: new Date().toISOString(),
      ...this.meta(ctx, fromYmd, toYmd, query.locationId),
      summary: {
        expenseCount: items.length,
        total: round2(total),
        pettyCash: round2(pettyCash),
        categoryCount: byCategory.size,
      },
      byCategory: [...byCategory.values()]
        .map((r) => ({
          ...r,
          amount: round2(r.amount),
          pct: total > 0 ? round2((r.amount / total) * 100) : 0,
        }))
        .sort((a, b) => b.amount - a.amount),
      series: [...byDay.entries()]
        .map(([date, amount]) => ({ date, amount: round2(amount) }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      items: items.slice(0, 500).map((e) => ({
        id: e.id,
        date: e.spentAt.toISOString().slice(0, 10),
        amount: round2(Number(e.amount)),
        category: e.category?.name ?? 'Uncategorized',
        branch: e.location?.name ?? null,
        paymentMethod: e.paymentMethod,
        isPettyCash: e.isPettyCash,
        notes: e.notes,
        createdBy: e.createdBy?.fullName ?? null,
      })),
    };
  }

  /** Compact KPIs for dashboard charts */
  async dashboardFinance(user: AuthUser, query: DateRangeQueryDto) {
    const [tax, cash, expenses, suppliers] = await Promise.all([
      this.taxReport(user, query),
      this.cashFlow(user, query),
      this.expenseReport(user, query),
      this.supplierReport(user, query),
    ]);
    return {
      period: cash.period,
      tax: {
        outputTax: tax.summary.outputTax,
        inputTax: tax.summary.inputTax,
        netTaxPayable: tax.summary.netTaxPayable,
      },
      cashFlow: {
        cashIn: cash.summary.cashIn,
        cashOut: cash.summary.cashOut,
        netCash: cash.summary.netCash,
        series: cash.series.slice(-14),
      },
      expenses: {
        total: expenses.summary.total,
        byCategory: expenses.byCategory.slice(0, 6),
      },
      suppliers: {
        outstanding: suppliers.summary.totalOutstanding,
        agingBuckets: suppliers.agingBuckets,
      },
    };
  }

  private async context(user: AuthUser) {
    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: {
        name: true,
        timezone: true,
        currencyCode: true,
        businessConfig: { select: { businessType: true } },
      },
    });
    return {
      tenantName: tenant.name,
      timeZone: tenant.timezone || 'Asia/Kolkata',
      currencyCode: tenant.currencyCode || 'INR',
      businessType: tenant.businessConfig?.businessType || 'general',
    };
  }

  private meta(
    ctx: {
      tenantName: string;
      timeZone: string;
      currencyCode: string;
      businessType: string;
    },
    fromYmd: string,
    toYmd: string,
    locationId?: string,
  ) {
    return {
      tenantName: ctx.tenantName,
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      businessType: ctx.businessType,
      period: { from: fromYmd, to: toYmd },
      filters: { locationId: locationId ?? null },
    };
  }

  private range(query: DateRangeQueryDto, timeZone: string) {
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

  private shiftYmd(ymd: string, deltaDays: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().slice(0, 10);
  }
}
