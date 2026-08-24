import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DiningMode,
  DiningTableStatus,
  KitchenTicketStatus,
  OrderItemKind,
  OrderKind,
  OrderStatus,
  Prisma,
  RestaurantOrderChannel,
} from '@prisma/client';
import { hasCapability } from '../../common/capabilities';
import { PrismaService } from '../../database/database.module';
import {
  parseSellingMenus,
  parseStationKitchenSettings,
  qrOrderPostsInventory,
  routeItemToStationId,
  sellingMenuCategoryFilter,
} from './restaurant-policy';
import type { QrPlaceOrderDto } from './dto/restaurant.dto';

type ModGroup = {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  required: boolean;
  options: Array<{ id: string; name: string; priceDelta: number }>;
};

@Injectable()
export class RestaurantGuestService {
  constructor(private readonly prisma: PrismaService) {}

  async tableByToken(qrToken: string) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { qrToken },
      include: {
        tenant: {
          select: { id: true, name: true, settings: true, currencyCode: true },
        },
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
      sellingMenus: parseSellingMenus(cfg?.meta),
      currentOrderId: table.currentOrderId,
    };
  }

  async menu(qrToken: string) {
    const ctx = await this.tableByToken(qrToken);
    const menuFilter = sellingMenuCategoryFilter({
      menus: ctx.sellingMenus,
      channel: 'qr',
      locationId: ctx.locationId,
    });
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
            categoryId: true,
            category: { select: { name: true } },
          },
        },
      },
      take: 200,
      orderBy: { sku: 'asc' },
    });
    const { sellingMenus: _menus, ...publicCtx } = ctx;
    return {
      ...publicCtx,
      payAtCounter: true,
      items: rows
        .filter((r) => {
          if (!menuFilter.restrict) return true;
          if (!menuFilter.categoryIds.length) return false;
          return (
            typeof r.product.categoryId === 'string' &&
            menuFilter.categoryIds.includes(r.product.categoryId)
          );
        })
        .map((r) => {
          const m = (r.product.meta ?? {}) as Record<string, unknown>;
          const soldOut = m.soldOut === true || m.soldOut === 'true';
          return {
            stockLevelId: r.id,
            productId: r.productId,
            name: r.product.name,
            sku: r.product.skuCode,
            price: Number(r.sellPrice || r.product.basePrice),
            photoUrl: r.product.photoUrl,
            category: r.product.category?.name ?? 'Menu',
            soldOut,
            modifierGroups: parseModifierGroups(m),
          };
        }),
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
    if (table.status === DiningTableStatus.blocked) {
      throw new BadRequestException('This table is not taking orders');
    }
    if (!dto.items?.length) {
      throw new BadRequestException('Add at least one item');
    }
    const menuFilter = sellingMenuCategoryFilter({
      menus: ctx.sellingMenus,
      channel: 'qr',
      locationId: ctx.locationId,
    });

    const created = await this.prisma.$transaction(async (tx) => {
      let orderId = table.currentOrderId;
      if (!orderId) {
        const orderNumber = `QR-${Date.now().toString(36).toUpperCase()}`;
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
        orderId = order.id;
      }

      const newItemIds: string[] = [];
      for (const line of dto.items) {
        const level = await tx.stockLevel.findFirst({
          where: {
            id: line.stockLevelId,
            tenantId: ctx.tenantId,
            locationId: ctx.locationId,
          },
          include: {
            product: {
              select: { name: true, categoryId: true, meta: true },
            },
          },
        });
        if (!level) throw new BadRequestException('Item not on this menu');
        const meta = (level.product.meta ?? {}) as Record<string, unknown>;
        if (meta.soldOut === true || meta.soldOut === 'true') {
          throw new BadRequestException(`${level.product.name} is sold out`);
        }
        if (
          menuFilter.restrict &&
          (!level.product.categoryId ||
            !menuFilter.categoryIds.includes(level.product.categoryId))
        ) {
          throw new BadRequestException('Item is not on the current QR list');
        }
        const qty = Number(line.quantity) || 1;
        const mods = (line.modifiers ?? [])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 40);
        const extra = modifierDelta(parseModifierGroups(meta), mods);
        const unit = Number(level.sellPrice) + extra;
        const item = await tx.orderItem.create({
          data: {
            tenantId: ctx.tenantId,
            orderId,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: qty,
            unitPrice: unit.toFixed(2),
            lineTotal: (unit * qty).toFixed(2),
            taxAmount: '0.00',
            meta: {
              channel: 'qr',
              ...(mods.length ? { modifiers: mods } : {}),
              ...(line.note?.trim() ? { note: line.note.trim() } : {}),
            } as Prisma.InputJsonValue,
          },
        });
        newItemIds.push(item.id);
      }

      const items = await tx.orderItem.findMany({ where: { orderId } });
      const subtotal = items.reduce((s, i) => s + Number(i.lineTotal), 0);
      const taxTotal = items.reduce((s, i) => s + Number(i.taxAmount), 0);
      await tx.order.update({
        where: { id: orderId },
        data: { subtotal, taxTotal, balanceDue: subtotal + taxTotal },
      });
      await tx.restaurantTable.update({
        where: { id: table.id },
        data: { status: DiningTableStatus.occupied, currentOrderId: orderId },
      });
      await this.createGuestKots(tx, {
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        orderId,
        tableId: table.id,
        itemIds: newItemIds,
      });
      const order = await tx.order.findFirstOrThrow({ where: { id: orderId } });
      return order;
    });

    return {
      orderId: created.id,
      orderNumber: created.orderNumber,
      table: ctx.name,
      postedInventory: false,
      payAtCounter: true,
    };
  }

  private async createGuestKots(
    tx: Prisma.TransactionClient,
    args: {
      tenantId: string;
      locationId: string;
      orderId: string;
      tableId: string;
      itemIds: string[];
    },
  ) {
    const pending = await tx.orderItem.findMany({
      where: { id: { in: args.itemIds } },
    });
    if (!pending.length) return;
    const stationsRaw = await tx.kitchenStation.findMany({
      where: { tenantId: args.tenantId, isActive: true },
    });
    const stations = stationsRaw.map((s) => ({
      id: s.id,
      categoryIds: parseStationKitchenSettings(s.meta).categoryIds,
    }));
    const productIds = [
      ...new Set(
        pending
          .map((i) => i.productId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const products = productIds.length
      ? await tx.product.findMany({
          where: { tenantId: args.tenantId, id: { in: productIds } },
          select: { id: true, categoryId: true },
        })
      : [];
    const categoryByProduct = new Map(
      products.map((p) => [p.id, p.categoryId]),
    );
    const groups = new Map<string | null, typeof pending>();
    for (const item of pending) {
      const stationId = routeItemToStationId(
        item.productId
          ? (categoryByProduct.get(item.productId) ?? null)
          : null,
        stations,
        stations[0]?.id ?? null,
      );
      const bucket = groups.get(stationId) ?? [];
      bucket.push(item);
      groups.set(stationId, bucket);
    }
    let kotSeq = await tx.kitchenTicket.count({
      where: { tenantId: args.tenantId },
    });
    for (const [stationId, items] of groups) {
      kotSeq += 1;
      const ticket = await tx.kitchenTicket.create({
        data: {
          tenantId: args.tenantId,
          locationId: args.locationId,
          orderId: args.orderId,
          tableId: args.tableId,
          stationId,
          kotNumber: `KOT-${String(kotSeq).padStart(5, '0')}`,
          diningMode: DiningMode.dine_in,
          status: KitchenTicketStatus.new,
          idempotencyKey: `qr:${args.orderId}:${items.map((i) => i.id).join(',')}`,
        },
      });
      for (const item of items) {
        const meta = (item.meta ?? {}) as Record<string, unknown>;
        await tx.kitchenTicketLine.create({
          data: {
            tenantId: args.tenantId,
            ticketId: ticket.id,
            orderItemId: item.id,
            name: item.description ?? 'Item',
            quantity: item.quantity,
            notes: typeof meta.note === 'string' ? meta.note : null,
            modifiers: Array.isArray(meta.modifiers) ? meta.modifiers : [],
            stationId,
          },
        });
      }
    }
    await tx.restaurantOrder.updateMany({
      where: { orderId: args.orderId, tenantId: args.tenantId },
      data: { kitchenPhase: 'kot_created' },
    });
    await tx.order.update({
      where: { id: args.orderId },
      data: { status: OrderStatus.confirmed },
    });
  }
}

function parseModifierGroups(meta: Record<string, unknown>): ModGroup[] {
  const raw = Array.isArray(meta.modifierGroups) ? meta.modifierGroups : [];
  const out: ModGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const row = g as Record<string, unknown>;
    const options = Array.isArray(row.options)
      ? row.options
          .map((o) => {
            if (!o || typeof o !== 'object') return null;
            const opt = o as Record<string, unknown>;
            if (typeof opt.name !== 'string') return null;
            return {
              id: String(opt.id ?? opt.name),
              name: opt.name,
              priceDelta: Number(opt.priceDelta ?? 0) || 0,
            };
          })
          .filter((x): x is NonNullable<typeof x> => Boolean(x))
      : [];
    out.push({
      id: String(row.id ?? row.name ?? 'group'),
      name: String(row.name ?? 'Add-ons'),
      minSelect: Number(row.minSelect ?? 0) || 0,
      maxSelect: Number(row.maxSelect ?? 0) || 0,
      required: row.required === true,
      options,
    });
  }
  return out.filter((g) => g.options.length);
}

function modifierDelta(groups: ModGroup[], names: string[]): number {
  const set = new Set(names);
  let extra = 0;
  for (const g of groups) {
    for (const o of g.options) {
      if (set.has(o.name)) extra += o.priceDelta;
    }
  }
  return extra;
}
