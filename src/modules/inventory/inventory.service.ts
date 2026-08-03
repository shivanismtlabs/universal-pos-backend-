import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AvailabilityStatus, Prisma, ReservationStatus } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import {
  isExclusionViolation,
  throwIfUnique,
} from '../../common/prisma/prisma-errors';
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
  UpdateUnitStatusDto,
} from './dto/inventory.dto';

const BLOCKED_FOR_RESERVE: AvailabilityStatus[] = [
  AvailabilityStatus.CHECKED_OUT,
  AvailabilityStatus.CLEANING,
  AvailabilityStatus.REPAIR,
  AvailabilityStatus.RETIRED,
];

const ACTIVE_RESERVATION: ReservationStatus[] = [
  ReservationStatus.held,
  ReservationStatus.checked_out,
];

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Categories ──────────────────────────────────────────────────────────

  async createCategory(user: AuthUser, dto: CreateCategoryDto) {
    try {
      return await this.prisma.category.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name.trim(),
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Category name already exists');
    }
  }

  listCategories(user: AuthUser) {
    return this.prisma.category.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true },
    });
  }

  // ─── Product styles ──────────────────────────────────────────────────────

  async createStyle(user: AuthUser, dto: CreateProductStyleDto) {
    if (dto.categoryId) {
      await this.assertCategory(user.tenantId, dto.categoryId);
    }

    try {
      return await this.prisma.productStyle.create({
        data: {
          tenantId: user.tenantId,
          categoryId: dto.categoryId,
          name: dto.name.trim(),
          styleCode: dto.styleCode.trim().toUpperCase(),
          color: dto.color?.trim(),
          photoUrl: dto.photoUrl,
          isRental: dto.isRental ?? true,
          hsnSac: dto.hsnSac?.trim(),
          description: dto.description?.trim(),
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Style code already exists for this shop');
    }
  }

  listStyles(user: AuthUser) {
    return this.prisma.productStyle.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        styleCode: true,
        color: true,
        isRental: true,
        hsnSac: true,
        categoryId: true,
        photoUrl: true,
        _count: { select: { inventoryUnits: true } },
      },
    });
  }

  async getStyle(user: AuthUser, id: string) {
    const style = await this.prisma.productStyle.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { inventoryUnits: true } },
      },
    });
    if (!style) throw new NotFoundException('Product style not found');
    return style;
  }

  // ─── Units ───────────────────────────────────────────────────────────────

  async createUnit(user: AuthUser, dto: CreateInventoryUnitDto) {
    await this.assertStore(user.tenantId, dto.storeId);
    await this.assertStyle(user.tenantId, dto.productStyleId);

    if (dto.supplierId) {
      const supplier = await this.prisma.supplier.findFirst({
        where: { id: dto.supplierId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!supplier) throw new NotFoundException('Supplier not found');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const unit = await tx.inventoryUnit.create({
          data: {
            tenantId: user.tenantId,
            storeId: dto.storeId,
            productStyleId: dto.productStyleId,
            barcodeSku: dto.barcodeSku.trim().toUpperCase(),
            size: dto.size.trim(),
            condition: dto.condition ?? 'GOOD',
            ownership: dto.ownership ?? 'own',
            supplierId: dto.supplierId,
            rentalPrice: dto.rentalPrice.toFixed(2),
            depositAmount: (dto.depositAmount ?? 0).toFixed(2),
            purchaseCost: dto.purchaseCost?.toFixed(2),
            availabilityStatus: AvailabilityStatus.AVAILABLE,
          },
        });

        await tx.inventoryMovement.create({
          data: {
            tenantId: user.tenantId,
            inventoryUnitId: unit.id,
            fromAvailability: null,
            toAvailability: AvailabilityStatus.AVAILABLE,
            reason: 'unit.created',
            actorUserId: user.userId,
          },
        });

        return unit;
      });
    } catch (e) {
      throwIfUnique(e, 'Barcode/SKU already exists for this shop');
    }
  }

  async listUnits(user: AuthUser, query: ListUnitsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);

    const where: Prisma.InventoryUnitWhereInput = {
      tenantId: user.tenantId,
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.productStyleId ? { productStyleId: query.productStyleId } : {}),
      ...(query.size ? { size: query.size.trim() } : {}),
      ...(query.availabilityStatus
        ? { availabilityStatus: query.availabilityStatus }
        : {}),
      ...(query.barcodeSku
        ? { barcodeSku: query.barcodeSku.trim().toUpperCase() }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.inventoryUnit.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          barcodeSku: true,
          size: true,
          condition: true,
          availabilityStatus: true,
          ownership: true,
          rentalPrice: true,
          depositAmount: true,
          storeId: true,
          productStyleId: true,
          productStyle: {
            select: { id: true, name: true, styleCode: true, color: true },
          },
          store: { select: { id: true, name: true, code: true } },
        },
      }),
      this.prisma.inventoryUnit.count({ where }),
    ]);

    return { items, meta: pageMeta(total, page, limit) };
  }

  async getUnit(user: AuthUser, id: string) {
    const unit = await this.prisma.inventoryUnit.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        productStyle: true,
        store: { select: { id: true, name: true, code: true } },
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

  // ─── Availability (FR-INV-05) ────────────────────────────────────────────

  async checkAvailability(user: AuthUser, query: AvailabilityQueryDto) {
    const { start, end } = this.parseDateRange(query.startDate, query.endDate);

    // Units that are physically rentable and have NO overlapping active reservation
    const units = await this.prisma.inventoryUnit.findMany({
      where: {
        tenantId: user.tenantId,
        availabilityStatus: {
          notIn: BLOCKED_FOR_RESERVE,
        },
        ...(query.storeId ? { storeId: query.storeId } : {}),
        ...(query.productStyleId
          ? { productStyleId: query.productStyleId }
          : {}),
        ...(query.size ? { size: query.size.trim() } : {}),
        reservations: {
          none: {
            status: { in: ACTIVE_RESERVATION },
            startDate: { lte: end },
            endDate: { gte: start },
          },
        },
      },
      select: {
        id: true,
        barcodeSku: true,
        size: true,
        condition: true,
        availabilityStatus: true,
        rentalPrice: true,
        depositAmount: true,
        storeId: true,
        productStyle: {
          select: { id: true, name: true, styleCode: true, color: true },
        },
      },
      orderBy: [{ size: 'asc' }, { barcodeSku: 'asc' }],
      take: 200,
    });

    return {
      startDate: query.startDate,
      endDate: query.endDate,
      availableCount: units.length,
      units,
    };
  }

  // ─── Reserve / release ───────────────────────────────────────────────────

  async reserveUnit(user: AuthUser, dto: ReserveUnitDto) {
    const { start, end } = this.parseDateRange(dto.startDate, dto.endDate);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Row lock — prevents concurrent double-book race
          const locked = await tx.$queryRaw<
            Array<{
              id: string;
              tenant_id: string;
              availability_status: AvailabilityStatus;
            }>
          >`
            SELECT id, tenant_id, availability_status
            FROM inventory_units
            WHERE id = ${dto.inventoryUnitId}::uuid
              AND tenant_id = ${user.tenantId}::uuid
            FOR UPDATE
          `;

          const row = locked[0];
          if (!row) {
            throw new NotFoundException('Inventory unit not found');
          }

          if (BLOCKED_FOR_RESERVE.includes(row.availability_status)) {
            throw new ConflictException(
              `Unit cannot be reserved while status is ${row.availability_status}`,
            );
          }

          const overlap = await tx.unitReservation.findFirst({
            where: {
              inventoryUnitId: dto.inventoryUnitId,
              tenantId: user.tenantId,
              status: { in: ACTIVE_RESERVATION },
              startDate: { lte: end },
              endDate: { gte: start },
            },
            select: { id: true, startDate: true, endDate: true },
          });

          if (overlap) {
            throw new ConflictException(
              'Unit already reserved for overlapping dates',
            );
          }

          const reservation = await tx.unitReservation.create({
            data: {
              tenantId: user.tenantId,
              inventoryUnitId: dto.inventoryUnitId,
              startDate: start,
              endDate: end,
              status: ReservationStatus.held,
            },
          });

          const from = row.availability_status;
          if (from === AvailabilityStatus.AVAILABLE) {
            await tx.inventoryUnit.update({
              where: { id: dto.inventoryUnitId },
              data: { availabilityStatus: AvailabilityStatus.RESERVED },
            });
            await tx.inventoryMovement.create({
              data: {
                tenantId: user.tenantId,
                inventoryUnitId: dto.inventoryUnitId,
                fromAvailability: from,
                toAvailability: AvailabilityStatus.RESERVED,
                reason: 'reservation.held',
                actorUserId: user.userId,
              },
            });
          }

          return reservation;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (e) {
      if (isExclusionViolation(e)) {
        throw new ConflictException(
          'Unit already reserved for overlapping dates',
        );
      }
      throw e;
    }
  }

  async releaseReservation(
    user: AuthUser,
    reservationId: string,
    dto: ReleaseReservationDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.unitReservation.findFirst({
        where: { id: reservationId, tenantId: user.tenantId },
      });
      if (!reservation) {
        throw new NotFoundException('Reservation not found');
      }
      if (reservation.status === ReservationStatus.cancelled) {
        return reservation;
      }
      if (reservation.status === ReservationStatus.checked_out) {
        throw new ConflictException(
          'Cannot release a checked-out reservation; use returns flow',
        );
      }

      const updated = await tx.unitReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.cancelled },
      });

      const activeLeft = await tx.unitReservation.count({
        where: {
          inventoryUnitId: reservation.inventoryUnitId,
          tenantId: user.tenantId,
          status: { in: ACTIVE_RESERVATION },
        },
      });

      if (activeLeft === 0) {
        const unit = await tx.inventoryUnit.findFirst({
          where: {
            id: reservation.inventoryUnitId,
            tenantId: user.tenantId,
          },
        });
        if (unit && unit.availabilityStatus === AvailabilityStatus.RESERVED) {
          await tx.inventoryUnit.update({
            where: { id: unit.id },
            data: { availabilityStatus: AvailabilityStatus.AVAILABLE },
          });
          await tx.inventoryMovement.create({
            data: {
              tenantId: user.tenantId,
              inventoryUnitId: unit.id,
              fromAvailability: AvailabilityStatus.RESERVED,
              toAvailability: AvailabilityStatus.AVAILABLE,
              reason: dto.reason ?? 'reservation.released',
              actorUserId: user.userId,
            },
          });
        }
      }

      return updated;
    });
  }

  async updateUnitStatus(
    user: AuthUser,
    unitId: string,
    dto: UpdateUnitStatusDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const unit = await tx.inventoryUnit.findFirst({
        where: { id: unitId, tenantId: user.tenantId },
      });
      if (!unit) throw new NotFoundException('Inventory unit not found');

      if (
        dto.availabilityStatus === AvailabilityStatus.AVAILABLE &&
        unit.availabilityStatus === AvailabilityStatus.CHECKED_OUT
      ) {
        throw new BadRequestException(
          'Use returns workflow to make a checked-out unit available',
        );
      }

      const updated = await tx.inventoryUnit.update({
        where: { id: unitId },
        data: {
          availabilityStatus: dto.availabilityStatus,
          ...(dto.condition ? { condition: dto.condition } : {}),
        },
      });

      if (dto.availabilityStatus !== unit.availabilityStatus) {
        await tx.inventoryMovement.create({
          data: {
            tenantId: user.tenantId,
            inventoryUnitId: unitId,
            fromAvailability: unit.availabilityStatus,
            toAvailability: dto.availabilityStatus,
            reason: dto.reason ?? 'status.manual_update',
            actorUserId: user.userId,
          },
        });
      }

      return updated;
    });
  }

  async listMovements(user: AuthUser, unitId: string) {
    await this.getUnit(user, unitId);
    return this.prisma.inventoryMovement.findMany({
      where: { tenantId: user.tenantId, inventoryUnitId: unitId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        fromAvailability: true,
        toAvailability: true,
        reason: true,
        createdAt: true,
        actorUserId: true,
      },
    });
  }

  // ─── Retail SKUs ─────────────────────────────────────────────────────────

  async createRetailSku(user: AuthUser, dto: CreateRetailSkuDto) {
    await this.assertStore(user.tenantId, dto.storeId);
    await this.assertStyle(user.tenantId, dto.productStyleId);

    try {
      return await this.prisma.retailSku.create({
        data: {
          tenantId: user.tenantId,
          storeId: dto.storeId,
          productStyleId: dto.productStyleId,
          sku: dto.sku.trim().toUpperCase(),
          sellPrice: dto.sellPrice.toFixed(2),
          qtyOnHand: dto.qtyOnHand ?? 0,
        },
      });
    } catch (e) {
      throwIfUnique(e, 'SKU already exists for this shop');
    }
  }

  async listRetailSkus(user: AuthUser, query: ListRetailSkusQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);

    const where: Prisma.RetailSkuWhereInput = {
      tenantId: user.tenantId,
      ...(query.storeId ? { storeId: query.storeId } : {}),
      ...(query.productStyleId ? { productStyleId: query.productStyleId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.retailSku.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          productStyle: {
            select: { id: true, name: true, styleCode: true },
          },
          store: { select: { id: true, name: true, code: true } },
        },
      }),
      this.prisma.retailSku.count({ where }),
    ]);

    return { items, meta: pageMeta(total, page, limit) };
  }

  // ─── helpers ─────────────────────────────────────────────────────────────

  private parseDateRange(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date format');
    }
    if (end < start) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    // Normalize to date-only UTC for @db.Date
    const toDateOnly = (d: Date) =>
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    return { start: toDateOnly(start), end: toDateOnly(end) };
  }

  private async assertCategory(tenantId: string, id: string) {
    const row = await this.prisma.category.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Category not found');
  }

  private async assertStyle(tenantId: string, id: string) {
    const row = await this.prisma.productStyle.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Product style not found');
  }

  private async assertStore(tenantId: string, id: string) {
    const row = await this.prisma.store.findFirst({
      where: { id, tenantId, isActive: true },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Store not found or inactive');
  }
}
