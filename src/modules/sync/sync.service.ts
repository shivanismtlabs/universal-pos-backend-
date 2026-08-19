import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SyncStatus, Prisma } from '@prisma/client';
import { pageMeta, paginate } from '../../common/dto/pagination.dto';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { PaymentsService } from '../payments/payments.service';
import { isInternalImmediate } from '../payments/payment-capabilities';
import { PaymentMethod, PaymentType } from '@prisma/client';
import { PosService } from '../pos/pos.service';
import {
  CreateSyncEventDto,
  ListSyncEventsQueryDto,
  OfflineSnapshotQueryDto,
  ResolveSyncEventDto,
} from './dto/sync.dto';

/**
 * Offline queue sync — accepts FE events keyed by clientEventId.
 * `storeId` from clients is treated as locationId (legacy name).
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly posService: PosService,
  ) {}

  /** Lightweight reachability probe for offline connectivity detection */
  ping() {
    return { ok: true as const, ts: new Date().toISOString() };
  }

  /**
   * Download snapshot for local-first POS: catalog, stock, customers,
   * promotions, staff PIN hashes (never plaintext passwords).
   */
  async snapshot(user: AuthUser, query: OfflineSnapshotQueryDto) {
    const location = await this.prisma.location.findFirst({
      where: { id: query.locationId, tenantId: user.tenantId },
      select: { id: true, name: true, code: true, settings: true },
    });
    if (!location) throw new NotFoundException('Location not found');

    let since: Date | null = null;
    if (query.since?.trim()) {
      const d = new Date(query.since);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException('Invalid since timestamp');
      }
      since = d;
    }

    const locSettings =
      location.settings && typeof location.settings === 'object'
        ? (location.settings as Record<string, unknown>)
        : {};

    const productWhere: Prisma.ProductWhereInput = {
      tenantId: user.tenantId,
      availableInPos: true,
      status: { in: ['active', 'inactive'] },
      ...(since ? { updatedAt: { gt: since } } : {}),
    };

    const stockWhere: Prisma.StockLevelWhereInput = {
      tenantId: user.tenantId,
      locationId: query.locationId,
      ...(since ? { updatedAt: { gt: since } } : {}),
    };

    const customerWhere: Prisma.CustomerWhereInput = {
      tenantId: user.tenantId,
      deletedAt: null,
      ...(since ? { updatedAt: { gt: since } } : {}),
    };

    const couponWhere: Prisma.CouponWhereInput = {
      tenantId: user.tenantId,
      isActive: true,
      ...(since ? { updatedAt: { gt: since } } : {}),
    };

    const [
      products,
      stockLevels,
      customers,
      coupons,
      categories,
      staff,
      tenant,
    ] = await Promise.all([
      this.prisma.product.findMany({
        where: productWhere,
        orderBy: { name: 'asc' },
        take: since ? 2000 : 3000,
        select: {
          id: true,
          name: true,
          shortName: true,
          skuCode: true,
          barcode: true,
          categoryId: true,
          kind: true,
          status: true,
          basePrice: true,
          mrp: true,
          taxCode: true,
          unitOfMeasure: true,
          trackQty: true,
          canSell: true,
          availableInPos: true,
          photoUrl: true,
          updatedAt: true,
        },
      }),
      this.prisma.stockLevel.findMany({
        where: stockWhere,
        take: since ? 5000 : 8000,
        select: {
          id: true,
          productId: true,
          locationId: true,
          sku: true,
          qtyOnHand: true,
          qtyDamaged: true,
          reorderPoint: true,
          sellPrice: true,
          updatedAt: true,
        },
      }),
      this.prisma.customer.findMany({
        where: customerWhere,
        orderBy: { updatedAt: 'desc' },
        take: since ? 2000 : 5000,
        select: {
          id: true,
          fullName: true,
          phone: true,
          email: true,
          creditLimit: true,
          storeCreditBalance: true,
          loyaltyPoints: true,
          updatedAt: true,
        },
      }),
      this.prisma.coupon.findMany({
        where: couponWhere,
        take: 500,
        select: {
          id: true,
          code: true,
          description: true,
          discountType: true,
          discountValue: true,
          minOrderAmount: true,
          maxRedemptions: true,
          redemptionCount: true,
          startsAt: true,
          endsAt: true,
          isActive: true,
          updatedAt: true,
        },
      }),
      this.prisma.category.findMany({
        where: {
          tenantId: user.tenantId,
          ...(since ? { updatedAt: { gt: since } } : {}),
        },
        select: {
          id: true,
          name: true,
          parentId: true,
          updatedAt: true,
        },
        take: 1000,
      }),
      this.prisma.user.findMany({
        where: {
          tenantId: user.tenantId,
          isActive: true,
          pinHash: { not: null },
          ...(since ? { updatedAt: { gt: since } } : {}),
        },
        select: {
          id: true,
          fullName: true,
          email: true,
          pinHash: true,
          primaryLocationId: true,
          updatedAt: true,
          userRoles: {
            select: { role: { select: { code: true } } },
          },
        },
        take: 200,
      }),
      this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { settings: true, currencyCode: true, taxMode: true },
      }),
    ]);

    const settings =
      tenant?.settings && typeof tenant.settings === 'object'
        ? (tenant.settings as Record<string, unknown>)
        : {};
    const offline =
      settings.offline && typeof settings.offline === 'object'
        ? (settings.offline as Record<string, unknown>)
        : {};

    const serverTime = new Date().toISOString();

    return {
      serverTime,
      location: {
        id: location.id,
        name: location.name,
        code: location.code,
        timezone:
          typeof locSettings.timezone === 'string'
            ? locSettings.timezone
            : null,
      },
      incremental: Boolean(since),
      since: since?.toISOString() ?? null,
      offlinePolicy: {
        maxSaleAmount:
          typeof offline.maxSaleAmount === 'number'
            ? offline.maxSaleAmount
            : null,
        blockStoreCredit: offline.blockStoreCredit === true,
        managerPinAbove:
          typeof offline.managerPinAbove === 'number'
            ? offline.managerPinAbove
            : null,
        saleHistoryMonths:
          typeof offline.saleHistoryMonths === 'number'
            ? offline.saleHistoryMonths
            : 3,
      },
      tax: {
        mode: tenant?.taxMode ?? 'in_gst',
        currency: tenant?.currencyCode ?? 'INR',
      },
      counts: {
        products: products.length,
        stockLevels: stockLevels.length,
        customers: customers.length,
        coupons: coupons.length,
        categories: categories.length,
        staff: staff.length,
      },
      products: products.map((p) => ({
        ...p,
        basePrice: Number(p.basePrice),
        mrp: p.mrp != null ? Number(p.mrp) : null,
        updatedAt: p.updatedAt.toISOString(),
      })),
      stockLevels: stockLevels.map((s) => ({
        ...s,
        qtyOnHand: Number(s.qtyOnHand),
        qtyDamaged: Number(s.qtyDamaged),
        reorderPoint:
          s.reorderPoint != null ? Number(s.reorderPoint) : null,
        sellPrice: Number(s.sellPrice),
        updatedAt: s.updatedAt.toISOString(),
      })),
      customers: customers.map((c) => ({
        id: c.id,
        name: c.fullName,
        phone: c.phone,
        email: c.email,
        creditLimit:
          c.creditLimit != null ? Number(c.creditLimit) : null,
        storeCreditBalance: Number(c.storeCreditBalance ?? 0),
        loyaltyPoints: Number(c.loyaltyPoints ?? 0),
        updatedAt: c.updatedAt.toISOString(),
      })),
      coupons: coupons.map((c) => ({
        ...c,
        discountValue: Number(c.discountValue),
        minOrderAmount:
          c.minOrderAmount != null ? Number(c.minOrderAmount) : null,
        startsAt: c.startsAt?.toISOString() ?? null,
        endsAt: c.endsAt?.toISOString() ?? null,
        updatedAt: c.updatedAt.toISOString(),
      })),
      categories: categories.map((c) => ({
        ...c,
        updatedAt: c.updatedAt.toISOString(),
      })),
      staff: staff.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        email: u.email,
        pinHash: u.pinHash,
        primaryLocationId: u.primaryLocationId,
        roles: u.userRoles.map((r) => r.role.code),
        updatedAt: u.updatedAt.toISOString(),
      })),
    };
  }

  async createEvent(user: AuthUser, dto: CreateSyncEventDto) {
    const locationId = dto.storeId;
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: user.tenantId },
      select: { id: true },
    });
    if (!location) throw new NotFoundException('Location / store not found');

    const existing = await this.prisma.offlineSyncEvent.findUnique({
      where: {
        tenantId_clientEventId: {
          tenantId: user.tenantId,
          clientEventId: dto.clientEventId,
        },
      },
    });
    if (existing) {
      return this.toClient(existing);
    }

    try {
      const created = await this.prisma.offlineSyncEvent.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          deviceId: dto.deviceId,
          clientEventId: dto.clientEventId,
          eventType: dto.eventType,
          payload: dto.payload as Prisma.InputJsonValue,
          status: SyncStatus.accepted,
        },
      });

      await this.applyEvent(user, created.id, dto);

      const row = await this.prisma.offlineSyncEvent.findUniqueOrThrow({
        where: { id: created.id },
      });
      return this.toClient(row);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const winner = await this.prisma.offlineSyncEvent.findUnique({
          where: {
            tenantId_clientEventId: {
              tenantId: user.tenantId,
              clientEventId: dto.clientEventId,
            },
          },
        });
        if (winner) return this.toClient(winner);
      }
      throwIfUnique(e, 'Duplicate sync event');
    }
  }

  private async applyEvent(
    user: AuthUser,
    eventId: string,
    dto: CreateSyncEventDto,
  ) {
    try {
      if (dto.eventType === 'pos.cash_payment') {
        const payload = dto.payload as {
          orderId?: string;
          amount?: number;
          method?: string;
          type?: string;
        };
        if (!payload.orderId || !payload.amount) {
          throw new BadRequestException('Invalid cash payment payload');
        }
        const method = (payload.method as PaymentMethod) || PaymentMethod.cash;
        if (!isInternalImmediate(method)) {
          throw new BadRequestException(
            'Offline sync cannot record external payments as succeeded',
          );
        }
        await this.paymentsService.create(user, {
          orderId: payload.orderId,
          amount: Number(payload.amount),
          method,
          type: (payload.type as PaymentType) || PaymentType.payment,
          idempotencyKey: `offline:${dto.clientEventId}`,
        });
      }
      if (dto.eventType === 'pos.sale_checkout_cash') {
        const payload = dto.payload as {
          locationId?: string;
          customerId?: string;
          items?: Array<{
            stockLevelId: string;
            quantity: number;
            unitPrice?: number;
            variantId?: string;
            batchId?: string;
            serialNumber?: string;
          }>;
          note?: string;
          discountAmount?: number;
          loyaltyPointsToRedeem?: number;
          allowPartial?: boolean;
          cashTendered?: number;
          paymentAmount?: number;
          meta?: Record<string, unknown>;
        };
        if (!payload.locationId || !Array.isArray(payload.items) || !payload.items.length) {
          throw new BadRequestException('Invalid offline sale payload');
        }
        await this.posService.saleCheckout(user, {
          locationId: payload.locationId,
          ...(payload.customerId ? { customerId: payload.customerId } : {}),
          items: payload.items.map((line) => ({
            stockLevelId: line.stockLevelId,
            quantity: Number(line.quantity),
            ...(line.unitPrice != null ? { unitPrice: Number(line.unitPrice) } : {}),
            ...(line.variantId ? { variantId: line.variantId } : {}),
            ...(line.batchId ? { batchId: line.batchId } : {}),
            ...(line.serialNumber ? { serialNumber: line.serialNumber } : {}),
          })),
          payments: [
            {
              method: PaymentMethod.cash,
              amount: Number(
                payload.paymentAmount ??
                  payload.items.reduce((sum, i) => {
                    const price = i.unitPrice ?? 0;
                    return sum + Number(price) * Number(i.quantity);
                  }, 0),
              ),
              idempotencyKey: `offline:${dto.clientEventId}`,
            },
          ],
          ...(payload.cashTendered != null
            ? { cashTendered: Number(payload.cashTendered) }
            : {}),
          ...(payload.note ? { note: payload.note } : {}),
          ...(payload.discountAmount != null
            ? { discountAmount: Number(payload.discountAmount) }
            : {}),
          ...(payload.loyaltyPointsToRedeem != null
            ? { loyaltyPointsToRedeem: Number(payload.loyaltyPointsToRedeem) }
            : {}),
          ...(payload.allowPartial ? { allowPartial: true } : {}),
          ...(payload.meta ? { meta: payload.meta } : {}),
        });
      }

      await this.prisma.offlineSyncEvent.update({
        where: { id: eventId },
        data: { status: SyncStatus.accepted },
      });
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : 'Inventory sync could not be applied';
      const payload =
        dto.payload && typeof dto.payload === 'object'
          ? { ...(dto.payload as Record<string, unknown>) }
          : { value: dto.payload };
      await this.prisma.offlineSyncEvent.update({
        where: { id: eventId },
        data: {
          status: SyncStatus.conflict,
          payload: {
            ...payload,
            _syncError: msg,
            _serverAuthoritative: true,
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  async listEvents(user: AuthUser, query: ListSyncEventsQueryDto) {
    const { page, limit, skip } = paginate(query.page, query.limit);

    const where: Prisma.OfflineSyncEventWhereInput = {
      tenantId: user.tenantId,
      ...(query.storeId ? { locationId: query.storeId } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.offlineSyncEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.offlineSyncEvent.count({ where }),
    ]);

    return {
      items: items.map((row) => this.toClient(row)),
      meta: pageMeta(total, page, limit),
    };
  }

  async resolveEvent(user: AuthUser, id: string, dto: ResolveSyncEventDto) {
    const event = await this.prisma.offlineSyncEvent.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!event) throw new NotFoundException('Sync event not found');

    const row = await this.prisma.offlineSyncEvent.update({
      where: { id },
      data: { status: dto.syncStatus },
    });
    return this.toClient(row);
  }

  private toClient(row: {
    id: string;
    eventType: string;
    status: SyncStatus;
    clientEventId: string;
    createdAt: Date;
    locationId?: string | null;
    deviceId: string;
    payload?: unknown;
  }) {
    const payload =
      row.payload && typeof row.payload === 'object'
        ? (row.payload as Record<string, unknown>)
        : {};
    return {
      id: row.id,
      eventType: row.eventType,
      syncStatus: row.status,
      status: row.status,
      clientEventId: row.clientEventId,
      storeId: row.locationId,
      locationId: row.locationId,
      deviceId: row.deviceId,
      createdAt: row.createdAt,
      lastError: typeof payload._syncError === 'string' ? payload._syncError : null,
      serverAuthoritative: payload._serverAuthoritative === true,
    };
  }
}
