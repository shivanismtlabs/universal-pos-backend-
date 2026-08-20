import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockCountStatus, StockLedgerType } from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateStockCountDto,
  DamageStockDto,
  ListLedgerQueryDto,
  SetReorderDto,
  StockCountLineDto,
  StockMoveLineDto,
  StockMoveDto,
} from './dto/inventory-ops.dto';
import { assertLocationAccess, locationAccessFilter } from '../../common/location-access';
import { paginate, pageMeta } from '../../common/dto/pagination.dto';
import { LowStockAlertService } from '../notify/low-stock-alert.service';
import { EnterpriseApprovalsService } from '../enterprise/enterprise-approvals.service';
import { StockMutationEngine } from './stock-mutation.engine';

@Injectable()
export class InventoryOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lowStock: LowStockAlertService,
    private readonly approvals: EnterpriseApprovalsService,
    private readonly stock: StockMutationEngine,
  ) {}

  /** Stock In — increases sellable qty */
  stockIn(user: AuthUser, dto: StockMoveDto) {
    return this.applyMove(user, dto, 'in');
  }

  /** Stock Out — decreases sellable qty (write-off, internal use, etc.) */
  stockOut(user: AuthUser, dto: StockMoveDto) {
    return this.applyMove(user, dto, 'out');
  }

  /** Free-form adjustment with signed delta */
  async adjust(
    user: AuthUser,
    body: {
      locationId: string;
      stockLevelId?: string;
      productId?: string;
      delta: number;
      reason?: string;
    },
  ) {
    const level = await this.resolveLevel(
      user.tenantId,
      body.locationId,
      body.stockLevelId,
      body.productId,
    );
    await this.approvals.assertOrQueue(user, {
      type: 'stock_adjustment',
      tenantId: user.tenantId,
      amount: Math.abs(Number(body.delta)),
      entityType: 'stock_level',
      entityId: level.id,
      reason: body.reason,
      payload: {
        oldQty: Number(level.qtyOnHand),
        newQty: Number(level.qtyOnHand) + Number(body.delta),
        delta: body.delta,
        locationId: body.locationId,
        productId: level.productId,
      },
    });
    await this.stock.mutate(this.prisma, {
      tenantId: user.tenantId,
      actorUserId: user.userId,
      locationId: body.locationId,
      stockLevelId: level.id,
      qty: Number(body.delta),
      type: StockLedgerType.adjustment,
      reason: body.reason,
      referenceType: 'adjustment',
    });
    void this.lowStock.evaluate({
      tenantId: user.tenantId,
      locationId: body.locationId,
      productId: level.productId,
    });
    const fresh = await this.prisma.stockLevel.findFirstOrThrow({
      where: { id: level.id },
    });
    return this.mapLevel(fresh);
  }

  /** Move qty from sellable → damaged quarantine */
  async markDamaged(user: AuthUser, dto: DamageStockDto) {
    const level = await this.resolveLevel(
      user.tenantId,
      dto.locationId,
      dto.stockLevelId,
      dto.productId,
    );
    const qty = Number(dto.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new BadRequestException('Damaged qty must be > 0');
    }
    const onHand = Number(level.qtyOnHand);
    if (onHand + 1e-9 < qty) {
      throw new BadRequestException(
        `Insufficient sellable stock (have ${onHand})`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await this.stock.mutateInTx(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: dto.locationId,
        stockLevelId: level.id,
        qty: -qty,
        type: StockLedgerType.damage,
        damageDelta: qty,
        reason: dto.reason,
        referenceType: 'damage',
      });
      const updated = await tx.stockLevel.findFirstOrThrow({
        where: { id: level.id },
      });
      return this.mapLevel(updated);
    }).then((mapped) => {
      void this.lowStock.evaluate({
        tenantId: user.tenantId,
        locationId: level.locationId,
        productId: level.productId,
      });
      return mapped;
    });
  }

  /** Return damaged qty to sellable (or write off from damaged via stock out separately) */
  async restoreDamaged(user: AuthUser, dto: DamageStockDto) {
    const level = await this.resolveLevel(
      user.tenantId,
      dto.locationId,
      dto.stockLevelId,
      dto.productId,
    );
    const qty = Number(dto.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new BadRequestException('Qty must be > 0');
    }
    const damaged = Number(level.qtyDamaged);
    if (damaged + 1e-9 < qty) {
      throw new BadRequestException(
        `Insufficient damaged stock (have ${damaged})`,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await this.stock.mutateInTx(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: dto.locationId,
        stockLevelId: level.id,
        qty,
        type: StockLedgerType.damage_restore,
        damageDelta: -qty,
        reason: dto.reason,
        referenceType: 'damage_restore',
      });
      const updated = await tx.stockLevel.findFirstOrThrow({
        where: { id: level.id },
      });
      return this.mapLevel(updated);
    });
  }

  async setReorder(user: AuthUser, dto: SetReorderDto) {
    const level = await this.resolveLevel(
      user.tenantId,
      dto.locationId,
      dto.stockLevelId,
      dto.productId,
    );
    const updated = await this.prisma.stockLevel.update({
      where: { id: level.id },
      data: {
        ...(dto.reorderPoint !== undefined
          ? { reorderPoint: dto.reorderPoint }
          : {}),
        ...(dto.reorderQty !== undefined
          ? { reorderQty: dto.reorderQty }
          : {}),
        ...(dto.sellPrice !== undefined
          ? { sellPrice: dto.sellPrice }
          : {}),
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            photoUrl: true,
            trackQty: true,
            meta: true,
          },
        },
        location: { select: { id: true, name: true, code: true, type: true } },
      },
    });
    return this.mapLevelRich(updated);
  }

  async listLevels(
    user: AuthUser,
    opts: {
      locationId?: string;
      q?: string;
      lowStockOnly?: boolean;
      includeZero?: boolean;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const locFilter = await locationAccessFilter(
      this.prisma,
      user,
      opts.locationId,
    );
    const term = opts.q?.trim();
    const { page, limit, skip } = paginate(opts.page, opts.limit ?? 25);
    const where: Prisma.StockLevelWhereInput = {
      tenantId: user.tenantId,
      ...locFilter,
      ...(opts.includeZero
        ? {}
        : { OR: [{ qtyOnHand: { gt: 0 } }, { qtyDamaged: { gt: 0 } }] }),
      ...(opts.lowStockOnly ? { qtyOnHand: { lte: 5 } } : {}),
      ...(term
        ? {
            OR: [
              { sku: { contains: term, mode: 'insensitive' } },
              {
                product: {
                  name: { contains: term, mode: 'insensitive' },
                },
              },
              {
                product: {
                  skuCode: { contains: term, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.stockLevel.count({ where }),
      this.prisma.stockLevel.findMany({
        where,
        orderBy: [{ location: { name: 'asc' } }, { product: { name: 'asc' } }],
        skip,
        take: limit,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              skuCode: true,
              photoUrl: true,
              trackQty: true,
              meta: true,
            },
          },
          location: {
            select: { id: true, name: true, code: true, type: true },
          },
        },
      }),
    ]);

    const items = rows.map((r) => this.mapLevelRich(r));
    return { items, meta: pageMeta(total, page, limit) };
  }

  async lowStockAlerts(user: AuthUser, locationId?: string) {
    const { items } = await this.listLevels(user, {
      locationId,
      lowStockOnly: true,
      includeZero: true,
    });
    return {
      count: items.length,
      items: items.filter((i) => i.qtyOnHand <= (i.reorderPoint ?? 5)),
    };
  }

  async listLedger(user: AuthUser, query: ListLedgerQueryDto) {
    const locFilter = await locationAccessFilter(
      this.prisma,
      user,
      query.locationId,
    );
    const { page, limit, skip } = paginate(
      query.page,
      Number(query.limit) || 25,
    );
    const where: Prisma.StockLedgerEntryWhereInput = {
      tenantId: user.tenantId,
      ...locFilter,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.type ? { type: query.type as StockLedgerType } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.stockLedgerEntry.count({ where }),
      this.prisma.stockLedgerEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          product: { select: { id: true, name: true, skuCode: true } },
          location: { select: { id: true, name: true } },
          actor: { select: { id: true, fullName: true } },
        },
      }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        qtyDelta: Number(r.qtyDelta),
        qtyAfter: Number(r.qtyAfter),
        damageDelta: Number(r.damageDelta),
        reason: r.reason,
        referenceType: r.referenceType,
        referenceId: r.referenceId,
        createdAt: r.createdAt,
        product: r.product,
        location: r.location,
        actor: r.actor,
      })),
      meta: pageMeta(total, page, limit),
    };
  }

  // ── Physical stock audit ───────────────────────────────────────────────

  async createCount(user: AuthUser, dto: CreateStockCountDto) {
    await this.assertLocation(user.tenantId, dto.locationId, user);
    const levels = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: user.tenantId,
        locationId: dto.locationId,
      },
    });
    const session = await this.prisma.stockCountSession.create({
      data: {
        tenantId: user.tenantId,
        locationId: dto.locationId,
        status: StockCountStatus.in_progress,
        notes: dto.notes?.trim() || null,
        startedById: user.userId,
        lines: {
          create: levels.map((l) => ({
            tenantId: user.tenantId,
            stockLevelId: l.id,
            productId: l.productId,
            systemQty: l.qtyOnHand,
          })),
        },
      },
      include: {
        location: { select: { id: true, name: true } },
        lines: {
          include: {
            product: { select: { id: true, name: true, skuCode: true } },
          },
        },
      },
    });
    return this.mapSession(session);
  }

  listCounts(user: AuthUser, locationId?: string) {
    return this.prisma.stockCountSession
      .findMany({
        where: {
          tenantId: user.tenantId,
          ...(locationId ? { locationId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          location: { select: { id: true, name: true } },
          _count: { select: { lines: true } },
        },
      })
      .then((rows) =>
        rows.map((s) => ({
          id: s.id,
          status: s.status,
          notes: s.notes,
          createdAt: s.createdAt,
          completedAt: s.completedAt,
          location: s.location,
          lineCount: s._count.lines,
        })),
      );
  }

  async getCount(user: AuthUser, id: string) {
    const s = await this.prisma.stockCountSession.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        location: { select: { id: true, name: true } },
        lines: {
          orderBy: { product: { name: 'asc' } },
          include: {
            product: { select: { id: true, name: true, skuCode: true } },
            stockLevel: { select: { sellUnit: true } },
          },
        },
      },
    });
    if (!s) throw new NotFoundException('Stock count not found');
    return this.mapSession(s);
  }

  async upsertCountLines(
    user: AuthUser,
    sessionId: string,
    lines: StockCountLineDto[],
  ) {
    const session = await this.prisma.stockCountSession.findFirst({
      where: { id: sessionId, tenantId: user.tenantId },
    });
    if (!session) throw new NotFoundException('Stock count not found');
    if (
      session.status === StockCountStatus.completed ||
      session.status === StockCountStatus.cancelled
    ) {
      throw new BadRequestException('Count session is closed');
    }
    for (const line of lines) {
      const existing = await this.prisma.stockCountLine.findFirst({
        where: {
          sessionId,
          stockLevelId: line.stockLevelId,
          tenantId: user.tenantId,
        },
      });
      if (!existing) continue;
      const counted = Number(line.countedQty);
      const system = Number(existing.systemQty);
      await this.prisma.stockCountLine.update({
        where: { id: existing.id },
        data: {
          countedQty: counted,
          variance: counted - system,
          notes: line.notes?.trim() || null,
        },
      });
    }
    return this.getCount(user, sessionId);
  }

  async completeCount(user: AuthUser, sessionId: string, apply = true) {
    const session = await this.getCount(user, sessionId);
    if (session.status === 'completed') {
      throw new BadRequestException('Already completed');
    }
    if (apply) {
      await this.prisma.$transaction(async (tx) => {
        for (const line of session.lines) {
          if (line.countedQty == null) continue;
          const variance = Number(line.variance ?? 0);
          if (Math.abs(variance) < 1e-9) continue;
          const level = await tx.stockLevel.findFirst({
            where: { id: line.stockLevelId, tenantId: user.tenantId },
          });
          if (!level) continue;
          await this.stock.mutateInTx(tx, {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            locationId: session.locationId,
            stockLevelId: level.id,
            qty: variance,
            type: StockLedgerType.audit,
            reason: `Physical count ${sessionId}`,
            referenceType: 'stock_count',
            referenceId: sessionId,
            skipComponentExplosion: true,
          });
        }
        await tx.stockCountSession.update({
          where: { id: sessionId },
          data: {
            status: StockCountStatus.completed,
            completedAt: new Date(),
          },
        });
      });
    } else {
      await this.prisma.stockCountSession.update({
        where: { id: sessionId },
        data: {
          status: StockCountStatus.completed,
          completedAt: new Date(),
        },
      });
    }
    return this.getCount(user, sessionId);
  }

  // helpers ──────────────────────────────────────────────────────────────

  private async applyMove(
    user: AuthUser,
    dto: StockMoveDto,
    direction: 'in' | 'out',
  ) {
    await this.assertLocation(user.tenantId, dto.locationId, user);
    const results = [];
    for (const line of dto.lines) {
      const qty = Number(line.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException('Each line qty must be > 0');
      }
      const level = await this.resolveLevel(
        user.tenantId,
        dto.locationId,
        line.stockLevelId,
        line.productId,
        { createIfMissing: direction === 'in', line },
      );
      const delta = direction === 'in' ? qty : -qty;
      if (direction === 'out' && Number(level.qtyOnHand) + 1e-9 < qty) {
        throw new BadRequestException(
          `Insufficient stock for ${level.sku} (have ${level.qtyOnHand})`,
        );
      }
      const updated = await this.stock.mutate(this.prisma, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: dto.locationId,
        stockLevelId: level.id,
        qty: delta,
        type:
          direction === 'in'
            ? StockLedgerType.stock_in
            : StockLedgerType.stock_out,
        reason: line.reason ?? dto.reason,
        referenceType: direction === 'in' ? 'stock_in' : 'stock_out',
        referenceId: dto.referenceId,
        idempotencyKey: dto.referenceId
          ? `${direction}:${dto.referenceId}:${level.id}:${qty}`
          : undefined,
      });
      const fresh = await this.prisma.stockLevel.findFirstOrThrow({
        where: { id: level.id },
      });
      results.push(this.mapLevel(fresh));
      void this.lowStock.evaluate({
        tenantId: user.tenantId,
        locationId: dto.locationId,
        productId: level.productId,
      });
    }
    return { locationId: dto.locationId, lines: results };
  }

  private async applyQtyChange(
    user: AuthUser,
    level: {
      id: string;
      locationId: string;
      productId: string;
      qtyOnHand: Prisma.Decimal;
      qtyDamaged: Prisma.Decimal;
      sku: string;
      sellUnit: string;
    },
    opts: {
      type: StockLedgerType;
      qtyDelta: number;
      reason?: string;
      referenceType?: string;
      referenceId?: string;
    },
  ) {
    const delta = Number(opts.qtyDelta);
    if (!Number.isFinite(delta) || delta === 0) {
      throw new BadRequestException('Qty change must be non-zero');
    }
    const next = Number(level.qtyOnHand) + delta;
    if (next < -1e-9) {
      throw new BadRequestException('Resulting stock cannot be negative');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.stockLevel.update({
        where: { id: level.id },
        data: { qtyOnHand: next },
      });
      await this.writeLedger(tx, user, {
        locationId: level.locationId,
        productId: level.productId,
        stockLevelId: level.id,
        type: opts.type,
        qtyDelta: delta,
        qtyAfter: Number(updated.qtyOnHand),
        reason: opts.reason,
        referenceType: opts.referenceType,
        referenceId: opts.referenceId,
      });
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'stock_level',
          entityId: level.id,
          action: `inventory.${opts.type}`,
          beforeAfter: {
            qtyDelta: delta,
            qtyAfter: Number(updated.qtyOnHand),
            reason: opts.reason ?? null,
          },
        },
      });
      return this.mapLevel(updated);
    });
  }

  async writeLedgerForTransfer(
    user: AuthUser,
    args: {
      fromLocationId: string;
      toLocationId: string;
      productId: string;
      fromLevelId: string;
      toLevelId: string;
      qty: number;
      fromAfter: number;
      toAfter: number;
      notes?: string | null;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      await this.writeLedger(tx, user, {
        locationId: args.fromLocationId,
        productId: args.productId,
        stockLevelId: args.fromLevelId,
        type: StockLedgerType.transfer_out,
        qtyDelta: -args.qty,
        qtyAfter: args.fromAfter,
        reason: args.notes ?? undefined,
        referenceType: 'stock_transfer',
      });
      await this.writeLedger(tx, user, {
        locationId: args.toLocationId,
        productId: args.productId,
        stockLevelId: args.toLevelId,
        type: StockLedgerType.transfer_in,
        qtyDelta: args.qty,
        qtyAfter: args.toAfter,
        reason: args.notes ?? undefined,
        referenceType: 'stock_transfer',
      });
    });
  }

  private async writeLedger(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    data: {
      locationId: string;
      productId: string;
      stockLevelId: string;
      type: StockLedgerType;
      qtyDelta: number;
      qtyAfter: number;
      damageDelta?: number;
      reason?: string;
      referenceType?: string;
      referenceId?: string;
    },
  ) {
    await tx.stockLedgerEntry.create({
      data: {
        tenantId: user.tenantId,
        locationId: data.locationId,
        productId: data.productId,
        stockLevelId: data.stockLevelId,
        type: data.type,
        qtyDelta: data.qtyDelta,
        qtyAfter: data.qtyAfter,
        damageDelta: data.damageDelta ?? 0,
        reason: data.reason?.trim() || null,
        referenceType: data.referenceType ?? null,
        referenceId: data.referenceId ?? null,
        actorUserId: user.userId,
      },
    });
  }

  private async resolveLevel(
    tenantId: string,
    locationId: string,
    stockLevelId?: string,
    productId?: string,
    opts?: {
      createIfMissing?: boolean;
      line?: StockMoveLineDto;
    },
  ) {
    if (stockLevelId) {
      const level = await this.prisma.stockLevel.findFirst({
        where: { id: stockLevelId, tenantId, locationId },
      });
      if (!level) throw new NotFoundException('Stock level not found');
      return level;
    }
    if (!productId) {
      throw new BadRequestException('productId or stockLevelId required');
    }
    let level = await this.prisma.stockLevel.findFirst({
      where: { tenantId, locationId, productId },
    });
    if (!level && opts?.createIfMissing) {
      const product = await this.prisma.product.findFirst({
        where: { id: productId, tenantId },
      });
      if (!product) throw new NotFoundException('Product not found');
      if (!product.trackQty) {
        throw new BadRequestException('Product is not quantity-tracked');
      }
      level = await this.prisma.stockLevel.create({
        data: {
          tenantId,
          locationId,
          productId,
          sku: product.skuCode,
          sellUnit: product.unitOfMeasure?.slice(0, 8) || 'pcs',
          sellPrice: product.basePrice,
          qtyOnHand: 0,
        },
      });
    }
    if (!level) throw new NotFoundException('No stock level at this location');
    return level;
  }

  private async assertLocation(
    tenantId: string,
    locationId: string,
    user?: AuthUser,
  ) {
    if (user) {
      await assertLocationAccess(this.prisma, user, locationId, {
        requireActive: true,
      });
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId },
      });
      if (!loc) throw new NotFoundException('Location not found');
      return loc;
    }
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId, isActive: true },
    });
    if (!loc) throw new NotFoundException('Location not found');
    return loc;
  }

  private mapLevel(r: {
    id: string;
    productId: string;
    locationId: string;
    sku: string;
    sellUnit: string;
    qtyOnHand: Prisma.Decimal;
    qtyDamaged: Prisma.Decimal;
    qtyReserved?: Prisma.Decimal | number;
    qtyInTransit?: Prisma.Decimal | number;
    reorderPoint: Prisma.Decimal | null;
    reorderQty: Prisma.Decimal | null;
    sellPrice: Prisma.Decimal;
  }) {
    const qtyOnHand = Number(r.qtyOnHand);
    const qtyDamaged = Number(r.qtyDamaged);
    const qtyReserved = Number(r.qtyReserved ?? 0);
    const qtyInTransit = Number(r.qtyInTransit ?? 0);
    return {
      stockLevelId: r.id,
      id: r.id,
      productId: r.productId,
      locationId: r.locationId,
      sku: r.sku,
      sellUnit: r.sellUnit,
      qtyOnHand,
      qtyDamaged,
      qtyReserved,
      qtyInTransit,
      sellableQty: qtyOnHand - qtyReserved,
      qtyAvailable: qtyOnHand - qtyReserved,
      reorderPoint:
        r.reorderPoint != null ? Number(r.reorderPoint) : null,
      reorderQty: r.reorderQty != null ? Number(r.reorderQty) : null,
      sellPrice: Number(r.sellPrice),
    };
  }

  private mapLevelRich(
    r: {
      id: string;
      productId: string;
      locationId: string;
      sku: string;
      sellUnit: string;
      qtyOnHand: Prisma.Decimal;
      qtyDamaged: Prisma.Decimal;
      reorderPoint: Prisma.Decimal | null;
      reorderQty: Prisma.Decimal | null;
      sellPrice: Prisma.Decimal;
      product: {
        id: true | string;
        name: string;
        skuCode: string;
        photoUrl?: string | null;
        trackQty?: boolean;
        meta?: unknown;
      };
      location: {
        id: string;
        name: string;
        code?: string | null;
        type?: string;
      };
    },
  ) {
    const base = this.mapLevel(r);
    const meta = (r.product.meta ?? {}) as Record<string, unknown>;
    const metaReorder =
      typeof meta.reorderPoint === 'number' ? meta.reorderPoint : null;
    const reorderPoint = base.reorderPoint ?? metaReorder ?? null;
    const threshold = reorderPoint ?? 5;
    const isLowStock =
      base.qtyOnHand <= threshold &&
      (r.product.trackQty !== false);
    return {
      ...base,
      name: r.product.name,
      productSku: r.product.skuCode,
      photoUrl: r.product.photoUrl ?? null,
      location: r.location,
      reorderPoint,
      isLowStock,
    };
  }

  private mapSession(s: {
    id: string;
    locationId: string;
    status: StockCountStatus;
    notes: string | null;
    createdAt: Date;
    completedAt: Date | null;
    location?: { id: string; name: string };
    lines?: Array<{
      id: string;
      stockLevelId: string;
      productId: string;
      systemQty: Prisma.Decimal;
      countedQty: Prisma.Decimal | null;
      variance: Prisma.Decimal | null;
      notes: string | null;
      product?: { id: string; name: string; skuCode: string };
      stockLevel?: { sellUnit: string };
    }>;
  }) {
    return {
      id: s.id,
      locationId: s.locationId,
      status: s.status,
      notes: s.notes,
      createdAt: s.createdAt,
      completedAt: s.completedAt,
      location: s.location,
      lines: (s.lines ?? []).map((l) => ({
        id: l.id,
        stockLevelId: l.stockLevelId,
        productId: l.productId,
        systemQty: Number(l.systemQty),
        countedQty: l.countedQty != null ? Number(l.countedQty) : null,
        variance: l.variance != null ? Number(l.variance) : null,
        notes: l.notes,
        product: l.product,
        sellUnit: l.stockLevel?.sellUnit ?? 'pcs',
      })),
    };
  }
}
