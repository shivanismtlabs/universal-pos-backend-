import { Injectable } from '@nestjs/common';
import {
  OrderItemKind,
  OrderKind,
  OrderStatus,
  PaymentStatus,
  PaymentType,
  ProductKind,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type { ProfitAndLossQueryDto } from './dto/reports.dto';
import {
  dayRange,
  pad2,
  pctChange,
  round2,
  shiftMonth,
  ymdInZone,
} from './reports.util';
import {
  isServiceRevenueContext,
  reportContextFromSettings,
} from '../../common/report-capabilities';

type CostingMethod = 'standard' | 'weighted_average' | 'fifo';

type PnLBlock = {
  grossSales: number;
  returnsRefunds: number;
  discounts: number;
  netSales: number;
  cogs: number;
  costOfService: number;
  totalDirectCost: number;
  grossProfit: number;
  grossMarginPct: number | null;
  operatingExpenses: number;
  expensesByCategory: Array<{
    categoryId: string | null;
    name: string;
    amount: number;
  }>;
  operatingProfit: number;
  taxCollected: number;
  taxExpense: number;
  netProfit: number;
  netMarginPct: number | null;
};

/**
 * Classic P&L for owners/accountants — universal across retail & service.
 * COGS uses catalog/GRN costs (standard | weighted_average | fifo approx).
 */
@Injectable()
export class ReportsPnlService {
  constructor(private readonly prisma: PrismaService) {}

  async profitAndLoss(user: AuthUser, query: ProfitAndLossQueryDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: {
        name: true,
        timezone: true,
        currencyCode: true,
        settings: true,
        taxMode: true,
        businessConfig: { select: { businessType: true } },
      },
    });
    const timezone = tenant?.timezone || 'Asia/Kolkata';
    const currencyCode = tenant?.currencyCode || 'INR';
    const businessType =
      tenant?.businessConfig?.businessType ||
      (tenant?.settings as { businessType?: string } | null)?.businessType ||
      'general';
    const reportCtx = reportContextFromSettings(tenant?.settings);
    const costingMethod = this.resolveCostingMethod(
      query.costingMethod,
      tenant?.settings,
    );
    const locationIds = this.parseLocationIds(query.locationIds);
    const range = this.resolveRange(query, timezone);
    const compare = query.compare !== false; // default on

    const current = await this.buildBlock(
      user.tenantId,
      range,
      locationIds,
      costingMethod,
      reportCtx,
      tenant?.taxMode ?? null,
    );

    let previous: (PnLBlock & { from: string; to: string }) | null = null;
    if (compare) {
      const prevRange = this.previousEqualRange(range, timezone);
      const block = await this.buildBlock(
        user.tenantId,
        prevRange,
        locationIds,
        costingMethod,
        reportCtx,
        tenant?.taxMode ?? null,
      );
      previous = {
        ...block,
        from: prevRange.fromYmd,
        to: prevRange.toYmd,
      };
    }

    const statement = this.toStatementLines(current, reportCtx);
    const waterfall = [
      { key: 'revenue', label: 'Net Sales', value: current.netSales },
      { key: 'cogs', label: 'Direct costs', value: -current.totalDirectCost },
      { key: 'gross', label: 'Gross Profit', value: current.grossProfit },
      {
        key: 'opex',
        label: 'Operating Expenses',
        value: -current.operatingExpenses,
      },
      {
        key: 'tax',
        label: 'Tax expense',
        value: -current.taxExpense,
      },
      { key: 'net', label: 'Net Profit', value: current.netProfit },
    ];

    return {
      tenantName: tenant?.name ?? 'Business',
      timezone,
      currencyCode,
      businessType,
      capabilities: reportCtx.capabilities,
      taxMode: tenant?.taxMode ?? null,
      costingMethod,
      costingNote:
        costingMethod === 'fifo'
          ? 'FIFO approximated from oldest goods-receipt unit costs; falls back to catalog costPrice.'
          : costingMethod === 'weighted_average'
            ? 'Weighted average from goods-receipt unit costs; falls back to catalog costPrice.'
            : 'Standard catalog costPrice × qty sold.',
      period: {
        from: range.fromYmd,
        to: range.toYmd,
        preset: query.preset ?? 'custom',
        locationIds,
      },
      current,
      previous,
      comparison: previous
        ? {
            netSalesPct: pctChange(current.netSales, previous.netSales),
            grossProfitPct: pctChange(
              current.grossProfit,
              previous.grossProfit,
            ),
            netProfitPct: pctChange(current.netProfit, previous.netProfit),
            opexPct: pctChange(
              current.operatingExpenses,
              previous.operatingExpenses,
            ),
          }
        : null,
      statement,
      waterfall,
    };
  }

  private async buildBlock(
    tenantId: string,
    range: { start: Date; end: Date; fromYmd: string; toYmd: string },
    locationIds: string[],
    costingMethod: CostingMethod,
    reportCtx: ReturnType<typeof reportContextFromSettings>,
    taxMode: string | null,
  ): Promise<PnLBlock> {
    const orderWhere: Prisma.OrderWhereInput = {
      tenantId,
      status: { notIn: [OrderStatus.cancelled, OrderStatus.draft] },
      createdAt: { gte: range.start, lte: range.end },
      ...(locationIds.length ? { locationId: { in: locationIds } } : {}),
    };

    const [saleAgg, returnAgg, refundAgg, items, expenses, invoiceTax] =
      await Promise.all([
        this.prisma.order.aggregate({
          where: {
            ...orderWhere,
            kind: { not: OrderKind.return_order },
          },
          _sum: {
            subtotal: true,
            discountTotal: true,
            taxTotal: true,
          },
          _count: { _all: true },
        }),
        this.prisma.order.aggregate({
          where: {
            ...orderWhere,
            kind: OrderKind.return_order,
          },
          _sum: { subtotal: true, taxTotal: true },
        }),
        this.prisma.payment.aggregate({
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
        }),
        this.prisma.orderItem.findMany({
          where: {
            order: {
              ...orderWhere,
              kind: { not: OrderKind.return_order },
            },
            itemKind: {
              in: [
                OrderItemKind.product,
                OrderItemKind.service,
                OrderItemKind.stock_unit,
                OrderItemKind.custom,
              ],
            },
          },
          select: {
            quantity: true,
            itemKind: true,
            productId: true,
            product: {
              select: {
                id: true,
                costPrice: true,
                kind: true,
              },
            },
          },
        }),
        this.prisma.expense.findMany({
          where: {
            tenantId,
            status: 'approved',
            spentAt: { gte: range.start, lte: range.end },
            ...(locationIds.length
              ? { locationId: { in: locationIds } }
              : {}),
          },
          select: {
            amount: true,
            categoryId: true,
            category: { select: { id: true, name: true } },
          },
        }),
        this.prisma.invoice.aggregate({
          where: {
            tenantId,
            createdAt: { gte: range.start, lte: range.end },
          },
          _sum: { cgst: true, sgst: true, igst: true },
        }),
      ]);

    const grossSales = round2(
      Number(saleAgg._sum.subtotal ?? 0) +
        Number(saleAgg._sum.discountTotal ?? 0),
    );
    const discounts = round2(Number(saleAgg._sum.discountTotal ?? 0));
    const taxCollected = round2(Number(saleAgg._sum.taxTotal ?? 0));
    const returnAbs = round2(
      Math.abs(Number(returnAgg._sum.subtotal ?? 0)) +
        Math.abs(Number(refundAgg._sum.amount ?? 0)),
    );
    const netSales = round2(
      Number(saleAgg._sum.subtotal ?? 0) - Math.abs(Number(refundAgg._sum.amount ?? 0)),
    );

    const productIds = [
      ...new Set(
        items.map((i) => i.productId ?? i.product?.id).filter(Boolean) as string[],
      ),
    ];
    const unitCosts = await this.resolveUnitCosts(
      tenantId,
      productIds,
      costingMethod,
    );

    let cogs = 0;
    let costOfService = 0;
    const isServiceHeavy = isServiceRevenueContext(reportCtx);
    for (const it of items) {
      const pid = it.productId ?? it.product?.id;
      const qty = Number(it.quantity);
      const unit =
        (pid ? unitCosts.get(pid) : null) ??
        Number(it.product?.costPrice ?? 0);
      const lineCost = qty * unit;
      const isServiceLine =
        it.itemKind === OrderItemKind.service ||
        it.product?.kind === ProductKind.service;
      if (isServiceHeavy && isServiceLine) {
        costOfService += lineCost;
      } else {
        cogs += lineCost;
      }
    }
    cogs = round2(cogs);
    costOfService = round2(costOfService);

    // Pull labor-like expenses into Cost of Service for service businesses
    const expMap = new Map<
      string,
      { categoryId: string | null; name: string; amount: number }
    >();
    let operatingExpenses = 0;
    let laborFromExpenses = 0;
    for (const e of expenses) {
      const name = e.category?.name ?? 'Uncategorized';
      const amount = Number(e.amount);
      const key = e.categoryId ?? 'uncategorized';
      if (
        isServiceHeavy &&
        /salar|wage|labor|staff|payroll/i.test(name)
      ) {
        laborFromExpenses += amount;
        continue;
      }
      operatingExpenses += amount;
      const row = expMap.get(key) ?? {
        categoryId: e.categoryId,
        name,
        amount: 0,
      };
      row.amount += amount;
      expMap.set(key, row);
    }
    if (laborFromExpenses > 0) {
      costOfService = round2(costOfService + laborFromExpenses);
    }
    operatingExpenses = round2(operatingExpenses);
    const expensesByCategory = [...expMap.values()]
      .map((r) => ({ ...r, amount: round2(r.amount) }))
      .sort((a, b) => b.amount - a.amount);

    const totalDirectCost = round2(cogs + costOfService);
    const grossProfit = round2(netSales - totalDirectCost);
    const operatingProfit = round2(grossProfit - operatingExpenses);

    const invoiceGst =
      Number(invoiceTax._sum.cgst ?? 0) +
      Number(invoiceTax._sum.sgst ?? 0) +
      Number(invoiceTax._sum.igst ?? 0);
    const taxExpenseRaw = round2(invoiceGst > 0 ? invoiceGst : taxCollected);

    // GST/VAT is typically a pass-through — keep taxCollected informational;
    // taxExpense deducted only for non-GST jurisdictions (or explicit provision).
    const taxesForNet = /gst|vat/i.test(String(taxMode ?? ''))
      ? 0
      : taxExpenseRaw;
    const netProfit = round2(operatingProfit - taxesForNet);

    return {
      grossSales,
      returnsRefunds: returnAbs,
      discounts,
      netSales: round2(Number(saleAgg._sum.subtotal ?? 0)),
      cogs,
      costOfService,
      totalDirectCost,
      grossProfit,
      grossMarginPct:
        Number(saleAgg._sum.subtotal ?? 0) > 0
          ? round2(
              (grossProfit / Number(saleAgg._sum.subtotal ?? 0)) * 100,
            )
          : null,
      operatingExpenses,
      expensesByCategory,
      operatingProfit,
      taxCollected,
      taxExpense: taxesForNet,
      netProfit,
      netMarginPct:
        Number(saleAgg._sum.subtotal ?? 0) > 0
          ? round2(
              (netProfit / Number(saleAgg._sum.subtotal ?? 0)) * 100,
            )
          : null,
    };
  }

  private async resolveUnitCosts(
    tenantId: string,
    productIds: string[],
    method: CostingMethod,
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!productIds.length) return map;

    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds } },
      select: { id: true, costPrice: true },
    });
    for (const p of products) {
      map.set(p.id, Number(p.costPrice ?? 0));
    }
    if (method === 'standard') return map;

    const receipts = await this.prisma.goodsReceiptLine.findMany({
      where: {
        tenantId,
        unitCost: { not: null },
        stockLevel: { productId: { in: productIds } },
      },
      select: {
        unitCost: true,
        qty: true,
        createdAt: true,
        stockLevel: { select: { productId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (method === 'weighted_average') {
      const acc = new Map<string, { cost: number; qty: number }>();
      for (const r of receipts) {
        const pid = r.stockLevel.productId;
        if (!pid) continue;
        const row = acc.get(pid) ?? { cost: 0, qty: 0 };
        const q = Number(r.qty);
        row.cost += Number(r.unitCost) * q;
        row.qty += q;
        acc.set(pid, row);
      }
      for (const [pid, v] of acc) {
        if (v.qty > 0) map.set(pid, round2(v.cost / v.qty));
      }
      return map;
    }

    // FIFO: oldest receipt unit cost per product (approx until full layer tracking)
    const fifoSeen = new Set<string>();
    for (const r of receipts) {
      const pid = r.stockLevel.productId;
      if (!pid || fifoSeen.has(pid)) continue;
      map.set(pid, Number(r.unitCost));
      fifoSeen.add(pid);
    }
    return map;
  }

  private toStatementLines(
    b: PnLBlock,
    reportCtx: ReturnType<typeof reportContextFromSettings>,
  ) {
    const serviceLabel = isServiceRevenueContext(reportCtx)
      ? 'Cost of Service Delivery'
      : 'Cost of Goods / Service';
    const lines: Array<{
      key: string;
      label: string;
      amount: number | null;
      indent: number;
      bold?: boolean;
      section?: boolean;
      pct?: number | null;
    }> = [
      { key: 'rev_hdr', label: 'Revenue', amount: null, indent: 0, section: true },
      { key: 'gross_sales', label: 'Gross sales', amount: b.grossSales, indent: 1 },
      {
        key: 'returns',
        label: 'Less: Returns & refunds',
        amount: -b.returnsRefunds,
        indent: 1,
      },
      {
        key: 'discounts',
        label: 'Less: Discounts',
        amount: -b.discounts,
        indent: 1,
      },
      {
        key: 'net_sales',
        label: 'Net Sales',
        amount: b.netSales,
        indent: 0,
        bold: true,
      },
      {
        key: 'cogs_hdr',
        label: 'Direct costs',
        amount: null,
        indent: 0,
        section: true,
      },
      { key: 'cogs', label: 'Cost of Goods Sold (COGS)', amount: -b.cogs, indent: 1 },
      {
        key: 'cos',
        label: serviceLabel,
        amount: -b.costOfService,
        indent: 1,
      },
      {
        key: 'gross_profit',
        label: 'Gross Profit',
        amount: b.grossProfit,
        indent: 0,
        bold: true,
        pct: b.grossMarginPct,
      },
      {
        key: 'opex_hdr',
        label: 'Operating Expenses',
        amount: null,
        indent: 0,
        section: true,
      },
      ...b.expensesByCategory.map((e) => ({
        key: `exp_${e.categoryId ?? e.name}`,
        label: e.name,
        amount: -e.amount,
        indent: 1,
      })),
      {
        key: 'opex_total',
        label: 'Total Operating Expenses',
        amount: -b.operatingExpenses,
        indent: 0,
        bold: true,
      },
      {
        key: 'ebitda',
        label: 'Operating Profit (EBITDA)',
        amount: b.operatingProfit,
        indent: 0,
        bold: true,
      },
      {
        key: 'tax_info',
        label: 'Tax collected (informational)',
        amount: b.taxCollected,
        indent: 1,
      },
      {
        key: 'tax_exp',
        label: 'Less: Taxes / provisions',
        amount: -b.taxExpense,
        indent: 1,
      },
      {
        key: 'net_profit',
        label: 'Net Profit',
        amount: b.netProfit,
        indent: 0,
        bold: true,
        pct: b.netMarginPct,
      },
    ];
    return lines;
  }

  private resolveCostingMethod(
    override: CostingMethod | undefined,
    settings: unknown,
  ): CostingMethod {
    if (override) return override;
    const root =
      settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>)
        : {};
    const inv =
      root.inventory && typeof root.inventory === 'object'
        ? (root.inventory as Record<string, unknown>)
        : root.reports && typeof root.reports === 'object'
          ? (root.reports as Record<string, unknown>)
          : {};
    const m = String(inv.costingMethod ?? root.costingMethod ?? 'standard');
    if (m === 'fifo' || m === 'weighted_average' || m === 'standard') return m;
    return 'standard';
  }

  private parseLocationIds(raw?: string): string[] {
    if (!raw?.trim()) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private resolveRange(
    query: ProfitAndLossQueryDto,
    timezone: string,
  ): { start: Date; end: Date; fromYmd: string; toYmd: string } {
    const today = ymdInZone(new Date(), timezone);
    const [ty, tm] = today.split('-').map(Number);
    const preset = query.preset ?? (query.from && query.to ? 'custom' : 'this_month');

    let fromYmd = query.from ?? '';
    let toYmd = query.to ?? '';

    if (preset === 'this_month') {
      fromYmd = `${ty}-${pad2(tm)}-01`;
      toYmd = today;
    } else if (preset === 'last_month') {
      const prev = shiftMonth(ty, tm, -1);
      const dim = new Date(Date.UTC(prev.year, prev.month, 0)).getUTCDate();
      fromYmd = `${prev.year}-${pad2(prev.month)}-01`;
      toYmd = `${prev.year}-${pad2(prev.month)}-${pad2(dim)}`;
    } else if (preset === 'this_quarter') {
      const qStart = Math.floor((tm - 1) / 3) * 3 + 1;
      fromYmd = `${ty}-${pad2(qStart)}-01`;
      toYmd = today;
    } else if (preset === 'this_year') {
      fromYmd = `${ty}-01-01`;
      toYmd = today;
    } else {
      if (!fromYmd || !toYmd) {
        fromYmd = `${ty}-${pad2(tm)}-01`;
        toYmd = today;
      }
    }

    return {
      fromYmd,
      toYmd,
      start: dayRange(fromYmd, timezone).start,
      end: dayRange(toYmd, timezone).end,
    };
  }

  private previousEqualRange(
    range: { start: Date; end: Date; fromYmd: string; toYmd: string },
    timezone: string,
  ) {
    const days =
      Math.round(
        (range.end.getTime() - range.start.getTime()) / (24 * 3600 * 1000),
      ) + 1;
    const prevEnd = new Date(range.start.getTime() - 1);
    const prevStart = new Date(
      prevEnd.getTime() - (days - 1) * 24 * 3600 * 1000,
    );
    const fromYmd = ymdInZone(prevStart, timezone);
    const toYmd = ymdInZone(prevEnd, timezone);
    return {
      fromYmd,
      toYmd,
      start: dayRange(fromYmd, timezone).start,
      end: dayRange(toYmd, timezone).end,
    };
  }
}
