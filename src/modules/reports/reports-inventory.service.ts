import { Injectable } from '@nestjs/common';
import {
  FulfillmentMode,
  Prisma,
  ProductKind,
  StockLedgerType,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import type {
  InventoryReportsQueryDto,
  SlowMovingStockQueryDto,
} from './dto/reports.dto';
import {
  dayRange,
  round2,
  ymdInZone,
} from './reports.util';

type CostingMethod = 'standard' | 'weighted_average' | 'fifo' | 'lifo';
type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';
type InventoryClass = 'ingredient' | 'finished' | 'other';

const STOCK_IN: StockLedgerType[] = [
  StockLedgerType.stock_in,
  StockLedgerType.transfer_in,
  StockLedgerType.purchase_receive,
  StockLedgerType.damage_restore,
];
const STOCK_OUT: StockLedgerType[] = [
  StockLedgerType.stock_out,
  StockLedgerType.transfer_out,
  StockLedgerType.sale,
  StockLedgerType.purchase_return,
  StockLedgerType.damage,
];
const ADJUSTMENT_TYPES: StockLedgerType[] = [
  StockLedgerType.adjustment,
  StockLedgerType.damage,
  StockLedgerType.damage_restore,
  StockLedgerType.audit,
];

/**
 * Inventory Reports — current stock, movement, valuation, adjustments,
 * reorder suggestions, expiry. Business-agnostic; restaurant ingredient
 * split via product.meta.inventoryClass when set.
 */
@Injectable()
export class ReportsInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async currentStock(user: AuthUser, query: InventoryReportsQueryDto) {
    const ctx = await this.context(user);
    const levels = await this.loadLevels(user.tenantId, query, ctx);
    const productIds = [...new Set(levels.map((l) => l.productId))];
    const unitCosts = await this.resolveUnitCosts(
      user.tenantId,
      productIds,
      this.resolveCosting(query.costingMethod, ctx.settings),
    );

    const rows = levels.map((l) => {
      const unitCost = unitCosts.get(l.productId) ?? Number(l.costPrice ?? 0);
      const qty = l.qtyOnHand;
      const status = this.stockStatus(qty, l.reorderPoint);
      return {
        stockLevelId: l.id,
        productId: l.productId,
        locationId: l.locationId,
        locationName: l.locationName,
        item: l.name,
        sku: l.sku,
        categoryId: l.categoryId,
        category: l.categoryName,
        qtyOnHand: qty,
        qtyDamaged: l.qtyDamaged,
        unitCost: round2(unitCost),
        stockValue: round2(qty * unitCost),
        reorderPoint: l.reorderPoint,
        reorderQty: l.reorderQty,
        status,
        inventoryClass: l.inventoryClass,
        unitOfMeasure: l.unitOfMeasure,
      };
    });

    const items = query.consolidated
      ? this.consolidateStock(rows)
      : rows.sort((a, b) => a.item.localeCompare(b.item));

    const summary = {
      skuCount: items.length,
      totalQty: round2(items.reduce((s, r) => s + r.qtyOnHand, 0)),
      totalValue: round2(items.reduce((s, r) => s + r.stockValue, 0)),
      inStock: items.filter((r) => r.status === 'in_stock').length,
      lowStock: items.filter((r) => r.status === 'low_stock').length,
      outOfStock: items.filter((r) => r.status === 'out_of_stock').length,
    };

    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      businessType: ctx.businessType,
      consolidated: Boolean(query.consolidated),
      costingMethod: this.resolveCosting(query.costingMethod, ctx.settings),
      filters: this.filterEcho(query),
      variations: {
        restaurantIngredientSplit:
          ctx.businessType === 'restaurant' || ctx.businessType === 'hybrid',
        byClass: this.groupByClass(items),
      },
      summary,
      items,
    };
  }

  async stockMovement(user: AuthUser, query: InventoryReportsQueryDto) {
    const ctx = await this.context(user);
    const { from, to } = this.resolveDateRange(query, ctx.timeZone);
    const locationIds = this.parseLocationIds(query);
    const supplierProductIds = await this.supplierProductIds(
      user.tenantId,
      query.supplierId,
    );

    const where: Prisma.StockLedgerEntryWhereInput = {
      tenantId: user.tenantId,
      createdAt: { gte: from, lte: to },
      ...(locationIds.length === 1
        ? { locationId: locationIds[0] }
        : locationIds.length > 1
          ? { locationId: { in: locationIds } }
          : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(supplierProductIds
        ? { productId: { in: supplierProductIds } }
        : {}),
      ...(query.categoryId
        ? { product: { categoryId: query.categoryId } }
        : {}),
      ...(query.q?.trim()
        ? {
            OR: [
              {
                product: {
                  name: { contains: query.q.trim(), mode: 'insensitive' },
                },
              },
              {
                product: {
                  skuCode: {
                    contains: query.q.trim(),
                    mode: 'insensitive',
                  },
                },
              },
            ],
          }
        : {}),
    };

    const limit = Math.min(query.limit ?? 500, 1000);
    const rows = await this.prisma.stockLedgerEntry.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            category: { select: { id: true, name: true } },
            meta: true,
            kind: true,
          },
        },
        location: { select: { id: true, name: true } },
        actor: { select: { id: true, fullName: true } },
      },
    });

    const items = rows
      .filter((r) =>
        this.matchesInventoryClass(
          this.resolveInventoryClass(r.product.kind, r.product.meta),
          query.inventoryClass,
        ),
      )
      .map((r) => {
        const direction = STOCK_IN.includes(r.type)
          ? 'in'
          : STOCK_OUT.includes(r.type)
            ? 'out'
            : 'adjust';
        return {
          id: r.id,
          at: r.createdAt.toISOString(),
          type: r.type,
          direction,
          quantity: Number(r.qtyDelta),
          runningBalance: Number(r.qtyAfter),
          damageDelta: Number(r.damageDelta),
          reason: r.reason,
          referenceType: r.referenceType,
          referenceId: r.referenceId,
          productId: r.productId,
          item: r.product.name,
          sku: r.product.skuCode,
          category: r.product.category?.name ?? null,
          locationId: r.locationId,
          locationName: r.location.name,
          actorId: r.actor?.id ?? null,
          actorName: r.actor?.fullName ?? null,
        };
      });

    const totals = {
      stockIn: round2(
        items
          .filter((i) => i.direction === 'in')
          .reduce((s, i) => s + Math.abs(i.quantity), 0),
      ),
      stockOut: round2(
        items
          .filter((i) => i.direction === 'out')
          .reduce((s, i) => s + Math.abs(i.quantity), 0),
      ),
      adjustments: round2(
        items
          .filter((i) => i.direction === 'adjust')
          .reduce((s, i) => s + i.quantity, 0),
      ),
      eventCount: items.length,
    };

    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      from: ymdInZone(from, ctx.timeZone),
      to: ymdInZone(to, ctx.timeZone),
      filters: this.filterEcho(query),
      summary: totals,
      items,
    };
  }

  async valuation(user: AuthUser, query: InventoryReportsQueryDto) {
    const ctx = await this.context(user);
    const method = this.resolveCosting(query.costingMethod, ctx.settings);
    const levels = await this.loadLevels(user.tenantId, query, ctx);
    const productIds = [...new Set(levels.map((l) => l.productId))];
    const unitCosts = await this.resolveUnitCosts(
      user.tenantId,
      productIds,
      method,
    );

    const lines = levels.map((l) => {
      const unitCost = unitCosts.get(l.productId) ?? Number(l.costPrice ?? 0);
      const value = round2(l.qtyOnHand * unitCost);
      return {
        productId: l.productId,
        locationId: l.locationId,
        locationName: l.locationName,
        item: l.name,
        sku: l.sku,
        categoryId: l.categoryId,
        category: l.categoryName,
        qtyOnHand: l.qtyOnHand,
        unitCost: round2(unitCost),
        value,
        inventoryClass: l.inventoryClass,
      };
    });

    const byCategory = this.aggregateValue(
      lines,
      (l) => l.category ?? 'Uncategorized',
    );
    const byBranch = this.aggregateValue(lines, (l) => l.locationName);
    const byClass = this.aggregateValue(lines, (l) => l.inventoryClass);

    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      costingMethod: method,
      costingNote:
        method === 'fifo'
          ? 'FIFO approx — oldest GRN unit cost per product'
          : method === 'lifo'
            ? 'LIFO approx — newest GRN unit cost per product'
            : method === 'weighted_average'
              ? 'Weighted average of GRN unit costs'
              : 'Catalog / standard costPrice',
      filters: this.filterEcho(query),
      summary: {
        totalValue: round2(lines.reduce((s, l) => s + l.value, 0)),
        totalQty: round2(lines.reduce((s, l) => s + l.qtyOnHand, 0)),
        skuCount: lines.length,
      },
      byCategory,
      byBranch,
      byClass,
      items: lines.sort((a, b) => b.value - a.value),
    };
  }

  async adjustments(user: AuthUser, query: InventoryReportsQueryDto) {
    const ctx = await this.context(user);
    const { from, to } = this.resolveDateRange(query, ctx.timeZone);
    const locationIds = this.parseLocationIds(query);

    const rows = await this.prisma.stockLedgerEntry.findMany({
      where: {
        tenantId: user.tenantId,
        type: { in: ADJUSTMENT_TYPES },
        createdAt: { gte: from, lte: to },
        ...(locationIds.length === 1
          ? { locationId: locationIds[0] }
          : locationIds.length > 1
            ? { locationId: { in: locationIds } }
            : {}),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.categoryId
          ? { product: { categoryId: query.categoryId } }
          : {}),
        ...(query.q?.trim()
          ? {
              OR: [
                {
                  product: {
                    name: {
                      contains: query.q.trim(),
                      mode: 'insensitive',
                    },
                  },
                },
                {
                  product: {
                    skuCode: {
                      contains: query.q.trim(),
                      mode: 'insensitive',
                    },
                  },
                },
                {
                  reason: {
                    contains: query.q.trim(),
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(query.limit ?? 500, 1000),
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            category: { select: { name: true } },
          },
        },
        location: { select: { id: true, name: true } },
        actor: { select: { id: true, fullName: true, email: true } },
      },
    });

    const items = rows.map((r) => {
      const reasonCode = this.reasonCode(r.type, r.reason);
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        type: r.type,
        reasonCode,
        reason: r.reason,
        quantity: Number(r.qtyDelta),
        damageDelta: Number(r.damageDelta),
        qtyAfter: Number(r.qtyAfter),
        productId: r.productId,
        item: r.product.name,
        sku: r.product.skuCode,
        category: r.product.category?.name ?? null,
        locationId: r.locationId,
        locationName: r.location.name,
        approvedById: r.actor?.id ?? null,
        approvedBy: r.actor?.fullName ?? r.actor?.email ?? null,
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      from: ymdInZone(from, ctx.timeZone),
      to: ymdInZone(to, ctx.timeZone),
      filters: this.filterEcho(query),
      summary: {
        eventCount: items.length,
        netQty: round2(items.reduce((s, i) => s + i.quantity, 0)),
        damageQty: round2(
          items.reduce((s, i) => s + Math.abs(i.damageDelta), 0),
        ),
        byReason: Object.entries(
          items.reduce<Record<string, number>>((acc, i) => {
            acc[i.reasonCode] = (acc[i.reasonCode] ?? 0) + 1;
            return acc;
          }, {}),
        ).map(([code, count]) => ({ code, count })),
      },
      items,
    };
  }

  async reorderSuggestions(user: AuthUser, query: InventoryReportsQueryDto) {
    const ctx = await this.context(user);
    const velocityDays = query.velocityDays ?? 30;
    const defaultLead = query.leadTimeDays ?? 7;
    const levels = await this.loadLevels(
      user.tenantId,
      { ...query, consolidated: false },
      ctx,
      { includeHealthy: false },
    );

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - velocityDays);

    const sales = await this.prisma.stockLedgerEntry.groupBy({
      by: ['productId', 'locationId'],
      where: {
        tenantId: user.tenantId,
        type: StockLedgerType.sale,
        createdAt: { gte: since },
        qtyDelta: { lt: 0 },
      },
      _sum: { qtyDelta: true },
    });
    const soldMap = new Map<string, number>();
    for (const s of sales) {
      soldMap.set(
        `${s.productId}:${s.locationId}`,
        Math.abs(Number(s._sum.qtyDelta ?? 0)),
      );
    }

    const lastSupplier = await this.lastSupplierByProduct(
      user.tenantId,
      levels.map((l) => l.productId),
    );

    const items = levels
      .map((l) => {
        const threshold = l.reorderPoint ?? 5;
        if (l.qtyOnHand > threshold) return null;
        const sold =
          soldMap.get(`${l.productId}:${l.locationId}`) ?? 0;
        const avgDaily = sold / velocityDays;
        const lead =
          typeof l.leadTimeDays === 'number' && l.leadTimeDays > 0
            ? l.leadTimeDays
            : defaultLead;
        const coverNeed = Math.ceil(avgDaily * lead);
        const fromReorderQty =
          l.reorderQty != null && l.reorderQty > 0 ? l.reorderQty : 0;
        const suggestedQty = Math.max(
          1,
          fromReorderQty || coverNeed || Math.max(1, threshold - l.qtyOnHand),
        );
        const status = this.stockStatus(l.qtyOnHand, l.reorderPoint);
        const supplier = lastSupplier.get(l.productId) ?? null;
        return {
          stockLevelId: l.id,
          productId: l.productId,
          locationId: l.locationId,
          locationName: l.locationName,
          item: l.name,
          sku: l.sku,
          category: l.categoryName,
          qtyOnHand: l.qtyOnHand,
          reorderPoint: threshold,
          reorderQty: l.reorderQty,
          avgDailySales: round2(avgDaily),
          leadTimeDays: lead,
          suggestedQty,
          status,
          supplierId: supplier?.id ?? null,
          supplierName: supplier?.name ?? null,
          unitCost: l.costPrice != null ? Number(l.costPrice) : null,
          canCreatePo: Boolean(supplier?.id),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => a.qtyOnHand - b.qtyOnHand);

    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      velocityDays,
      defaultLeadTimeDays: defaultLead,
      filters: this.filterEcho(query),
      summary: {
        itemCount: items.length,
        outOfStock: items.filter((i) => i.status === 'out_of_stock').length,
        lowStock: items.filter((i) => i.status === 'low_stock').length,
        withSupplier: items.filter((i) => i.supplierId).length,
      },
      items,
    };
  }

  async expiry(user: AuthUser, query: InventoryReportsQueryDto) {
    const ctx = await this.context(user);
    const windowDays = query.expiryWindowDays ?? 30;
    const todayYmd = ymdInZone(new Date(), ctx.timeZone);
    const today = new Date(`${todayYmd}T00:00:00.000Z`);
    const until = new Date(today);
    until.setUTCDate(until.getUTCDate() + windowDays);

    const locationIds = this.parseLocationIds(query);
    const batches = await this.prisma.productBatch.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        expiresAt: { not: null, lte: until },
        qtyOnHand: { gt: 0 },
        ...(locationIds.length === 1
          ? { locationId: locationIds[0] }
          : locationIds.length > 1
            ? { locationId: { in: locationIds } }
            : {}),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(query.categoryId
          ? { product: { categoryId: query.categoryId } }
          : {}),
        ...(query.q?.trim()
          ? {
              OR: [
                {
                  product: {
                    name: {
                      contains: query.q.trim(),
                      mode: 'insensitive',
                    },
                  },
                },
                {
                  batchCode: {
                    contains: query.q.trim(),
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
        product: {
          trackBatch: true,
          trackQty: true,
          isActive: true,
        },
      },
      orderBy: [{ expiresAt: 'asc' }],
      take: Math.min(query.limit ?? 500, 1000),
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            costPrice: true,
            category: { select: { id: true, name: true } },
            meta: true,
            kind: true,
          },
        },
        location: { select: { id: true, name: true } },
      },
    });

    const items = batches
      .filter((b) =>
        this.matchesInventoryClass(
          this.resolveInventoryClass(b.product.kind, b.product.meta),
          query.inventoryClass,
        ),
      )
      .map((b) => {
        const exp = b.expiresAt!;
        const daysLeft = Math.ceil(
          (exp.getTime() - today.getTime()) / (24 * 3600 * 1000),
        );
        const urgency =
          daysLeft < 0 ? 'expired' : daysLeft <= 7 ? 'critical' : 'warning';
        const qty = Number(b.qtyOnHand);
        const unitCost = Number(b.product.costPrice ?? 0);
        return {
          batchId: b.id,
          batchCode: b.batchCode,
          productId: b.productId,
          item: b.product.name,
          sku: b.product.skuCode,
          category: b.product.category?.name ?? null,
          locationId: b.locationId,
          locationName: b.location.name,
          expiresAt: exp.toISOString().slice(0, 10),
          daysLeft,
          urgency,
          qtyOnHand: qty,
          unitCost: round2(unitCost),
          stockValue: round2(qty * unitCost),
        };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft);

    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      expiryWindowDays: windowDays,
      filters: this.filterEcho(query),
      summary: {
        batchCount: items.length,
        expired: items.filter((i) => i.urgency === 'expired').length,
        critical: items.filter((i) => i.urgency === 'critical').length,
        warning: items.filter((i) => i.urgency === 'warning').length,
        atRiskValue: round2(items.reduce((s, i) => s + i.stockValue, 0)),
      },
      items,
    };
  }

  /**
   * Slow-moving / dead stock — on-hand inventory with no sale for N days.
   * Sorted by stock value desc (largest capital risk first).
   */
  async slowMoving(user: AuthUser, query: SlowMovingStockQueryDto) {
    const ctx = await this.context(user);
    const inactiveDays = query.inactiveDays ?? 60;
    const velocityLookback = query.velocityLookbackDays ?? 90;
    const minStockValue = Number(query.minStockValue ?? 0);
    const todayYmd = ymdInZone(new Date(), ctx.timeZone);
    const today = new Date(`${todayYmd}T00:00:00.000Z`);

    const invQuery: InventoryReportsQueryDto = {
      locationId: query.locationId,
      categoryId: query.categoryId,
      supplierId: query.supplierId,
      limit: query.limit ?? 500,
    };
    const levels = await this.loadLevels(
      user.tenantId,
      invQuery,
      ctx,
      { includeHealthy: true },
    );
    const onHand = levels.filter((l) => l.qtyOnHand > 0);
    const productIds = [...new Set(onHand.map((l) => l.productId))];
    if (!productIds.length) {
      const copy = this.slowMovingCopy(ctx.businessType);
      return {
        generatedAt: new Date().toISOString(),
        timeZone: ctx.timeZone,
        currencyCode: ctx.currencyCode,
        businessType: ctx.businessType,
        title: copy.title,
        labels: copy.labels,
        inactiveDays,
        velocityLookbackDays: velocityLookback,
        filters: {
          locationId: query.locationId ?? null,
          categoryId: query.categoryId ?? null,
          supplierId: query.supplierId ?? null,
          minStockValue,
          inactiveDays,
        },
        summary: {
          itemCount: 0,
          totalCapitalLocked: 0,
          neverSoldCount: 0,
          criticalCount: 0,
          highCount: 0,
          avgDaysSinceSale: null,
        },
        histogram: [
          { key: '0_29', label: '0–29 days', itemCount: 0, stockValue: 0 },
          { key: '30_59', label: '30–59 days', itemCount: 0, stockValue: 0 },
          { key: '60_89', label: '60–89 days', itemCount: 0, stockValue: 0 },
          { key: '90_179', label: '90–179 days', itemCount: 0, stockValue: 0 },
          {
            key: '180_plus',
            label: '180+ days / never',
            itemCount: 0,
            stockValue: 0,
          },
        ],
        items: [],
      };
    }

    const unitCosts = await this.resolveUnitCosts(
      user.tenantId,
      productIds,
      this.resolveCosting(undefined, ctx.settings),
    );
    const lastSupplier = await this.lastSupplierByProduct(
      user.tenantId,
      productIds,
    );

    const velocitySince = new Date(today);
    velocitySince.setUTCDate(velocitySince.getUTCDate() - velocityLookback);

    const locationIds = this.parseLocationIds(invQuery);
    const saleWhere: Prisma.StockLedgerEntryWhereInput = {
      tenantId: user.tenantId,
      type: StockLedgerType.sale,
      productId: { in: productIds },
      ...(locationIds.length === 1
        ? { locationId: locationIds[0] }
        : locationIds.length > 1
          ? { locationId: { in: locationIds } }
          : {}),
    };

    const [lastSales, velocitySales] = await Promise.all([
      this.prisma.stockLedgerEntry.groupBy({
        by: ['productId', 'locationId'],
        where: saleWhere,
        _max: { createdAt: true },
      }),
      this.prisma.stockLedgerEntry.groupBy({
        by: ['productId', 'locationId'],
        where: {
          ...saleWhere,
          createdAt: { gte: velocitySince },
          qtyDelta: { lt: 0 },
        },
        _sum: { qtyDelta: true },
      }),
    ]);

    const lastSaleMap = new Map<string, Date>();
    for (const s of lastSales) {
      if (s._max.createdAt) {
        lastSaleMap.set(`${s.productId}:${s.locationId}`, s._max.createdAt);
      }
    }
    const soldMap = new Map<string, number>();
    for (const s of velocitySales) {
      soldMap.set(
        `${s.productId}:${s.locationId}`,
        Math.abs(Number(s._sum.qtyDelta ?? 0)),
      );
    }

    const months = Math.max(velocityLookback / 30, 1);
    type Row = {
      productId: string;
      locationId: string;
      locationName: string;
      item: string;
      sku: string;
      categoryId: string | null;
      category: string | null;
      qtyOnHand: number;
      unitCost: number;
      stockValue: number;
      lastSaleDate: string | null;
      daysSinceLastSale: number | null;
      avgMonthlyVelocity: number;
      neverSold: boolean;
      severity: 'critical' | 'high' | 'medium' | 'watch';
      suggestedAction: string;
      suggestedActionCode:
        | 'discount'
        | 'bundle'
        | 'return_to_supplier'
        | 'write_off'
        | 'menu_review'
        | 'promote';
      supplierId: string | null;
      supplierName: string | null;
    };

    const allRows: Row[] = onHand.map((l) => {
      const key = `${l.productId}:${l.locationId}`;
      const unitCost = unitCosts.get(l.productId) ?? Number(l.costPrice ?? 0);
      const stockValue = round2(l.qtyOnHand * unitCost);
      const lastAt = lastSaleMap.get(key) ?? null;
      const neverSold = !lastAt;
      let daysSinceLastSale: number | null = null;
      if (lastAt) {
        const lastYmd = ymdInZone(lastAt, ctx.timeZone);
        const last = new Date(`${lastYmd}T00:00:00.000Z`);
        daysSinceLastSale = Math.max(
          0,
          Math.round((today.getTime() - last.getTime()) / 86_400_000),
        );
      }
      const sold = soldMap.get(key) ?? 0;
      const avgMonthlyVelocity = round2(sold / months);
      const supplier = lastSupplier.get(l.productId) ?? null;
      const action = this.suggestDeadStockAction({
        businessType: ctx.businessType,
        daysSinceLastSale,
        neverSold,
        avgMonthlyVelocity,
        stockValue,
        hasSupplier: Boolean(supplier?.id),
      });
      const severity = this.deadStockSeverity(
        daysSinceLastSale,
        neverSold,
        stockValue,
      );
      return {
        productId: l.productId,
        locationId: l.locationId,
        locationName: l.locationName,
        item: l.name,
        sku: l.sku,
        categoryId: l.categoryId,
        category: l.categoryName,
        qtyOnHand: round2(l.qtyOnHand),
        unitCost: round2(unitCost),
        stockValue,
        lastSaleDate: lastAt ? ymdInZone(lastAt, ctx.timeZone) : null,
        daysSinceLastSale,
        avgMonthlyVelocity,
        neverSold,
        severity,
        suggestedAction: action.label,
        suggestedActionCode: action.code,
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? null,
      };
    });

    const items = allRows
      .filter((r) => {
        if (r.stockValue < minStockValue) return false;
        if (r.neverSold) return true;
        return (r.daysSinceLastSale ?? 0) >= inactiveDays;
      })
      .sort((a, b) => b.stockValue - a.stockValue)
      .slice(0, query.limit ?? 500);

    const histogramBuckets = [
      { key: '0_29', label: '0–29 days', min: 0, max: 29 },
      { key: '30_59', label: '30–59 days', min: 30, max: 59 },
      { key: '60_89', label: '60–89 days', min: 60, max: 89 },
      { key: '90_179', label: '90–179 days', min: 90, max: 179 },
      { key: '180_plus', label: '180+ days / never', min: 180, max: null },
    ] as const;

    const histogramSource = allRows.filter((r) => r.stockValue >= minStockValue);
    const histogram = histogramBuckets.map((b) => {
      const inBucket = histogramSource.filter((r) => {
        if (r.neverSold) return b.key === '180_plus';
        const d = r.daysSinceLastSale ?? 0;
        if (b.max == null) return d >= b.min;
        return d >= b.min && d <= b.max;
      });
      return {
        key: b.key,
        label: b.label,
        itemCount: inBucket.length,
        stockValue: round2(inBucket.reduce((s, r) => s + r.stockValue, 0)),
      };
    });

    const copy = this.slowMovingCopy(ctx.businessType);

    return {
      generatedAt: new Date().toISOString(),
      timeZone: ctx.timeZone,
      currencyCode: ctx.currencyCode,
      businessType: ctx.businessType,
      title: copy.title,
      labels: copy.labels,
      inactiveDays,
      velocityLookbackDays: velocityLookback,
      filters: {
        locationId: query.locationId ?? null,
        categoryId: query.categoryId ?? null,
        supplierId: query.supplierId ?? null,
        minStockValue,
        inactiveDays,
      },
      summary: {
        itemCount: items.length,
        totalCapitalLocked: round2(
          items.reduce((s, r) => s + r.stockValue, 0),
        ),
        neverSoldCount: items.filter((r) => r.neverSold).length,
        criticalCount: items.filter((r) => r.severity === 'critical').length,
        highCount: items.filter((r) => r.severity === 'high').length,
        avgDaysSinceSale: (() => {
          const withDays = items.filter((r) => r.daysSinceLastSale != null);
          if (!withDays.length) return null;
          return round2(
            withDays.reduce((s, r) => s + (r.daysSinceLastSale ?? 0), 0) /
              withDays.length,
          );
        })(),
      },
      histogram,
      items,
    };
  }

  private slowMovingCopy(businessType: string) {
    const t = businessType.toLowerCase();
    if (t === 'restaurant') {
      return {
        title: 'Slow-Moving Menu Items',
        labels: {
          entity: 'Menu item',
          velocity: 'Avg monthly portions',
          actionHint: 'Candidates for menu redesign or promo',
        },
      };
    }
    if (t === 'service' || t === 'salon' || t === 'spa') {
      return {
        title: 'Underbooked / Slow Offerings',
        labels: {
          entity: 'Service / item',
          velocity: 'Avg monthly bookings',
          actionHint: 'Promote or retire underbooked offerings',
        },
      };
    }
    return {
      title: 'Slow-Moving / Dead Stock',
      labels: {
        entity: 'Product',
        velocity: 'Avg monthly sales',
        actionHint: 'Discount, bundle, return, or write off',
      },
    };
  }

  private deadStockSeverity(
    daysSinceLastSale: number | null,
    neverSold: boolean,
    stockValue: number,
  ): 'critical' | 'high' | 'medium' | 'watch' {
    const days = neverSold ? 999 : (daysSinceLastSale ?? 0);
    const highValue = stockValue >= 5000;
    if (days >= 90 && highValue) return 'critical';
    if (days >= 90 || neverSold) return 'high';
    if (days >= 60) return 'medium';
    return 'watch';
  }

  private suggestDeadStockAction(input: {
    businessType: string;
    daysSinceLastSale: number | null;
    neverSold: boolean;
    avgMonthlyVelocity: number;
    stockValue: number;
    hasSupplier: boolean;
  }): {
    code:
      | 'discount'
      | 'bundle'
      | 'return_to_supplier'
      | 'write_off'
      | 'menu_review'
      | 'promote';
    label: string;
  } {
    const t = input.businessType.toLowerCase();
    const days = input.neverSold ? 999 : (input.daysSinceLastSale ?? 0);
    const seasonal =
      input.avgMonthlyVelocity > 0 &&
      input.avgMonthlyVelocity < 3 &&
      days >= 60;

    if (t === 'restaurant') {
      if (days >= 90 || input.neverSold)
        return { code: 'menu_review', label: 'Menu redesign' };
      if (seasonal) return { code: 'promote', label: 'Feature / promo' };
      return { code: 'discount', label: 'Discount' };
    }
    if (t === 'service' || t === 'salon' || t === 'spa') {
      if (days >= 90 || input.neverSold)
        return { code: 'promote', label: 'Promote / retire' };
      return { code: 'bundle', label: 'Bundle with popular' };
    }

    if (input.neverSold && input.hasSupplier)
      return { code: 'return_to_supplier', label: 'Return to Supplier' };
    if (input.neverSold || (days >= 180 && input.avgMonthlyVelocity < 0.5))
      return { code: 'write_off', label: 'Write Off' };
    if (days >= 90 && input.hasSupplier && input.avgMonthlyVelocity < 1)
      return { code: 'return_to_supplier', label: 'Return to Supplier' };
    if (seasonal) return { code: 'bundle', label: 'Bundle' };
    if (days >= 60) return { code: 'discount', label: 'Discount' };
    return { code: 'discount', label: 'Discount' };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async context(user: AuthUser) {
    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: {
        timezone: true,
        currencyCode: true,
        settings: true,
        businessConfig: { select: { businessType: true } },
      },
    });
    const settings =
      tenant.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    return {
      timeZone: tenant.timezone || 'UTC',
      currencyCode: tenant.currencyCode || 'USD',
      businessType:
        tenant.businessConfig?.businessType ||
        (typeof settings.businessType === 'string'
          ? settings.businessType
          : 'other'),
      settings,
    };
  }

  private filterEcho(query: InventoryReportsQueryDto) {
    return {
      locationId: query.locationId ?? null,
      locationIds: query.locationIds ?? null,
      categoryId: query.categoryId ?? null,
      supplierId: query.supplierId ?? null,
      productId: query.productId ?? null,
      q: query.q ?? null,
      inventoryClass: query.inventoryClass ?? 'all',
      consolidated: Boolean(query.consolidated),
    };
  }

  private parseLocationIds(query: InventoryReportsQueryDto): string[] {
    if (query.locationId) return [query.locationId];
    if (!query.locationIds?.trim()) return [];
    return query.locationIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private resolveDateRange(
    query: InventoryReportsQueryDto,
    timeZone: string,
  ): { from: Date; to: Date } {
    const today = ymdInZone(new Date(), timeZone);
    const fromYmd = query.from ?? today;
    const toYmd = query.to ?? today;
    return {
      from: dayRange(fromYmd, timeZone).start,
      to: dayRange(toYmd, timeZone).end,
    };
  }

  private resolveCosting(
    override: InventoryReportsQueryDto['costingMethod'],
    settings: Record<string, unknown>,
  ): CostingMethod {
    if (
      override === 'fifo' ||
      override === 'lifo' ||
      override === 'weighted_average' ||
      override === 'standard'
    ) {
      return override;
    }
    const inv =
      settings.inventory && typeof settings.inventory === 'object'
        ? (settings.inventory as Record<string, unknown>)
        : settings;
    const m = String(inv.costingMethod ?? 'standard');
    if (m === 'fifo' || m === 'lifo' || m === 'weighted_average') return m;
    return 'standard';
  }

  private stockStatus(qty: number, reorderPoint: number | null): StockStatus {
    if (qty <= 0) return 'out_of_stock';
    const threshold = reorderPoint ?? 5;
    if (qty <= threshold) return 'low_stock';
    return 'in_stock';
  }

  private resolveInventoryClass(
    kind: ProductKind,
    meta: unknown,
  ): InventoryClass {
    const m =
      meta && typeof meta === 'object' && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {};
    const raw = String(m.inventoryClass ?? m.stockClass ?? '').toLowerCase();
    if (raw === 'ingredient' || raw === 'raw') return 'ingredient';
    if (raw === 'finished' || raw === 'menu' || raw === 'finished_good')
      return 'finished';
    if (kind === ProductKind.bundle) return 'finished';
    if (kind === ProductKind.physical) return 'ingredient';
    return 'other';
  }

  private matchesInventoryClass(
    cls: InventoryClass,
    filter?: 'all' | 'ingredient' | 'finished',
  ) {
    if (!filter || filter === 'all') return true;
    return cls === filter;
  }

  private reasonCode(type: StockLedgerType, reason: string | null): string {
    if (type === StockLedgerType.damage) return 'damage';
    if (type === StockLedgerType.damage_restore) return 'damage_restore';
    if (type === StockLedgerType.audit) return 'audit';
    const r = (reason ?? '').toLowerCase();
    if (r.includes('expir')) return 'expired';
    if (r.includes('waste') || r.includes('spoil')) return 'wastage';
    if (r.includes('write') || r.includes('write-off')) return 'write_off';
    return 'adjustment';
  }

  private async loadLevels(
    tenantId: string,
    query: InventoryReportsQueryDto,
    ctx: { businessType: string },
    opts: { includeHealthy?: boolean } = {},
  ) {
    const locationIds = this.parseLocationIds(query);
    const supplierProductIds = await this.supplierProductIds(
      tenantId,
      query.supplierId,
    );
    const term = query.q?.trim();

    const rows = await this.prisma.stockLevel.findMany({
      where: {
        tenantId,
        ...(locationIds.length === 1
          ? { locationId: locationIds[0] }
          : locationIds.length > 1
            ? { locationId: { in: locationIds } }
            : {}),
        ...(query.productId ? { productId: query.productId } : {}),
        ...(supplierProductIds
          ? { productId: { in: supplierProductIds } }
          : {}),
        product: {
          trackQty: true,
          isActive: true,
          fulfillmentMode: FulfillmentMode.sale,
          kind: {
            in: [
              ProductKind.physical,
              ProductKind.bundle,
              ProductKind.digital,
            ],
          },
          ...(query.categoryId ? { categoryId: query.categoryId } : {}),
          ...(term
            ? {
                OR: [
                  { name: { contains: term, mode: 'insensitive' } },
                  { skuCode: { contains: term, mode: 'insensitive' } },
                  { barcode: { contains: term, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
      },
      take: Math.min(query.limit ?? 500, 1000),
      orderBy: [{ product: { name: 'asc' } }],
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            costPrice: true,
            unitOfMeasure: true,
            kind: true,
            meta: true,
            category: { select: { id: true, name: true } },
          },
        },
        location: { select: { id: true, name: true } },
      },
    });

    const mapped = rows.map((r) => {
      const meta =
        r.product.meta &&
        typeof r.product.meta === 'object' &&
        !Array.isArray(r.product.meta)
          ? (r.product.meta as Record<string, unknown>)
          : {};
      const metaReorder =
        typeof meta.reorderPoint === 'number' ? meta.reorderPoint : null;
      const reorderPoint =
        r.reorderPoint != null ? Number(r.reorderPoint) : metaReorder;
      const reorderQty =
        r.reorderQty != null
          ? Number(r.reorderQty)
          : typeof meta.reorderQty === 'number'
            ? meta.reorderQty
            : null;
      const leadTimeDays =
        typeof meta.leadTimeDays === 'number' ? meta.leadTimeDays : null;
      return {
        id: r.id,
        productId: r.productId,
        locationId: r.locationId,
        locationName: r.location.name,
        name: r.product.name,
        sku: r.sku || r.product.skuCode,
        categoryId: r.product.category?.id ?? null,
        categoryName: r.product.category?.name ?? null,
        qtyOnHand: Number(r.qtyOnHand),
        qtyDamaged: Number(r.qtyDamaged),
        costPrice: r.product.costPrice != null ? Number(r.product.costPrice) : null,
        reorderPoint,
        reorderQty,
        leadTimeDays,
        unitOfMeasure: r.product.unitOfMeasure,
        inventoryClass: this.resolveInventoryClass(r.product.kind, r.product.meta),
      };
    });

    let out = mapped.filter((l) =>
      this.matchesInventoryClass(l.inventoryClass, query.inventoryClass),
    );
    if (opts.includeHealthy === false) {
      out = out.filter(
        (l) => this.stockStatus(l.qtyOnHand, l.reorderPoint) !== 'in_stock',
      );
    }
    void ctx;
    return out;
  }

  private consolidateStock<
    T extends {
      productId: string;
      item: string;
      sku: string;
      categoryId: string | null;
      category: string | null;
      qtyOnHand: number;
      qtyDamaged: number;
      unitCost: number;
      stockValue: number;
      reorderPoint: number | null;
      reorderQty: number | null;
      status: StockStatus;
      inventoryClass: InventoryClass;
      unitOfMeasure: string;
      stockLevelId: string;
      locationId: string;
      locationName: string;
    },
  >(rows: T[]) {
    const map = new Map<string, T & { locations: number }>();
    for (const r of rows) {
      const cur = map.get(r.productId);
      if (!cur) {
        map.set(r.productId, {
          ...r,
          locationId: '',
          locationName: 'All branches',
          stockLevelId: r.stockLevelId,
          locations: 1,
        });
        continue;
      }
      cur.qtyOnHand = round2(cur.qtyOnHand + r.qtyOnHand);
      cur.qtyDamaged = round2(cur.qtyDamaged + r.qtyDamaged);
      cur.stockValue = round2(cur.stockValue + r.stockValue);
      cur.locations += 1;
      if (cur.qtyOnHand > 0) {
        cur.unitCost = round2(cur.stockValue / cur.qtyOnHand);
      }
      cur.status = this.stockStatus(cur.qtyOnHand, cur.reorderPoint);
    }
    return [...map.values()].sort((a, b) => a.item.localeCompare(b.item));
  }

  private groupByClass(
    items: Array<{ inventoryClass: InventoryClass; stockValue: number }>,
  ) {
    const acc: Record<string, { count: number; value: number }> = {};
    for (const i of items) {
      const k = i.inventoryClass;
      const row = acc[k] ?? { count: 0, value: 0 };
      row.count += 1;
      row.value = round2(row.value + i.stockValue);
      acc[k] = row;
    }
    return Object.entries(acc).map(([inventoryClass, v]) => ({
      inventoryClass,
      ...v,
    }));
  }

  private aggregateValue<T extends { value: number; qtyOnHand: number }>(
    lines: T[],
    keyFn: (l: T) => string,
  ) {
    const acc = new Map<string, { key: string; value: number; qty: number; lines: number }>();
    for (const l of lines) {
      const key = keyFn(l);
      const row = acc.get(key) ?? { key, value: 0, qty: 0, lines: 0 };
      row.value = round2(row.value + l.value);
      row.qty = round2(row.qty + l.qtyOnHand);
      row.lines += 1;
      acc.set(key, row);
    }
    return [...acc.values()].sort((a, b) => b.value - a.value);
  }

  private async supplierProductIds(
    tenantId: string,
    supplierId?: string,
  ): Promise<string[] | null> {
    if (!supplierId) return null;
    const lines = await this.prisma.purchaseOrderLine.findMany({
      where: {
        tenantId,
        purchaseOrder: { supplierId },
      },
      select: { stockLevel: { select: { productId: true } } },
      take: 5000,
    });
    const ids = [
      ...new Set(lines.map((l) => l.stockLevel.productId).filter(Boolean)),
    ];
    return ids.length ? ids : ['00000000-0000-0000-0000-000000000000'];
  }

  private async lastSupplierByProduct(
    tenantId: string,
    productIds: string[],
  ): Promise<Map<string, { id: string; name: string }>> {
    const map = new Map<string, { id: string; name: string }>();
    if (!productIds.length) return map;
    const lines = await this.prisma.goodsReceiptLine.findMany({
      where: {
        tenantId,
        stockLevel: { productId: { in: productIds } },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: {
        createdAt: true,
        stockLevel: { select: { productId: true } },
        goodsReceipt: {
          select: {
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    });
    for (const l of lines) {
      const pid = l.stockLevel.productId;
      if (!pid || map.has(pid)) continue;
      const s = l.goodsReceipt.supplier;
      if (s) map.set(pid, s);
    }
    return map;
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

    if (method === 'lifo') {
      const seen = new Set<string>();
      for (let i = receipts.length - 1; i >= 0; i--) {
        const r = receipts[i];
        const pid = r.stockLevel.productId;
        if (!pid || seen.has(pid)) continue;
        map.set(pid, Number(r.unitCost));
        seen.add(pid);
      }
      return map;
    }

    // FIFO
    const fifoSeen = new Set<string>();
    for (const r of receipts) {
      const pid = r.stockLevel.productId;
      if (!pid || fifoSeen.has(pid)) continue;
      map.set(pid, Number(r.unitCost));
      fifoSeen.add(pid);
    }
    return map;
  }
}
