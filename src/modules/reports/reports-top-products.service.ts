import { Injectable } from '@nestjs/common';
import { OrderItemKind, OrderStatus } from '@prisma/client';
import {
  isKitchenContext,
  isServiceRevenueContext,
  reportContextFromSettings,
  type ReportContext,
} from '../../common/report-capabilities';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type { TopSellingProductsQueryDto } from './dto/reports.dto';
import {
  pctChange,
  round2,
  ymdInZone,
  zonedLocalToUtc,
} from './reports.util';

type RankBy = 'revenue' | 'units' | 'margin' | 'orders';
type MealPeriod = 'all' | 'breakfast' | 'lunch' | 'dinner';

type Agg = {
  key: string;
  productId: string | null;
  name: string;
  sku: string;
  categoryId: string | null;
  categoryName: string | null;
  itemKind: string;
  unitsSold: number;
  grossRevenue: number;
  costTotal: number;
  orderIds: Set<string>;
};

/**
 * Top-selling products / menu items / booked services — ranked by
 * revenue, units, margin, or order frequency with prior-period trend.
 */
@Injectable()
export class ReportsTopProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async topSelling(user: AuthUser, query: TopSellingProductsQueryDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: {
        name: true,
        timezone: true,
        currencyCode: true,
        settings: true,
        businessConfig: { select: { businessType: true } },
      },
    });
    const timezone = tenant?.timezone || 'Asia/Kolkata';
    const currencyCode = tenant?.currencyCode || 'INR';
    const settings =
      tenant?.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const businessType = String(
      tenant?.businessConfig?.businessType ||
        (typeof settings.businessType === 'string'
          ? settings.businessType
          : 'general'),
    ).toLowerCase();
    const reportCtx = reportContextFromSettings({
      ...settings,
      businessType,
    });

    const today = ymdInZone(new Date(), timezone);
    const to = (query.to || today).slice(0, 10);
    const fromDefault = this.shiftYmd(to, -29);
    const from = (query.from || fromDefault).slice(0, 10);
    const days = this.inclusiveDays(from, to);
    const prevTo = this.shiftYmd(from, -1);
    const prevFrom = this.shiftYmd(prevTo, -(days - 1));

    const rankBy: RankBy = query.rankBy ?? 'revenue';
    const topN = (query.topN ?? 20) as 10 | 20 | 50 | 100;
    const mealPeriod: MealPeriod = query.mealPeriod ?? 'all';
    const includeCrossSell = query.includeCrossSell !== false;
    const locationId = query.locationId;
    const categoryId = query.categoryId;

    const currentRange = {
      start: zonedLocalToUtc(from, 0, 0, 0, 0, timezone),
      end: zonedLocalToUtc(to, 23, 59, 59, 999, timezone),
    };
    const prevRange = {
      start: zonedLocalToUtc(prevFrom, 0, 0, 0, 0, timezone),
      end: zonedLocalToUtc(prevTo, 23, 59, 59, 999, timezone),
    };

    const itemKinds = this.itemKindsFor(reportCtx);
    const [currentItems, prevItems] = await Promise.all([
      this.loadLines(
        user.tenantId,
        currentRange,
        locationId,
        categoryId,
        itemKinds,
      ),
      this.loadLines(
        user.tenantId,
        prevRange,
        locationId,
        categoryId,
        itemKinds,
      ),
    ]);

    const currentFiltered = this.filterMealPeriod(
      currentItems,
      mealPeriod,
      timezone,
    );
    const prevFiltered = this.filterMealPeriod(
      prevItems,
      mealPeriod,
      timezone,
    );

    const currentMap = this.aggregate(currentFiltered);
    const prevMap = this.aggregate(prevFiltered);

    const totalRevenue = [...currentMap.values()].reduce(
      (s, r) => s + r.grossRevenue,
      0,
    );
    const totalUnits = [...currentMap.values()].reduce(
      (s, r) => s + r.unitsSold,
      0,
    );
    const totalProfit = [...currentMap.values()].reduce(
      (s, r) => s + (r.grossRevenue - r.costTotal),
      0,
    );
    const totalOrders = new Set(
      [...currentMap.values()].flatMap((r) => [...r.orderIds]),
    ).size;

    let pairs = new Map<string, Map<string, number>>();
    if (includeCrossSell) {
      pairs = this.basketPairs(currentFiltered);
    }

    const poolSize = 100;
    let ranked = [...currentMap.values()].map((r) => {
      const profit = round2(r.grossRevenue - r.costTotal);
      const marginPct =
        r.grossRevenue > 0 ? round2((profit / r.grossRevenue) * 100) : 0;
      const prev = prevMap.get(r.key);
      const prevRevenue = prev?.grossRevenue ?? 0;
      const prevUnits = prev?.unitsSold ?? 0;
      const changePct = pctChange(r.grossRevenue, prevRevenue);
      let direction: 'up' | 'down' | 'flat' = 'flat';
      if (changePct != null) {
        if (changePct > 0.5) direction = 'up';
        else if (changePct < -0.5) direction = 'down';
      } else if (r.grossRevenue > 0 && prevRevenue === 0) {
        direction = 'up';
      }

      const partners: Array<{
        productId: string | null;
        key: string;
        name: string;
        sku: string;
        coOrderCount: number;
        strengthPct: number;
      }> = [];
      if (includeCrossSell) {
        const mateCounts = pairs.get(r.key);
        if (mateCounts) {
          const orderCount = r.orderIds.size || 1;
          const topMates = [...mateCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);
          for (const [mateKey, co] of topMates) {
            const mate = currentMap.get(mateKey);
            partners.push({
              productId: mate?.productId ?? null,
              key: mateKey,
              name: mate?.name ?? 'Item',
              sku: mate?.sku ?? '—',
              coOrderCount: co,
              strengthPct: round2((co / orderCount) * 100),
            });
          }
        }
      }

      return {
        productId: r.productId,
        key: r.key,
        name: r.name,
        sku: r.sku,
        categoryId: r.categoryId,
        categoryName: r.categoryName,
        itemKind: r.itemKind,
        unitsSold: round2(r.unitsSold),
        grossRevenue: round2(r.grossRevenue),
        profitContribution: profit,
        profitMarginPct: marginPct,
        orderCount: r.orderIds.size,
        pctOfTotalSales:
          totalRevenue > 0
            ? round2((r.grossRevenue / totalRevenue) * 100)
            : 0,
        trend: {
          direction,
          changePct,
          prevRevenue: round2(prevRevenue),
          prevUnits: round2(prevUnits),
        },
        frequentlyBoughtWith: partners,
      };
    });

    ranked = this.sortBy(ranked, rankBy).slice(0, poolSize);
    const items = ranked.slice(0, topN).map((row, i) => ({
      rank: i + 1,
      ...row,
    }));

    const copy = this.copyFor(reportCtx);

    return {
      title: copy.title,
      businessType,
      tenantName: tenant?.name ?? 'Universal POS',
      timezone,
      currencyCode,
      period: {
        from,
        to,
        days,
        prevFrom,
        prevTo,
      },
      filters: {
        locationId: locationId ?? null,
        categoryId: categoryId ?? null,
        mealPeriod,
        rankBy,
        topN,
        includeCrossSell,
      },
      labels: copy.labels,
      showMealPeriod: copy.showMealPeriod,
      emphasizeMargin: copy.emphasizeMargin,
      totals: {
        grossRevenue: round2(totalRevenue),
        unitsSold: round2(totalUnits),
        profitContribution: round2(totalProfit),
        orderCount: totalOrders,
        productCount: currentMap.size,
      },
      /** Full metric pool (≤100) so FE can re-rank live without refetch */
      pool: ranked,
      items,
      chart: items.slice(0, 10).map((r) => ({
        rank: r.rank,
        name: r.name,
        sku: r.sku,
        revenue: r.grossRevenue,
        units: r.unitsSold,
        marginPct: r.profitMarginPct,
        profit: r.profitContribution,
        orders: r.orderCount,
      })),
    };
  }

  private itemKindsFor(ctx: ReportContext): OrderItemKind[] {
    if (isServiceRevenueContext(ctx) && !isKitchenContext(ctx)) {
      return [OrderItemKind.service, OrderItemKind.product];
    }
    return [OrderItemKind.product, OrderItemKind.service, OrderItemKind.custom];
  }

  private copyFor(ctx: ReportContext) {
    if (isKitchenContext(ctx)) {
      return {
        title: 'Top-Selling Menu Items',
        showMealPeriod: true,
        emphasizeMargin: false,
        labels: {
          units: 'Portions sold',
          orders: 'Tickets containing item',
          revenue: 'Gross revenue',
          profit: 'Profit contribution',
          entity: 'Menu item',
        },
      };
    }
    if (isServiceRevenueContext(ctx)) {
      return {
        title: 'Top-Booked Services',
        showMealPeriod: false,
        emphasizeMargin: false,
        labels: {
          units: 'Bookings / qty',
          orders: 'Visits containing service',
          revenue: 'Service revenue',
          profit: 'Contribution',
          entity: 'Service',
        },
      };
    }
    return {
      title: 'Top-Selling Products',
      showMealPeriod: false,
      emphasizeMargin: true,
      labels: {
        units: 'Units sold',
        orders: 'Orders containing item',
        revenue: 'Gross revenue',
        profit: 'Profit contribution',
        entity: 'Product',
      },
    };
  }

  private async loadLines(
    tenantId: string,
    range: { start: Date; end: Date },
    locationId: string | undefined,
    categoryId: string | undefined,
    itemKinds: OrderItemKind[],
  ) {
    return this.prisma.orderItem.findMany({
      where: {
        tenantId,
        itemKind: { in: itemKinds },
        ...(categoryId
          ? { product: { categoryId } }
          : {}),
        order: {
          tenantId,
          status: {
            notIn: [OrderStatus.cancelled, OrderStatus.draft],
          },
          createdAt: { gte: range.start, lte: range.end },
          ...(locationId ? { locationId } : {}),
        },
      },
      select: {
        orderId: true,
        quantity: true,
        lineTotal: true,
        description: true,
        itemKind: true,
        productId: true,
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            costPrice: true,
            categoryId: true,
            category: { select: { id: true, name: true } },
          },
        },
        stockLevel: { select: { sku: true } },
        order: { select: { id: true, createdAt: true } },
      },
    });
  }

  private filterMealPeriod<
    T extends { order: { createdAt: Date } },
  >(rows: T[], mealPeriod: MealPeriod, timezone: string): T[] {
    if (mealPeriod === 'all') return rows;
    return rows.filter((r) => {
      const hour = this.hourInZone(r.order.createdAt, timezone);
      if (mealPeriod === 'breakfast') return hour >= 5 && hour < 11;
      if (mealPeriod === 'lunch') return hour >= 11 && hour < 16;
      return hour >= 16 && hour < 23;
    });
  }

  private hourInZone(date: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    return Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  }

  private aggregate(
    rows: Array<{
      orderId: string;
      quantity: unknown;
      lineTotal: unknown;
      description: string | null;
      itemKind: OrderItemKind;
      productId: string | null;
      product: {
        id: string;
        name: string;
        skuCode: string;
        costPrice: unknown;
        categoryId: string | null;
        category: { id: string; name: string } | null;
      } | null;
      stockLevel: { sku: string } | null;
    }>,
  ) {
    const map = new Map<string, Agg>();
    for (const it of rows) {
      const key =
        it.product?.id ??
        it.productId ??
        it.stockLevel?.sku ??
        it.description ??
        'unknown';
      const row =
        map.get(key) ??
        ({
          key,
          productId: it.product?.id ?? it.productId,
          name: it.product?.name ?? it.description ?? 'Item',
          sku: it.product?.skuCode ?? it.stockLevel?.sku ?? '—',
          categoryId: it.product?.categoryId ?? null,
          categoryName: it.product?.category?.name ?? null,
          itemKind: it.itemKind,
          unitsSold: 0,
          grossRevenue: 0,
          costTotal: 0,
          orderIds: new Set<string>(),
        } satisfies Agg);
      const qty = Number(it.quantity);
      const rev = Number(it.lineTotal);
      const unitCost = Number(it.product?.costPrice ?? 0);
      row.unitsSold += qty;
      row.grossRevenue += rev;
      row.costTotal += unitCost * qty;
      row.orderIds.add(it.orderId);
      map.set(key, row);
    }
    return map;
  }

  /** Co-occurrence counts for product keys in the same order */
  private basketPairs(
    rows: Array<{
      orderId: string;
      productId: string | null;
      description: string | null;
      product: { id: string } | null;
      stockLevel: { sku: string } | null;
    }>,
  ) {
    const byOrder = new Map<string, Set<string>>();
    for (const it of rows) {
      const key =
        it.product?.id ??
        it.productId ??
        it.stockLevel?.sku ??
        it.description ??
        null;
      if (!key) continue;
      const set = byOrder.get(it.orderId) ?? new Set<string>();
      set.add(key);
      byOrder.set(it.orderId, set);
    }
    const pairs = new Map<string, Map<string, number>>();
    for (const keys of byOrder.values()) {
      const arr = [...keys];
      if (arr.length < 2) continue;
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i]!;
          const b = arr[j]!;
          this.bumpPair(pairs, a, b);
          this.bumpPair(pairs, b, a);
        }
      }
    }
    return pairs;
  }

  private bumpPair(
    pairs: Map<string, Map<string, number>>,
    a: string,
    b: string,
  ) {
    const inner = pairs.get(a) ?? new Map<string, number>();
    inner.set(b, (inner.get(b) ?? 0) + 1);
    pairs.set(a, inner);
  }

  private sortBy<
    T extends {
      grossRevenue: number;
      unitsSold: number;
      profitMarginPct: number;
      profitContribution: number;
      orderCount: number;
    },
  >(rows: T[], rankBy: RankBy): T[] {
    const copy = [...rows];
    copy.sort((a, b) => {
      if (rankBy === 'units') return b.unitsSold - a.unitsSold;
      if (rankBy === 'orders') return b.orderCount - a.orderCount;
      if (rankBy === 'margin') {
        const d = b.profitMarginPct - a.profitMarginPct;
        if (d !== 0) return d;
        return b.profitContribution - a.profitContribution;
      }
      return b.grossRevenue - a.grossRevenue;
    });
    return copy;
  }

  private inclusiveDays(from: string, to: string): number {
    const a = Date.parse(`${from}T00:00:00.000Z`);
    const b = Date.parse(`${to}T00:00:00.000Z`);
    return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
  }

  private shiftYmd(ymd: string, deltaDays: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().slice(0, 10);
  }
}
