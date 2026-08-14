import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FulfillmentMode,
  Prisma,
  ReservationStatus,
  StockUnitStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  AvailabilityQueryDto,
  CreateCategoryDto,
  CreateInventoryUnitDto,
  CreateProductStyleDto,
  CreateRetailSkuDto,
  ListRetailSkusQueryDto,
  ListUnitsQueryDto,
  ReleaseReservationDto,
  ReserveUnitDto,
  TransferStockDto,
  UpdateUnitStatusDto,
} from './dto/inventory.dto';
import { assertLocationAccess } from '../../common/location-access';
import { LowStockAlertService } from '../notify/low-stock-alert.service';

const BLOCKED_FOR_RESERVE: StockUnitStatus[] = [
  StockUnitStatus.checked_out,
  StockUnitStatus.cleaning,
  StockUnitStatus.repair,
  StockUnitStatus.retired,
];

const ACTIVE_RESERVATION: ReservationStatus[] = [
  ReservationStatus.held,
  ReservationStatus.checked_out,
];

const LEGACY_STATUS: Record<string, StockUnitStatus> = {
  AVAILABLE: StockUnitStatus.available,
  RESERVED: StockUnitStatus.reserved,
  CHECKED_OUT: StockUnitStatus.checked_out,
  IN_SERVICE: StockUnitStatus.in_service,
  CLEANING: StockUnitStatus.cleaning,
  REPAIR: StockUnitStatus.repair,
  RETIRED: StockUnitStatus.retired,
};

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lowStock: LowStockAlertService,
  ) {}

  async createCategory(user: AuthUser, dto: CreateCategoryDto) {
    try {
      return await this.prisma.category.create({
        data: { tenantId: user.tenantId, name: dto.name.trim() },
      });
    } catch (error) {
      throwIfUnique(error, 'Category name already exists');
    }
  }

  listCategories(user: AuthUser) {
    return this.prisma.category.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true },
    });
  }

  async createStyle(user: AuthUser, dto: CreateProductStyleDto) {
    if (dto.categoryId) await this.assertCategory(user.tenantId, dto.categoryId);

    const mode =
      dto.fulfillmentMode ??
      (dto.isRental === false ? FulfillmentMode.sale : FulfillmentMode.rental);
    const isRental = mode === FulfillmentMode.rental;
    const isService = mode === FulfillmentMode.service;

    try {
      return await this.prisma.product.create({
        data: {
          tenantId: user.tenantId,
          categoryId: dto.categoryId,
          name: dto.name.trim(),
          skuCode: dto.styleCode.trim().toUpperCase(),
          kind: isService ? 'service' : 'physical',
          fulfillmentMode: mode,
          trackSerial: isRental,
          trackQty: !isRental && !isService,
          basePrice: dto.basePrice ?? 0,
          description: dto.description?.trim(),
          photoUrl: dto.photoUrl?.trim(),
          taxCode: dto.hsnSac?.trim(),
          meta: dto.color ? { color: dto.color.trim() } : {},
        },
      });
    } catch (error) {
      throwIfUnique(error, 'Style code already exists for this shop');
    }
  }

  listStyles(user: AuthUser) {
    return this.prisma.product.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        skuCode: true,
        fulfillmentMode: true,
        kind: true,
        basePrice: true,
        trackSerial: true,
        trackQty: true,
        taxCode: true,
        categoryId: true,
        photoUrl: true,
        meta: true,
        category: { select: { id: true, name: true } },
        _count: { select: { stockUnits: true, stockLevels: true } },
      },
    });
  }

  async getStyle(user: AuthUser, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { stockUnits: true } },
      },
    });
    if (!product) throw new NotFoundException('Product style not found');
    return product;
  }

  async createUnit(user: AuthUser, dto: CreateInventoryUnitDto) {
    const locationId = this.requiredAlias(dto.locationId, dto.storeId, 'locationId or storeId');
    const productId = this.requiredAlias(dto.productId, dto.productStyleId, 'productId or productStyleId');
    const status = (dto.status ?? dto.availabilityStatus)
      ? this.toStockStatus(dto.status ?? dto.availabilityStatus!)
      : StockUnitStatus.available;
    await this.assertLocation(user.tenantId, locationId, user);
    await this.assertProduct(user.tenantId, productId);
    if (dto.supplierId) await this.assertSupplier(user.tenantId, dto.supplierId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id: productId },
          data: { basePrice: dto.rentalPrice.toFixed(2) },
        });
        const unit = await tx.stockUnit.create({
          data: {
            tenantId: user.tenantId,
            locationId,
            productId,
            barcodeSku: dto.barcodeSku.trim().toUpperCase(),
            variantLabel: (dto.variantLabel ?? dto.size)?.trim(),
            condition: dto.condition ?? 'good',
            status,
            ownership: dto.ownership ?? 'own',
            supplierId: dto.supplierId,
            depositAmount: (dto.depositAmount ?? 0).toFixed(2),
            purchaseCost: dto.purchaseCost?.toFixed(2),
            meta: { rentalPrice: dto.rentalPrice },
          },
        });
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId: unit.id,
            fromStatus: null,
            toStatus: status,
            reason: 'unit.created',
            actorUserId: user.userId,
          },
        });
        return unit;
      });
    } catch (error) {
      throwIfUnique(error, 'Barcode/SKU already exists for this shop');
    }
  }

  async listUnits(user: AuthUser, query: ListUnitsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const status = query.status ?? query.availabilityStatus;
    const where: Prisma.StockUnitWhereInput = {
      tenantId: user.tenantId,
      ...(this.alias(query.locationId, query.storeId)
        ? { locationId: this.alias(query.locationId, query.storeId) }
        : {}),
      ...(this.alias(query.productId, query.productStyleId)
        ? { productId: this.alias(query.productId, query.productStyleId) }
        : {}),
      ...(this.alias(query.variantLabel, query.size)
        ? { variantLabel: this.alias(query.variantLabel, query.size)?.trim() }
        : {}),
      ...(status ? { status: this.toStockStatus(status) } : {}),
      ...(query.barcodeSku ? { barcodeSku: query.barcodeSku.trim().toUpperCase() } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.stockUnit.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { id: true, name: true, skuCode: true, fulfillmentMode: true, basePrice: true } },
          location: { select: { id: true, name: true, code: true } },
        },
      }),
      this.prisma.stockUnit.count({ where }),
    ]);
    return { items, meta: pageMeta(total, page, limit) };
  }

  async getUnit(user: AuthUser, id: string) {
    const unit = await this.prisma.stockUnit.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        product: true,
        location: { select: { id: true, name: true, code: true } },
        reservations: {
          where: { status: { in: ACTIVE_RESERVATION } },
          orderBy: { startDate: 'asc' },
          take: 20,
        },
      },
    });
    if (!unit) throw new NotFoundException('Inventory unit not found');
    return unit;
  }

  async checkAvailability(user: AuthUser, query: AvailabilityQueryDto) {
    const { start, end } = this.parseDateRange(query.startDate, query.endDate);
    const units = await this.prisma.stockUnit.findMany({
      where: {
        tenantId: user.tenantId,
        status: { notIn: BLOCKED_FOR_RESERVE },
        ...(this.alias(query.locationId, query.storeId)
          ? { locationId: this.alias(query.locationId, query.storeId) }
          : {}),
        ...(this.alias(query.productId, query.productStyleId)
          ? { productId: this.alias(query.productId, query.productStyleId) }
          : {}),
        ...(this.alias(query.variantLabel, query.size)
          ? { variantLabel: this.alias(query.variantLabel, query.size)?.trim() }
          : {}),
        reservations: {
          none: {
            status: { in: ACTIVE_RESERVATION },
            startDate: { lte: end },
            endDate: { gte: start },
          },
        },
      },
      include: {
        product: { select: { id: true, name: true, skuCode: true, basePrice: true } },
        location: { select: { id: true, name: true, code: true } },
      },
      orderBy: [{ variantLabel: 'asc' }, { barcodeSku: 'asc' }],
      take: 200,
    });
    return { startDate: query.startDate, endDate: query.endDate, availableCount: units.length, units };
  }

  async reserveUnit(user: AuthUser, dto: ReserveUnitDto) {
    const stockUnitId = this.requiredAlias(dto.stockUnitId, dto.inventoryUnitId, 'stockUnitId or inventoryUnitId');
    const { start, end } = this.parseDateRange(dto.startDate, dto.endDate);
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.stockUnit.findFirst({
        where: { id: stockUnitId, tenantId: user.tenantId },
        select: { id: true, status: true },
      });
      if (!unit) throw new NotFoundException('Inventory unit not found');
      if (BLOCKED_FOR_RESERVE.includes(unit.status)) {
        throw new ConflictException(`Unit cannot be reserved while status is ${unit.status}`);
      }
      const overlap = await tx.stockReservation.findFirst({
        where: {
          stockUnitId,
          tenantId: user.tenantId,
          status: { in: ACTIVE_RESERVATION },
          startDate: { lte: end },
          endDate: { gte: start },
        },
        select: { id: true },
      });
      if (overlap) throw new ConflictException('Unit already reserved for overlapping dates');
      const reservation = await tx.stockReservation.create({
        data: { tenantId: user.tenantId, stockUnitId, startDate: start, endDate: end, status: ReservationStatus.held },
      });
      if (unit.status === StockUnitStatus.available) {
        await tx.stockUnit.update({ where: { id: stockUnitId }, data: { status: StockUnitStatus.reserved } });
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId,
            fromStatus: StockUnitStatus.available,
            toStatus: StockUnitStatus.reserved,
            reason: 'reservation.held',
            actorUserId: user.userId,
          },
        });
      }
      return reservation;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async releaseReservation(user: AuthUser, reservationId: string, dto: ReleaseReservationDto) {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findFirst({
        where: { id: reservationId, tenantId: user.tenantId },
      });
      if (!reservation) throw new NotFoundException('Reservation not found');
      if (reservation.status === ReservationStatus.cancelled) return reservation;
      if (reservation.status === ReservationStatus.checked_out) {
        throw new ConflictException('Cannot release a checked-out reservation; use returns flow');
      }
      const updated = await tx.stockReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.cancelled },
      });
      const activeLeft = await tx.stockReservation.count({
        where: { stockUnitId: reservation.stockUnitId, tenantId: user.tenantId, status: { in: ACTIVE_RESERVATION } },
      });
      if (activeLeft === 0) {
        const unit = await tx.stockUnit.findFirst({
          where: { id: reservation.stockUnitId, tenantId: user.tenantId },
        });
        if (unit?.status === StockUnitStatus.reserved) {
          await tx.stockUnit.update({ where: { id: unit.id }, data: { status: StockUnitStatus.available } });
          await tx.stockMovement.create({
            data: {
              tenantId: user.tenantId,
              stockUnitId: unit.id,
              fromStatus: StockUnitStatus.reserved,
              toStatus: StockUnitStatus.available,
              reason: dto.reason ?? 'reservation.released',
              actorUserId: user.userId,
            },
          });
        }
      }
      return updated;
    });
  }

  async updateUnitStatus(user: AuthUser, unitId: string, dto: UpdateUnitStatusDto) {
    const status = this.toStockStatus(dto.availabilityStatus);
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.stockUnit.findFirst({ where: { id: unitId, tenantId: user.tenantId } });
      if (!unit) throw new NotFoundException('Inventory unit not found');
      if (status === StockUnitStatus.available && unit.status === StockUnitStatus.checked_out) {
        throw new BadRequestException('Use returns workflow to make a checked-out unit available');
      }
      const updated = await tx.stockUnit.update({
        where: { id: unitId },
        data: { status, ...(dto.condition ? { condition: dto.condition } : {}) },
      });
      if (status !== unit.status) {
        await tx.stockMovement.create({
          data: { tenantId: user.tenantId, stockUnitId: unitId, fromStatus: unit.status, toStatus: status, reason: dto.reason ?? 'status.manual_update', actorUserId: user.userId },
        });
      }
      return updated;
    });
  }

  async listMovements(user: AuthUser, unitId: string) {
    await this.getUnit(user, unitId);
    return this.prisma.stockMovement.findMany({
      where: { tenantId: user.tenantId, stockUnitId: unitId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, fromStatus: true, toStatus: true, reason: true, createdAt: true, actorUserId: true },
    });
  }

  async createRetailSku(user: AuthUser, dto: CreateRetailSkuDto) {
    const locationId = this.requiredAlias(dto.locationId, dto.storeId, 'locationId or storeId');
    const productId = this.requiredAlias(dto.productId, dto.productStyleId, 'productId or productStyleId');
    await this.assertLocation(user.tenantId, locationId, user);
    await this.assertProduct(user.tenantId, productId);
    try {
      return await this.prisma.stockLevel.create({
        data: { tenantId: user.tenantId, locationId, productId, sku: dto.sku.trim().toUpperCase(), sellPrice: dto.sellPrice.toFixed(2), qtyOnHand: dto.qtyOnHand ?? 0 },
      });
    } catch (error) {
      throwIfUnique(error, 'SKU or product stock level already exists for this location');
    }
  }

  async listRetailSkus(user: AuthUser, query: ListRetailSkusQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);
    const where: Prisma.StockLevelWhereInput = {
      tenantId: user.tenantId,
      ...(this.alias(query.locationId, query.storeId) ? { locationId: this.alias(query.locationId, query.storeId) } : {}),
      ...(this.alias(query.productId, query.productStyleId) ? { productId: this.alias(query.productId, query.productStyleId) } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.stockLevel.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { id: true, name: true, skuCode: true } },
          location: { select: { id: true, name: true, code: true } },
        },
      }),
      this.prisma.stockLevel.count({ where }),
    ]);
    return { items, meta: pageMeta(total, page, limit) };
  }

  /**
   * Multi-location qty transfer (business-agnostic).
   * Moves StockLevel on-hand from A → B; creates dest row if missing.
   */
  async transferStock(user: AuthUser, dto: TransferStockDto) {
    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException(
        'Source and destination locations must be different',
      );
    }
    if (!dto.lines?.length) {
      throw new BadRequestException('Add at least one transfer line');
    }

    await this.assertLocation(user.tenantId, dto.fromLocationId, user);
    await this.assertLocation(user.tenantId, dto.toLocationId, user);

    const result = await this.prisma.$transaction(async (tx) => {
      const moved: Array<{
        productId: string;
        productName: string;
        sku: string;
        qty: number;
        fromQtyOnHand: number;
        toQtyOnHand: number;
        fromLevelId: string;
        toLevelId: string;
      }> = [];

      for (const line of dto.lines) {
        const qty = Number(line.qty);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new BadRequestException('Transfer qty must be greater than 0');
        }

        const product = await tx.product.findFirst({
          where: {
            id: line.productId,
            tenantId: user.tenantId,
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            skuCode: true,
            trackQty: true,
            basePrice: true,
          },
        });
        if (!product) {
          throw new NotFoundException(`Product ${line.productId} not found`);
        }
        if (!product.trackQty) {
          throw new BadRequestException(
            `"${product.name}" is not quantity-tracked. Serial-only items need unit move (not bulk transfer).`,
          );
        }

        const fromLevel = await tx.stockLevel.findFirst({
          where: {
            tenantId: user.tenantId,
            locationId: dto.fromLocationId,
            productId: product.id,
          },
        });
        if (!fromLevel) {
          throw new BadRequestException(
            `No stock for "${product.name}" at source location`,
          );
        }
        const fromQty = Number(fromLevel.qtyOnHand);
        if (fromQty + 1e-9 < qty) {
          throw new BadRequestException(
            `Insufficient stock for "${product.name}" (have ${fromQty}, need ${qty})`,
          );
        }

        const updatedFrom = await tx.stockLevel.update({
          where: { id: fromLevel.id },
          data: { qtyOnHand: { decrement: qty } },
        });

        let toLevel = await tx.stockLevel.findFirst({
          where: {
            tenantId: user.tenantId,
            locationId: dto.toLocationId,
            productId: product.id,
          },
        });

        if (toLevel) {
          toLevel = await tx.stockLevel.update({
            where: { id: toLevel.id },
            data: { qtyOnHand: { increment: qty } },
          });
        } else {
          toLevel = await tx.stockLevel.create({
            data: {
              tenantId: user.tenantId,
              locationId: dto.toLocationId,
              productId: product.id,
              sku: product.skuCode,
              sellUnit: fromLevel.sellUnit,
              sellPrice: fromLevel.sellPrice,
              qtyOnHand: qty,
            },
          });
        }

        moved.push({
          productId: product.id,
          productName: product.name,
          sku: product.skuCode,
          qty,
          fromQtyOnHand: Number(updatedFrom.qtyOnHand),
          toQtyOnHand: Number(toLevel.qtyOnHand),
          fromLevelId: fromLevel.id,
          toLevelId: toLevel.id,
        });
      }

      const transferId = randomUUID();

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'stock_transfer',
          entityId: transferId,
          action: 'inventory.stock_transfer',
          beforeAfter: {
            transferId,
            fromLocationId: dto.fromLocationId,
            toLocationId: dto.toLocationId,
            notes: dto.notes ?? null,
            lines: moved.map((m) => ({
              productId: m.productId,
              productName: m.productName,
              sku: m.sku,
              qty: m.qty,
            })),
          },
        },
      });

      for (const m of moved) {
        await tx.stockLedgerEntry.create({
          data: {
            tenantId: user.tenantId,
            locationId: dto.fromLocationId,
            productId: m.productId,
            stockLevelId: m.fromLevelId,
            type: 'transfer_out',
            qtyDelta: -m.qty,
            qtyAfter: m.fromQtyOnHand,
            reason: dto.notes ?? null,
            referenceType: 'stock_transfer',
            referenceId: transferId,
            actorUserId: user.userId,
          },
        });
        await tx.stockLedgerEntry.create({
          data: {
            tenantId: user.tenantId,
            locationId: dto.toLocationId,
            productId: m.productId,
            stockLevelId: m.toLevelId,
            type: 'transfer_in',
            qtyDelta: m.qty,
            qtyAfter: m.toQtyOnHand,
            reason: dto.notes ?? null,
            referenceType: 'stock_transfer',
            referenceId: transferId,
            actorUserId: user.userId,
          },
        });
      }

      return { transferId, moved };
    });

    for (const m of result.moved) {
      void this.lowStock.evaluate({
        tenantId: user.tenantId,
        locationId: dto.fromLocationId,
        productId: m.productId,
      });
      void this.lowStock.evaluate({
        tenantId: user.tenantId,
        locationId: dto.toLocationId,
        productId: m.productId,
      });
    }

    return {
      id: result.transferId,
      fromLocationId: dto.fromLocationId,
      toLocationId: dto.toLocationId,
      notes: dto.notes ?? null,
      lines: result.moved.map(({ fromLevelId: _f, toLevelId: _t, ...rest }) => rest),
    };
  }

  /** Transfer history (Zoho-style list). Source: audit logs + location names. */
  async listStockTransfers(user: AuthUser, limit = 100) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 300);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId: user.tenantId,
        entityType: 'stock_transfer',
        action: 'inventory.stock_transfer',
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: { actor: { select: { id: true, fullName: true } } },
    });

    const locIds = new Set<string>();
    for (const r of rows) {
      const ba = (r.beforeAfter ?? {}) as Record<string, unknown>;
      if (typeof ba.fromLocationId === 'string') locIds.add(ba.fromLocationId);
      if (typeof ba.toLocationId === 'string') locIds.add(ba.toLocationId);
    }
    const locations = locIds.size
      ? await this.prisma.location.findMany({
          where: { tenantId: user.tenantId, id: { in: [...locIds] } },
          select: { id: true, name: true, code: true },
        })
      : [];
    const locMap = new Map(locations.map((l) => [l.id, l]));

    return {
      items: rows.map((r) => {
        const ba = (r.beforeAfter ?? {}) as {
          transferId?: string;
          fromLocationId?: string;
          toLocationId?: string;
          notes?: string | null;
          lines?: Array<{
            productId?: string;
            productName?: string;
            sku?: string;
            qty?: number;
          }>;
        };
        const from = ba.fromLocationId
          ? locMap.get(ba.fromLocationId)
          : undefined;
        const to = ba.toLocationId ? locMap.get(ba.toLocationId) : undefined;
        const lines = Array.isArray(ba.lines) ? ba.lines : [];
        const totalQty = lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
        return {
          id: r.entityId ?? (ba.transferId as string | undefined) ?? r.id,
          createdAt: r.createdAt,
          notes: ba.notes ?? null,
          fromLocationId: ba.fromLocationId ?? null,
          toLocationId: ba.toLocationId ?? null,
          fromLocationName: from?.name ?? '—',
          toLocationName: to?.name ?? '—',
          lineCount: lines.length,
          totalQty,
          lines: lines.map((l) => ({
            productId: l.productId ?? null,
            productName: l.productName ?? '—',
            sku: l.sku ?? '—',
            qty: Number(l.qty) || 0,
          })),
          actorName: r.actor?.fullName ?? 'Staff',
        };
      }),
    };
  }

  async listStockAtLocation(user: AuthUser, locationId: string, q?: string) {
    await this.assertLocation(user.tenantId, locationId, user);
    const term = q?.trim();
    const rows = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: user.tenantId,
        locationId,
        qtyOnHand: { gt: 0 },
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
      },
      orderBy: { product: { name: 'asc' } },
      take: 80,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            trackQty: true,
            photoUrl: true,
            fulfillmentMode: true,
          },
        },
      },
    });

    return rows.map((r) => ({
      stockLevelId: r.id,
      productId: r.productId,
      sku: r.sku,
      sellUnit: r.sellUnit,
      qtyOnHand: Number(r.qtyOnHand),
      sellPrice: r.sellPrice,
      name: r.product.name,
      productSku: r.product.skuCode,
      trackQty: r.product.trackQty,
      fulfillmentMode: r.product.fulfillmentMode,
      photoUrl: r.product.photoUrl,
    }));
  }

  private toStockStatus(value: string): StockUnitStatus {
    const normalized = value.trim();
    const status = LEGACY_STATUS[normalized.toUpperCase()] ?? (Object.values(StockUnitStatus) as string[]).find((item) => item === normalized.toLowerCase());
    if (!status) throw new BadRequestException(`Invalid stock unit status: ${value}`);
    return status;
  }

  private alias(primary?: string, legacy?: string) {
    return primary ?? legacy;
  }

  private requiredAlias(primary: string | undefined, legacy: string | undefined, label: string) {
    const value = this.alias(primary, legacy);
    if (!value) throw new BadRequestException(`${label} is required`);
    return value;
  }

  private parseDateRange(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new BadRequestException('Invalid date format');
    if (end < start) throw new BadRequestException('endDate must be on or after startDate');
    const dateOnly = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    return { start: dateOnly(start), end: dateOnly(end) };
  }

  private async assertCategory(tenantId: string, id: string) {
    const row = await this.prisma.category.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!row) throw new NotFoundException('Category not found');
  }

  private async assertProduct(tenantId: string, id: string) {
    const row = await this.prisma.product.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!row) throw new NotFoundException('Product style not found');
  }

  private async assertLocation(tenantId: string, id: string, user?: AuthUser) {
    if (user) {
      await assertLocationAccess(this.prisma, user, id, {
        requireActive: true,
      });
      return;
    }
    const row = await this.prisma.location.findFirst({
      where: { id, tenantId, isActive: true },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Location not found or inactive');
  }

  private async assertSupplier(tenantId: string, id: string) {
    const row = await this.prisma.supplier.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!row) throw new NotFoundException('Supplier not found');
  }
}
