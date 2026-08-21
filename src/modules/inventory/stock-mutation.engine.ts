import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  StockLedgerType,
  StockUnitStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { isRecipePurpose, recipeConsumeQty } from '../restaurant/restaurant-policy';

export type InvTx = Prisma.TransactionClient;

export type BatchPickStrategy = 'fefo' | 'fifo' | 'manual';

export type MutateStockInput = {
  tenantId: string;
  actorUserId?: string | null;
  locationId: string;
  stockLevelId?: string;
  productId?: string;
  variantId?: string | null;
  batchId?: string | null;
  serialNumber?: string | null;
  qty: number;
  type: StockLedgerType;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey?: string | null;
  allowNegative?: boolean;
  damageDelta?: number;
  skipComponentExplosion?: boolean;
  inputUnit?: string | null;
};

export type MutationResult = {
  stockLevelId: string;
  productId: string;
  locationId: string;
  variantId: string | null;
  qtyBefore: number;
  qtyDelta: number;
  qtyAfter: number;
  qtyReserved: number;
  qtyAvailable: number;
  batchId: string | null;
  stockUnitId: string | null;
  ledgerId: string;
  replayed?: boolean;
};

type LockedLevel = {
  id: string;
  tenantId: string;
  locationId: string;
  productId: string;
  variantId: string | null;
  sku: string;
  sellUnit: string;
  qtyOnHand: Prisma.Decimal;
  qtyReserved: Prisma.Decimal;
  qtyInTransit: Prisma.Decimal;
  qtyDamaged: Prisma.Decimal;
  version: number;
};

const EPS = 1e-9;

@Injectable()
export class StockMutationEngine {
  constructor(private readonly prisma: PrismaService) {}

  async mutate(
    db: PrismaService | InvTx,
    input: MutateStockInput,
  ): Promise<MutationResult> {
    if ('$transaction' in db) {
      return (db as PrismaService).$transaction((tx) =>
        this.mutateInTx(tx, input),
      );
    }
    return this.mutateInTx(db as InvTx, input);
  }

  async mutateInTx(tx: InvTx, input: MutateStockInput): Promise<MutationResult> {
    const qty = Number(input.qty);
    const dmgOnly = Math.abs(Number(input.damageDelta ?? 0)) >= EPS;
    if (!Number.isFinite(qty) || (Math.abs(qty) < EPS && !dmgOnly)) {
      throw new BadRequestException('Quantity must be a non-zero number');
    }

    if (input.idempotencyKey) {
      try {
        await tx.inventoryIdempotency.create({
          data: {
            tenantId: input.tenantId,
            key: input.idempotencyKey,
            operation: input.type,
            result: { pending: true },
          },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          const existing = await tx.inventoryIdempotency.findUnique({
            where: {
              tenantId_key: {
                tenantId: input.tenantId,
                key: input.idempotencyKey,
              },
            },
          });
          if (existing) {
            if ((existing.result as { pending?: boolean })?.pending) {
              throw new BadRequestException(
                'Duplicate in-flight inventory request — retry',
              );
            }
            return {
              ...(existing.result as MutationResult),
              replayed: true,
            };
          }
          throw e;
        }
        throw e;
      }
    }

    const level = await this.lockLevel(tx, input);
    const recipeParent =
      !input.skipComponentExplosion &&
      qty < 0 &&
      (await this.hasRecipeExplosion(tx, input.tenantId, level.productId));
    if (recipeParent) {
      await this.consumeComponents(tx, input, level, Math.abs(qty));
      const result: MutationResult = {
        stockLevelId: level.id,
        productId: level.productId,
        locationId: level.locationId,
        variantId: level.variantId,
        qtyBefore: Number(level.qtyOnHand),
        qtyDelta: 0,
        qtyAfter: Number(level.qtyOnHand),
        qtyReserved: Number(level.qtyReserved),
        qtyAvailable:
          Number(level.qtyOnHand) - Number(level.qtyReserved),
        batchId: null,
        stockUnitId: null,
        ledgerId: '',
      };
      if (input.idempotencyKey) {
        await tx.inventoryIdempotency.update({
          where: {
            tenantId_key: {
              tenantId: input.tenantId,
              key: input.idempotencyKey,
            },
          },
          data: { result: result as unknown as Prisma.InputJsonValue },
        });
      }
      return result;
    }

    const baseQty = await this.toBaseQty(tx, input, level, qty);
    const available = Number(level.qtyOnHand) - Number(level.qtyReserved);
    const nextOnHand = Number(level.qtyOnHand) + baseQty;
    if (!input.allowNegative && nextOnHand < -EPS) {
      throw new BadRequestException(
        `Insufficient stock (available ${available}, need ${Math.abs(baseQty)})`,
      );
    }
    if (!input.allowNegative && baseQty < 0 && available + baseQty < -EPS) {
      throw new BadRequestException(
        `Insufficient available stock (on hand ${Number(level.qtyOnHand)}, reserved ${Number(level.qtyReserved)}, need ${Math.abs(baseQty)})`,
      );
    }

    const allowNeg = input.allowNegative ? 1 : 0;
    const dmg = Number(input.damageDelta ?? 0);
    const updatedRows = await tx.$queryRaw<LockedLevel[]>`
      UPDATE stock_levels
      SET
        qty_on_hand = qty_on_hand + ${baseQty}::decimal,
        qty_damaged = qty_damaged + ${dmg}::decimal,
        version = version + 1,
        updated_at = NOW()
      WHERE id = ${level.id}::uuid
        AND tenant_id = ${input.tenantId}::uuid
        AND (${allowNeg} = 1 OR qty_on_hand + ${baseQty}::decimal >= 0)
        AND (${allowNeg} = 1 OR ${baseQty}::decimal >= 0
             OR (qty_on_hand - qty_reserved + ${baseQty}::decimal) >= 0)
        AND qty_damaged + ${dmg}::decimal >= 0
      RETURNING
        id, tenant_id AS "tenantId", location_id AS "locationId", product_id AS "productId",
        variant_id AS "variantId", sku, sell_unit AS "sellUnit",
        qty_on_hand AS "qtyOnHand", qty_reserved AS "qtyReserved",
        qty_in_transit AS "qtyInTransit", qty_damaged AS "qtyDamaged", version
    `;
    const updated = updatedRows[0];
    if (!updated) {
      throw new BadRequestException(
        'Stock update conflict — retry (insufficient stock or concurrent sale)',
      );
    }

    const batchId = await this.applyBatch(tx, input, level, baseQty);
    const stockUnitId = await this.applySerial(tx, input, level);

    const ledger = await tx.stockLedgerEntry.create({
      data: {
        tenantId: input.tenantId,
        locationId: level.locationId,
        productId: level.productId,
        stockLevelId: level.id,
        type: input.type,
        qtyBefore: Number(level.qtyOnHand),
        qtyDelta: baseQty,
        qtyAfter: Number(updated.qtyOnHand),
        damageDelta: Number(input.damageDelta ?? 0),
        variantId: level.variantId,
        batchId,
        stockUnitId,
        reason: input.reason?.trim() || null,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        actorUserId: input.actorUserId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        meta: {
          sku: level.sku,
          sellUnit: level.sellUnit,
          serialNumber: input.serialNumber ?? null,
        },
      },
    });

    if (!input.skipComponentExplosion && baseQty < 0) {
      await this.consumeComponents(tx, input, level, Math.abs(baseQty));
    } else if (!input.skipComponentExplosion && input.type === StockLedgerType.opening) {
      // no-op
    }

    const result: MutationResult = {
      stockLevelId: level.id,
      productId: level.productId,
      locationId: level.locationId,
      variantId: level.variantId,
      qtyBefore: Number(level.qtyOnHand),
      qtyDelta: baseQty,
      qtyAfter: Number(updated.qtyOnHand),
      qtyReserved: Number(updated.qtyReserved),
      qtyAvailable:
        Number(updated.qtyOnHand) - Number(updated.qtyReserved),
      batchId,
      stockUnitId,
      ledgerId: ledger.id,
    };

    if (input.idempotencyKey) {
      await tx.inventoryIdempotency.update({
        where: {
          tenantId_key: {
            tenantId: input.tenantId,
            key: input.idempotencyKey,
          },
        },
        data: { result: result as unknown as Prisma.InputJsonValue },
      });
    }

    return result;
  }

  /**
   * Create a zero on-hand row if missing (transfer destination, variant seed).
   * Does not write a ledger — caller mutates after.
   */
  async ensureLevel(
    tx: InvTx,
    args: {
      tenantId: string;
      locationId: string;
      productId: string;
      variantId?: string | null;
      sku: string;
      sellUnit: string;
      sellPrice: Prisma.Decimal | number | string;
    },
  ): Promise<string> {
    const variantKey = args.variantId ?? '';
    const existing = await tx.stockLevel.findFirst({
      where: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productId: args.productId,
        variantKey,
      },
      select: { id: true },
    });
    if (existing) return existing.id;
    const created = await tx.stockLevel.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId,
        productId: args.productId,
        variantId: args.variantId ?? null,
        variantKey,
        sku: args.sku.slice(0, 18),
        sellUnit: String(args.sellUnit).slice(0, 8),
        sellPrice: args.sellPrice,
        qtyOnHand: 0,
      },
    });
    return created.id;
  }

  /** Convert input qty into product base unit when a conversion exists. */
  async toBaseQty(
    tx: InvTx,
    input: MutateStockInput,
    level: LockedLevel,
    qty: number,
  ): Promise<number> {
    const from = input.inputUnit?.trim();
    if (!from || from === level.sellUnit) return qty;
    const conv = await tx.unitConversion.findFirst({
      where: {
        tenantId: input.tenantId,
        fromUnit: from,
        toUnit: level.sellUnit,
        OR: [
          { productId: level.productId },
          { productKey: '' },
        ],
      },
      orderBy: { productId: 'desc' },
    });
    if (!conv) {
      throw new BadRequestException(
        `No unit conversion ${from} → ${level.sellUnit}`,
      );
    }
    return qty * Number(conv.factor);
  }

  private async lockLevel(tx: InvTx, input: MutateStockInput): Promise<LockedLevel> {
    const variantKey = input.variantId ?? '';
    if (input.stockLevelId) {
      const rows = await tx.$queryRaw<LockedLevel[]>`
        SELECT id, tenant_id AS "tenantId", location_id AS "locationId",
               product_id AS "productId", variant_id AS "variantId", sku,
               sell_unit AS "sellUnit", qty_on_hand AS "qtyOnHand",
               qty_reserved AS "qtyReserved", qty_in_transit AS "qtyInTransit",
               qty_damaged AS "qtyDamaged", version
        FROM stock_levels
        WHERE id = ${input.stockLevelId}::uuid
          AND tenant_id = ${input.tenantId}::uuid
        FOR UPDATE
      `;
      if (!rows[0]) throw new BadRequestException('Stock level not found');
      if (input.locationId && rows[0].locationId !== input.locationId) {
        throw new BadRequestException('Stock level is not at this location');
      }
      return rows[0];
    }
    if (!input.productId) {
      throw new BadRequestException('productId or stockLevelId is required');
    }
    const rows = await tx.$queryRaw<LockedLevel[]>`
      SELECT id, tenant_id AS "tenantId", location_id AS "locationId",
             product_id AS "productId", variant_id AS "variantId", sku,
             sell_unit AS "sellUnit", qty_on_hand AS "qtyOnHand",
             qty_reserved AS "qtyReserved", qty_in_transit AS "qtyInTransit",
             qty_damaged AS "qtyDamaged", version
      FROM stock_levels
      WHERE tenant_id = ${input.tenantId}::uuid
        AND location_id = ${input.locationId}::uuid
        AND product_id = ${input.productId}::uuid
        AND variant_key = ${variantKey}
      FOR UPDATE
    `;
    if (rows[0]) return rows[0];
    throw new BadRequestException('No stock level at this location');
  }

  private async applyBatch(
    tx: InvTx,
    input: MutateStockInput,
    level: LockedLevel,
    qtyDelta: number,
  ): Promise<string | null> {
    const product = await tx.product.findFirst({
      where: { id: level.productId, tenantId: input.tenantId },
      select: { trackBatch: true, meta: true },
    });
    if (!product?.trackBatch) return input.batchId ?? null;

    const strategy = this.batchStrategy(product.meta);
    const remaining = qtyDelta;
    if (remaining === 0) return null;

    if (remaining > 0) {
      const batchId = input.batchId;
      if (!batchId) return null;
      await tx.productBatch.updateMany({
        where: {
          id: batchId,
          tenantId: input.tenantId,
          productId: level.productId,
          locationId: level.locationId,
        },
        data: { qtyOnHand: { increment: remaining } },
      });
      return batchId;
    }

    const need = Math.abs(remaining);
    const allocations = await this.allocateBatches(tx, {
      tenantId: input.tenantId,
      locationId: level.locationId,
      productId: level.productId,
      variantId: level.variantId,
      batchId: input.batchId,
      need,
      strategy,
    });
    let lastId: string | null = null;
    for (const a of allocations) {
      const upd = await tx.$queryRaw<{ id: string }[]>`
        UPDATE product_batches
        SET qty_on_hand = qty_on_hand - ${a.qty}::decimal, updated_at = NOW()
        WHERE id = ${a.id}::uuid
          AND tenant_id = ${input.tenantId}::uuid
          AND qty_on_hand >= ${a.qty}::decimal
        RETURNING id
      `;
      if (!upd[0]) {
        throw new BadRequestException(
          `Batch ${a.code} concurrent update — insufficient qty`,
        );
      }
      lastId = a.id;
    }
    return lastId;
  }

  private batchStrategy(meta: unknown): BatchPickStrategy {
    const m = meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : {};
    const s = String(m.batchPickStrategy ?? m.batchStrategy ?? 'fefo').toLowerCase();
    if (s === 'fifo' || s === 'manual') return s;
    return 'fefo';
  }

  private async allocateBatches(
    tx: InvTx,
    args: {
      tenantId: string;
      locationId: string;
      productId: string;
      variantId: string | null;
      batchId?: string | null;
      need: number;
      strategy: BatchPickStrategy;
    },
  ): Promise<Array<{ id: string; code: string; qty: number }>> {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (args.batchId) {
      const batch = await tx.productBatch.findFirst({
        where: {
          id: args.batchId,
          tenantId: args.tenantId,
          productId: args.productId,
          locationId: args.locationId,
          isActive: true,
        },
      });
      if (!batch) throw new BadRequestException('Invalid batch');
      if (batch.expiresAt && batch.expiresAt < now) {
        throw new BadRequestException('Selected batch is expired');
      }
      if (Number(batch.qtyOnHand) + EPS < args.need) {
        throw new BadRequestException(
          `Insufficient quantity in selected batch (have ${batch.qtyOnHand})`,
        );
      }
      return [{ id: batch.id, code: batch.batchCode, qty: args.need }];
    }
    if (args.strategy === 'manual') {
      throw new BadRequestException('batch is required');
    }
    const orderBy =
      args.strategy === 'fifo'
        ? [{ createdAt: 'asc' as const }, { batchCode: 'asc' as const }]
        : [{ expiresAt: 'asc' as const }, { createdAt: 'asc' as const }];
    const batches = await tx.productBatch.findMany({
      where: {
        tenantId: args.tenantId,
        productId: args.productId,
        locationId: args.locationId,
        isActive: true,
        qtyOnHand: { gt: 0 },
        AND: [
          {
            OR: [{ expiresAt: null }, { expiresAt: { gte: now } }],
          },
          args.variantId
            ? { variantId: args.variantId }
            : {},
        ],
      },
      orderBy,
    });
    const out: Array<{ id: string; code: string; qty: number }> = [];
    let left = args.need;
    for (const b of batches) {
      if (left <= EPS) break;
      const take = Math.min(Number(b.qtyOnHand), left);
      out.push({ id: b.id, code: b.batchCode, qty: take });
      left -= take;
    }
    if (left > EPS) {
      throw new BadRequestException(
        `Insufficient batch stock (need ${args.need}, short ${left})`,
      );
    }
    return out;
  }

  private async applySerial(
    tx: InvTx,
    input: MutateStockInput,
    level: LockedLevel,
  ): Promise<string | null> {
    const product = await tx.product.findFirst({
      where: { id: level.productId, tenantId: input.tenantId },
      select: { trackSerial: true, fulfillmentMode: true },
    });
    if (!product?.trackSerial) return null;
    const serial = input.serialNumber?.trim();
    if (!serial) {
      throw new BadRequestException('serial is required');
    }
    const units = await tx.$queryRaw<
      Array<{ id: string; status: StockUnitStatus }>
    >`
      SELECT id, status FROM stock_units
      WHERE tenant_id = ${input.tenantId}::uuid
        AND product_id = ${level.productId}::uuid
        AND barcode_sku = ${serial}
      FOR UPDATE
    `;
    const unit = units[0];
    if (!unit) {
      throw new BadRequestException(`Unknown serial ${serial}`);
    }
    const outbound =
      input.type === StockLedgerType.sale ||
      input.type === StockLedgerType.stock_out ||
      input.type === StockLedgerType.rental_out;
    const inbound =
      input.type === StockLedgerType.customer_return ||
      input.type === StockLedgerType.stock_in ||
      input.type === StockLedgerType.rental_return ||
      input.type === StockLedgerType.opening;

    if (outbound) {
      if (unit.status !== StockUnitStatus.available) {
        throw new BadRequestException(
          `Serial ${serial} is not available (status ${unit.status})`,
        );
      }
      const toStatus =
        input.type === StockLedgerType.rental_out
          ? StockUnitStatus.checked_out
          : StockUnitStatus.sold;
      await tx.stockUnit.update({
        where: { id: unit.id },
        data: { status: toStatus, locationId: level.locationId },
      });
      await tx.stockMovement.create({
        data: {
          tenantId: input.tenantId,
          stockUnitId: unit.id,
          fromStatus: StockUnitStatus.available,
          toStatus,
          reason: input.type,
          orderId: input.referenceId ?? undefined,
          actorUserId: input.actorUserId ?? undefined,
        },
      });
      return unit.id;
    }
    if (inbound) {
      await tx.stockUnit.update({
        where: { id: unit.id },
        data: { status: StockUnitStatus.available, locationId: level.locationId },
      });
      await tx.stockMovement.create({
        data: {
          tenantId: input.tenantId,
          stockUnitId: unit.id,
          fromStatus: unit.status,
          toStatus: StockUnitStatus.available,
          reason: input.type,
          orderId: input.referenceId ?? undefined,
          actorUserId: input.actorUserId ?? undefined,
        },
      });
      return unit.id;
    }
    return unit.id;
  }

  async hasRecipeExplosion(
    tx: InvTx,
    tenantId: string,
    productId: string,
  ): Promise<boolean> {
    const lines = await tx.productBundleLine.findMany({
      where: {
        tenantId,
        bundleProductId: productId,
        consumeOnSale: true,
      },
      select: { purpose: true },
      take: 20,
    });
    return lines.some((l) => isRecipePurpose(l.purpose));
  }

  private async consumeComponents(
    tx: InvTx,
    input: MutateStockInput,
    parentLevel: LockedLevel,
    parentQty: number,
  ) {
    const lines = await tx.productBundleLine.findMany({
      where: {
        tenantId: input.tenantId,
        bundleProductId: parentLevel.productId,
        consumeOnSale: true,
      },
    });
    for (const line of lines) {
      const need = recipeConsumeQty({
        componentQty: Number(line.quantity),
        parentQty,
        wastagePercent: Number(line.wastagePercent ?? 0),
      });
      if (need < EPS) continue;
      await this.mutateInTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        locationId: parentLevel.locationId,
        productId: line.componentProductId,
        variantId: line.componentVariantId,
        qty: -need,
        type: StockLedgerType.consumption,
        reason: `Consumed for ${parentLevel.sku}`,
        referenceType: input.referenceType ?? 'consumption',
        referenceId: input.referenceId,
        skipComponentExplosion: true,
        inputUnit: line.unit,
      });
    }
  }

  /** Consume recipe/kit components without changing parent stock (services). */
  async consumeForParent(
    tx: InvTx,
    input: {
      tenantId: string;
      actorUserId?: string | null;
      locationId: string;
      productId: string;
      parentQty: number;
      referenceType?: string | null;
      referenceId?: string | null;
      stageId?: string | null;
    },
  ) {
    const parentLevel: LockedLevel = {
      id: '00000000-0000-0000-0000-000000000000',
      tenantId: input.tenantId,
      locationId: input.locationId,
      productId: input.productId,
      variantId: null,
      sku: input.productId,
      sellUnit: 'pcs',
      qtyOnHand: new Prisma.Decimal(0),
      qtyReserved: new Prisma.Decimal(0),
      qtyInTransit: new Prisma.Decimal(0),
      qtyDamaged: new Prisma.Decimal(0),
      version: 0,
    };
    if (input.stageId) {
      const lines = await tx.productBundleLine.findMany({
        where: {
          tenantId: input.tenantId,
          bundleProductId: input.productId,
          consumeOnSale: true,
          stageId: input.stageId,
        },
      });
      for (const line of lines) {
        const need = recipeConsumeQty({
          componentQty: Number(line.quantity),
          parentQty: input.parentQty,
          wastagePercent: Number(line.wastagePercent ?? 0),
        });
        if (need < EPS) continue;
        await this.mutateInTx(tx, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          locationId: input.locationId,
          productId: line.componentProductId,
          variantId: line.componentVariantId,
          qty: -need,
          type: StockLedgerType.consumption,
          reason: `Stage consume ${input.productId}`,
          referenceType: input.referenceType ?? 'consumption',
          referenceId: input.referenceId,
          skipComponentExplosion: true,
          inputUnit: line.unit,
        });
      }
      return;
    }
    await this.consumeComponents(
      tx,
      {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        locationId: input.locationId,
        productId: input.productId,
        qty: -input.parentQty,
        type: StockLedgerType.consumption,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        skipComponentExplosion: true,
      },
      parentLevel,
      input.parentQty,
    );
  }

  async restoreForParent(
    tx: InvTx,
    input: {
      tenantId: string;
      actorUserId?: string | null;
      locationId: string;
      productId: string;
      parentQty: number;
      referenceType?: string | null;
      referenceId?: string | null;
    },
  ) {
    const lines = await tx.productBundleLine.findMany({
      where: {
        tenantId: input.tenantId,
        bundleProductId: input.productId,
        consumeOnSale: true,
      },
    });
    for (const line of lines) {
      const need = recipeConsumeQty({
        componentQty: Number(line.quantity),
        parentQty: input.parentQty,
        wastagePercent: Number(line.wastagePercent ?? 0),
      });
      if (need < EPS) continue;
      await this.mutateInTx(tx, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        locationId: input.locationId,
        productId: line.componentProductId,
        variantId: line.componentVariantId,
        qty: need,
        type: StockLedgerType.customer_return,
        reason: `Restored recipe for ${input.productId}`,
        referenceType: input.referenceType ?? 'customer_return',
        referenceId: input.referenceId,
        skipComponentExplosion: true,
        inputUnit: line.unit,
      });
    }
  }

  async adjustReserved(
    tx: InvTx,
    args: {
      tenantId: string;
      stockLevelId: string;
      delta: number;
    },
  ) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE stock_levels
      SET qty_reserved = qty_reserved + ${args.delta}::decimal,
          version = version + 1,
          updated_at = NOW()
      WHERE id = ${args.stockLevelId}::uuid
        AND tenant_id = ${args.tenantId}::uuid
        AND qty_reserved + ${args.delta}::decimal >= 0
        AND qty_on_hand - (qty_reserved + ${args.delta}::decimal) >= -0.000000001
      RETURNING id
    `;
    if (!rows[0]) {
      throw new BadRequestException('Cannot adjust reserved qty (available too low)');
    }
  }
}
