import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import { NotificationEngineService } from './notification-engine.service';

/**
 * Low stock / out-of-stock alerts — plugs into shared notification engine.
 * Called after any stock-decreasing (or increasing) event for a product@location.
 */
@Injectable()
export class LowStockAlertService {
  private readonly log = new Logger(LowStockAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: NotificationEngineService,
  ) {}

  /**
   * Re-evaluate stock level and emit or auto-clear alerts.
   * Safe to call fire-and-forget after stock mutations.
   */
  async evaluate(opts: {
    tenantId: string;
    locationId: string;
    productId: string;
  }) {
    try {
      await this.evaluateUnsafe(opts);
    } catch (e) {
      this.log.warn(
        `low-stock evaluate failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  private async evaluateUnsafe(opts: {
    tenantId: string;
    locationId: string;
    productId: string;
  }) {
    const level = await this.prisma.stockLevel.findFirst({
      where: {
        tenantId: opts.tenantId,
        locationId: opts.locationId,
        productId: opts.productId,
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            trackQty: true,
          },
        },
        location: { select: { id: true, name: true, code: true } },
      },
    });
    if (!level || !level.product.trackQty) return;

    const qty = Number(level.qtyOnHand);
    const reorder =
      level.reorderPoint != null ? Number(level.reorderPoint) : 5;
    const reorderQty =
      level.reorderQty != null ? Number(level.reorderQty) : Math.max(reorder, 1);

    const dedupeLow = `low_stock:${opts.locationId}:${opts.productId}:low`;
    const dedupeOut = `low_stock:${opts.locationId}:${opts.productId}:out`;

    if (qty > reorder) {
      await this.engine.resolveByDedupe({
        tenantId: opts.tenantId,
        dedupeKey: dedupeLow,
      });
      await this.engine.resolveByDedupe({
        tenantId: opts.tenantId,
        dedupeKey: dedupeOut,
      });
      return;
    }

    const isOut = qty <= 0;
    const severity = isOut ? 'critical' : 'low';
    const dedupeKey = isOut ? dedupeOut : dedupeLow;

    if (isOut) {
      // Clear low-tier when escalated to out
      await this.engine.resolveByDedupe({
        tenantId: opts.tenantId,
        dedupeKey: dedupeLow,
      });
    }

    const title = isOut
      ? `Out of stock · ${level.product.name}`
      : `Low stock · ${level.product.name}`;
    const body = isOut
      ? `${level.product.skuCode} at ${level.location.name} is at 0 (reorder @ ${reorder}). Suggested order: ${reorderQty}.`
      : `${level.product.skuCode} at ${level.location.name}: ${qty} left (reorder @ ${reorder}). Suggested order: ${reorderQty}.`;

    await this.engine.emit({
      tenantId: opts.tenantId,
      type: 'low_stock',
      title,
      body,
      locationId: opts.locationId,
      severity,
      dedupeKey,
      groupKey: `low_stock:${opts.locationId}`,
      href: `/purchases?productId=${opts.productId}&locationId=${opts.locationId}`,
      payload: {
        productId: opts.productId,
        productName: level.product.name,
        sku: level.product.skuCode,
        locationId: opts.locationId,
        locationName: level.location.name,
        qtyOnHand: qty,
        reorderPoint: reorder,
        suggestedReorderQty: reorderQty,
        actions: [
          {
            label: 'Create purchase order',
            href: `/purchases?productId=${opts.productId}&locationId=${opts.locationId}`,
          },
          {
            label: 'Request stock transfer',
            href: `/transfers?toLocationId=${opts.locationId}&productId=${opts.productId}`,
          },
        ],
      },
    });
  }
}
