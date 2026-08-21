import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DiningMode,
  DiningTableStatus,
  OrderItemKind,
  OrderKind,
  OrderStatus,
  Prisma,
  RestaurantOrderChannel,
} from '@prisma/client';
import { hasCapability } from '../../common/capabilities';
import { PrismaService } from '../../database/database.module';
import { qrOrderPostsInventory } from './restaurant-policy';
import type { QrPlaceOrderDto } from './dto/restaurant.dto';

@Injectable()
export class RestaurantGuestService {
  constructor(private readonly prisma: PrismaService) {}

  async tableByToken(qrToken: string) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { qrToken },
      include: {
        tenant: { select: { id: true, name: true, settings: true, currencyCode: true } },
        location: { select: { id: true, name: true } },
      },
    });
    if (!table) throw new NotFoundException('Table not found');
    const cfg = await this.prisma.restaurantConfig.findUnique({
      where: { tenantId: table.tenantId },
    });
    const allowed =
      cfg?.qrOrdering === true ||
      hasCapability(table.tenant.settings, 'QR_ORDER');
    if (!allowed) {
      throw new BadRequestException('QR ordering is not enabled');
    }
    return {
      tableId: table.id,
      qrToken: table.qrToken,
      name: table.name,
      status: table.status,
      shop: table.tenant.name,
      location: table.location.name,
      locationId: table.locationId,
      tenantId: table.tenantId,
      currencyCode: table.tenant.currencyCode,
    };
  }

  async menu(qrToken: string) {
    const ctx = await this.tableByToken(qrToken);
    const rows = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        product: { availableInPos: true, isActive: true, canSell: true },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            basePrice: true,
            photoUrl: true,
            meta: true,
          },
        },
      },
      take: 200,
      orderBy: { sku: 'asc' },
    });
    return {
      ...ctx,
      items: rows
        .filter((r) => {
          const m = (r.product.meta ?? {}) as Record<string, unknown>;
          return m.soldOut !== true && m.soldOut !== 'true';
        })
        .map((r) => ({
          stockLevelId: r.id,
          productId: r.productId,
          name: r.product.name,
          sku: r.product.skuCode,
          price: Number(r.sellPrice || r.product.basePrice),
        })),
    };
  }

  async placeOrder(qrToken: string, dto: QrPlaceOrderDto) {
    if (qrOrderPostsInventory()) {
      throw new BadRequestException('Invalid consumption policy');
    }
    const ctx = await this.tableByToken(qrToken);
    const table = await this.prisma.restaurantTable.findFirstOrThrow({
      where: { qrToken },
    });
    if (table.currentOrderId) {
      throw new BadRequestException('Table already has an open order — ask staff');
    }
    if (!dto.items?.length) {
      throw new BadRequestException('Add at least one item');
    }

    const orderNumber = `QR-${Date.now().toString(36).toUpperCase()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          tenantId: ctx.tenantId,
          locationId: ctx.locationId,
          orderNumber,
          kind: OrderKind.sale,
          status: OrderStatus.draft,
          currencyCode: ctx.currencyCode,
          meta: {
            parked: true,
            parkedAt: new Date().toISOString(),
            orderType: 'dine_in',
            tableId: table.id,
            channel: 'qr',
            guestName: dto.guestName ?? null,
          },
        },
      });
      await tx.restaurantOrder.create({
        data: {
          tenantId: ctx.tenantId,
          locationId: ctx.locationId,
          orderId: order.id,
          tableId: table.id,
          diningMode: DiningMode.dine_in,
          channel: RestaurantOrderChannel.qr,
          covers: dto.covers ?? 1,
          guestName: dto.guestName,
          kitchenPhase: 'draft',
          consumptionPosted: false,
        },
      });
      for (const line of dto.items) {
        const level = await tx.stockLevel.findFirst({
          where: {
            id: line.stockLevelId,
            tenantId: ctx.tenantId,
            locationId: ctx.locationId,
          },
          include: { product: { select: { name: true } } },
        });
        if (!level) throw new BadRequestException('Item not on this menu');
        const qty = Number(line.quantity) || 1;
        const unit = Number(level.sellPrice);
        await tx.orderItem.create({
          data: {
            tenantId: ctx.tenantId,
            orderId: order.id,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: qty,
            unitPrice: unit.toFixed(2),
            lineTotal: (unit * qty).toFixed(2),
            taxAmount: '0.00',
            meta: { channel: 'qr' } as Prisma.InputJsonValue,
          },
        });
      }
      await tx.restaurantTable.update({
        where: { id: table.id },
        data: { status: DiningTableStatus.occupied, currentOrderId: order.id },
      });
      return order;
    });
    return {
      orderId: created.id,
      orderNumber: created.orderNumber,
      table: ctx.name,
      postedInventory: false,
    };
  }
}
