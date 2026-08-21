import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DiningMode,
  DiningTableStatus,
  KitchenTicketStatus,
  OrderKind,
  OrderStatus,
  Prisma,
  ResourceStatus,
  RestaurantOrderChannel,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/database.module';
import { assertLocationAccess } from '../../common/location-access';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import type { AuthUser } from '../auth/types';
import {
  canMergeTables,
  canOpenTable,
  canSeatReservation,
  canTransitionKot,
  kotAgingBand,
  kotPostsInventory,
  nextTokenNumber,
  normalizeConsumptionPolicy,
  normalizeDiningModes,
  shouldPostConsumption,
  type KotStatusCode,
} from './restaurant-policy';
import {
  CreateDiningTableDto,
  CreateFloorDto,
  CreateStationDto,
  MergeTablesDto,
  MoveTableDto,
  OpenDiningOrderDto,
  OpenTableDto,
  SendKotDto,
  SplitItemsDto,
  UpdateDiningTableDto,
  UpdateFloorDto,
  UpdateKotStatusDto,
  UpsertRestaurantConfigDto,
  CreateReservationDto,
  UpdateReservationDto,
} from './dto/restaurant.dto';

@Injectable()
export class RestaurantService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(user: AuthUser) {
    const existing = await this.prisma.restaurantConfig.findUnique({
      where: { tenantId: user.tenantId },
    });
    if (existing) return this.presentConfig(existing);
    return this.presentConfig({
      id: '',
      tenantId: user.tenantId,
      locationId: null,
      enabledDiningModes: ['dine_in', 'takeaway'],
      tableManagement: true,
      kotEnabled: true,
      kdsEnabled: false,
      captainOrdering: false,
      qrOrdering: false,
      onlineOrdering: false,
      recipesEnabled: false,
      reservationsEnabled: false,
      tokenManagement: false,
      consumptionPolicy: 'order_finalize',
      serviceChargePercent: null,
      packagingCharge: null,
      deliveryCharge: null,
      prepWarnMinutes: 10,
      prepCriticalMinutes: 20,
      otpOnQrOrder: false,
      meta: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async upsertConfig(user: AuthUser, dto: UpsertRestaurantConfigDto) {
    if (dto.locationId) {
      await assertLocationAccess(this.prisma, user, dto.locationId);
    }
    const warn = dto.prepWarnMinutes ?? 10;
    const critical = dto.prepCriticalMinutes ?? 20;
    if (critical < warn) {
      throw new BadRequestException(
        'Critical prep threshold must be >= warning threshold',
      );
    }
    const row = await this.prisma.restaurantConfig.upsert({
      where: { tenantId: user.tenantId },
      create: {
        tenantId: user.tenantId,
        locationId: dto.locationId,
        enabledDiningModes: normalizeDiningModes(dto.enabledDiningModes),
        tableManagement: dto.tableManagement ?? true,
        kotEnabled: dto.kotEnabled ?? true,
        kdsEnabled: dto.kdsEnabled ?? false,
        captainOrdering: dto.captainOrdering ?? false,
        qrOrdering: dto.qrOrdering ?? false,
        onlineOrdering: dto.onlineOrdering ?? false,
        recipesEnabled: dto.recipesEnabled ?? false,
        reservationsEnabled: dto.reservationsEnabled ?? false,
        tokenManagement: dto.tokenManagement ?? false,
        consumptionPolicy: normalizeConsumptionPolicy(dto.consumptionPolicy),
        serviceChargePercent: dto.serviceChargePercent,
        packagingCharge: dto.packagingCharge,
        deliveryCharge: dto.deliveryCharge,
        prepWarnMinutes: warn,
        prepCriticalMinutes: critical,
        otpOnQrOrder: dto.otpOnQrOrder ?? false,
      },
      update: {
        ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
        ...(dto.enabledDiningModes
          ? { enabledDiningModes: normalizeDiningModes(dto.enabledDiningModes) }
          : {}),
        ...(dto.tableManagement !== undefined
          ? { tableManagement: dto.tableManagement }
          : {}),
        ...(dto.kotEnabled !== undefined ? { kotEnabled: dto.kotEnabled } : {}),
        ...(dto.kdsEnabled !== undefined ? { kdsEnabled: dto.kdsEnabled } : {}),
        ...(dto.captainOrdering !== undefined
          ? { captainOrdering: dto.captainOrdering }
          : {}),
        ...(dto.qrOrdering !== undefined ? { qrOrdering: dto.qrOrdering } : {}),
        ...(dto.onlineOrdering !== undefined
          ? { onlineOrdering: dto.onlineOrdering }
          : {}),
        ...(dto.recipesEnabled !== undefined
          ? { recipesEnabled: dto.recipesEnabled }
          : {}),
        ...(dto.reservationsEnabled !== undefined
          ? { reservationsEnabled: dto.reservationsEnabled }
          : {}),
        ...(dto.tokenManagement !== undefined
          ? { tokenManagement: dto.tokenManagement }
          : {}),
        ...(dto.consumptionPolicy
          ? {
              consumptionPolicy: normalizeConsumptionPolicy(
                dto.consumptionPolicy,
              ),
            }
          : {}),
        ...(dto.serviceChargePercent !== undefined
          ? { serviceChargePercent: dto.serviceChargePercent }
          : {}),
        ...(dto.packagingCharge !== undefined
          ? { packagingCharge: dto.packagingCharge }
          : {}),
        ...(dto.deliveryCharge !== undefined
          ? { deliveryCharge: dto.deliveryCharge }
          : {}),
        ...(dto.prepWarnMinutes !== undefined
          ? { prepWarnMinutes: dto.prepWarnMinutes }
          : {}),
        ...(dto.prepCriticalMinutes !== undefined
          ? { prepCriticalMinutes: dto.prepCriticalMinutes }
          : {}),
        ...(dto.otpOnQrOrder !== undefined
          ? { otpOnQrOrder: dto.otpOnQrOrder }
          : {}),
      },
    });
    await this.audit(user, 'RestaurantConfig', row.id, 'upsert', {
      consumptionPolicy: row.consumptionPolicy,
    });
    return this.presentConfig(row);
  }

  async listFloors(user: AuthUser, locationId?: string) {
    if (locationId) await assertLocationAccess(this.prisma, user, locationId);
    const rows = await this.prisma.restaurantFloor.findMany({
      where: {
        tenantId: user.tenantId,
        ...(locationId ? { locationId } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { tables: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      locationId: r.locationId,
      name: r.name,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      tableCount: r._count.tables,
    }));
  }

  async createFloor(user: AuthUser, dto: CreateFloorDto) {
    await assertLocationAccess(this.prisma, user, dto.locationId);
    return this.prisma.restaurantFloor.create({
      data: {
        tenantId: user.tenantId,
        locationId: dto.locationId,
        name: dto.name.trim(),
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateFloor(user: AuthUser, id: string, dto: UpdateFloorDto) {
    const floor = await this.requireFloor(user, id);
    return this.prisma.restaurantFloor.update({
      where: { id: floor.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async listStations(user: AuthUser, locationId?: string) {
    return this.prisma.kitchenStation.findMany({
      where: {
        tenantId: user.tenantId,
        ...(locationId ? { locationId } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createStation(user: AuthUser, dto: CreateStationDto) {
    if (dto.locationId) {
      await assertLocationAccess(this.prisma, user, dto.locationId);
    }
    const code = dto.code.trim().toLowerCase().replace(/\s+/g, '_');
    const existing = await this.prisma.kitchenStation.findUnique({
      where: { tenantId_code: { tenantId: user.tenantId, code } },
    });
    if (existing) {
      return this.prisma.kitchenStation.update({
        where: { id: existing.id },
        data: {
          name: dto.name.trim(),
          ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          isActive: true,
        },
      });
    }
    try {
      return await this.prisma.kitchenStation.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          name: dto.name.trim(),
          code,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    } catch (error) {
      throwIfUnique(error, `Kitchen station “${code}” already exists`);
    }
  }

  async listTables(user: AuthUser, locationId?: string) {
    if (locationId) await assertLocationAccess(this.prisma, user, locationId);
    const rows = await this.prisma.restaurantTable.findMany({
      where: {
        tenantId: user.tenantId,
        ...(locationId ? { locationId } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        floor: { select: { id: true, name: true } },
        currentOrder: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            customerId: true,
            restaurantExt: {
              select: {
                diningMode: true,
                covers: true,
                guestName: true,
              },
            },
          },
        },
      },
    });
    return rows.map((t) => ({
      id: t.id,
      locationId: t.locationId,
      floorId: t.floorId,
      floorName: t.floor?.name ?? null,
      resourceId: t.resourceId,
      name: t.name,
      capacity: t.capacity,
      status: t.status,
      currentOrderId: t.currentOrderId,
      orderNumber: t.currentOrder?.orderNumber ?? null,
      diningMode: t.currentOrder?.restaurantExt?.diningMode ?? null,
      covers: t.currentOrder?.restaurantExt?.covers ?? null,
      guestName: t.currentOrder?.restaurantExt?.guestName ?? null,
      qrToken: t.qrToken,
      sortOrder: t.sortOrder,
    }));
  }

  async createTable(user: AuthUser, dto: CreateDiningTableDto) {
    await assertLocationAccess(this.prisma, user, dto.locationId);
    if (dto.floorId) await this.requireFloor(user, dto.floorId);
    return this.prisma.$transaction(async (tx) => {
      const resource = await tx.resource.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          name: dto.name.trim(),
          type: 'table',
          capacity: dto.capacity ?? 2,
          status: ResourceStatus.available,
          sortOrder: dto.sortOrder ?? 0,
          meta: { diningTable: true },
        },
      });
      return tx.restaurantTable.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          floorId: dto.floorId,
          resourceId: resource.id,
          name: dto.name.trim(),
          capacity: dto.capacity ?? 2,
          sortOrder: dto.sortOrder ?? 0,
          qrToken: randomUUID(),
        },
      });
    });
  }

  async updateTable(user: AuthUser, id: string, dto: UpdateDiningTableDto) {
    const table = await this.requireTable(user, id);
    if (dto.status === DiningTableStatus.available && table.currentOrderId) {
      throw new BadRequestException(
        'Free the table by billing or transferring the order first',
      );
    }
    const updated = await this.prisma.restaurantTable.update({
      where: { id: table.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.floorId !== undefined ? { floorId: dto.floorId } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
    await this.prisma.resource.update({
      where: { id: table.resourceId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        ...(dto.status === DiningTableStatus.available
          ? { status: ResourceStatus.available }
          : dto.status === DiningTableStatus.occupied ||
              dto.status === DiningTableStatus.reserved
            ? { status: ResourceStatus.occupied }
            : dto.status === DiningTableStatus.blocked
              ? { status: ResourceStatus.inactive }
              : dto.status === DiningTableStatus.cleaning
                ? { status: ResourceStatus.maintenance }
                : {}),
      },
    });
    return updated;
  }

  async openTable(user: AuthUser, tableId: string, dto: OpenTableDto) {
    const table = await this.requireTable(user, tableId);
    if (!canOpenTable(table.status)) {
      throw new BadRequestException(
        `Table ${table.name} is ${table.status} — cannot open`,
      );
    }
    if (table.currentOrderId) {
      throw new BadRequestException('Table already has an open order');
    }
    return this.openDiningOrder(user, {
      locationId: table.locationId,
      diningMode: DiningMode.dine_in,
      tableId: table.id,
      customerId: dto.customerId,
      covers: dto.covers ?? 1,
      guestName: dto.guestName,
      channel: RestaurantOrderChannel.pos,
    });
  }

  async openDiningOrder(user: AuthUser, dto: OpenDiningOrderDto) {
    await assertLocationAccess(this.prisma, user, dto.locationId);
    const cfg = await this.getConfig(user);
    const modes = normalizeDiningModes(cfg.enabledDiningModes);
    if (!modes.includes(dto.diningMode)) {
      throw new BadRequestException(
        `Dining mode ${dto.diningMode} is not enabled`,
      );
    }
    if (
      dto.diningMode === DiningMode.dine_in &&
      !dto.tableId &&
      cfg.tableManagement &&
      !dto.skipTableRequirement
    ) {
      throw new BadRequestException('Pick a table for dine-in');
    }
    let table: Awaited<ReturnType<typeof this.requireTable>> | null = null;
    if (dto.tableId) {
      table = await this.requireTable(user, dto.tableId);
      if (table.locationId !== dto.locationId) {
        throw new BadRequestException('Table is on another location');
      }
      if (table.currentOrderId) {
        throw new BadRequestException('Table already has an open order');
      }
    }

    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { currencyCode: true },
    });
    const orderNumber = await this.nextOrderNumber(user.tenantId);
    let tokenNumber: number | null = null;
    if (cfg.tokenManagement && dto.diningMode !== DiningMode.dine_in) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const last = await this.prisma.restaurantOrder.aggregate({
        where: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          createdAt: { gte: start },
          tokenNumber: { not: null },
        },
        _max: { tokenNumber: true },
      });
      tokenNumber = nextTokenNumber(last._max.tokenNumber);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          customerId: dto.customerId,
          orderNumber,
          kind: OrderKind.sale,
          status: OrderStatus.draft,
          createdById: user.userId,
          currencyCode: tenant.currencyCode,
          meta: {
            parked: true,
            parkedAt: new Date().toISOString(),
            orderType: dto.diningMode,
            tableId: dto.tableId ?? null,
            covers: dto.covers ?? 1,
            note: dto.note ?? null,
            channel: dto.channel ?? 'pos',
          },
        },
      });
      const ext = await tx.restaurantOrder.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          orderId: order.id,
          tableId: dto.tableId,
          diningMode: dto.diningMode,
          channel: dto.channel ?? RestaurantOrderChannel.pos,
          covers: dto.covers ?? 1,
          guestName: dto.guestName,
          tokenNumber,
          kitchenPhase: 'draft',
          consumptionPosted: false,
        },
      });
      if (table) {
        await tx.restaurantTable.update({
          where: { id: table.id },
          data: {
            status: DiningTableStatus.occupied,
            currentOrderId: order.id,
          },
        });
        await tx.resource.update({
          where: { id: table.resourceId },
          data: { status: ResourceStatus.occupied },
        });
      }
      return { order, ext };
    });

    await this.audit(user, 'RestaurantOrder', created.ext.id, 'open', {
      orderId: created.order.id,
      tableId: dto.tableId ?? null,
      diningMode: dto.diningMode,
    });
    return this.getDiningOrder(user, created.order.id);
  }

  async getDiningOrder(user: AuthUser, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      include: {
        items: true,
        customer: { select: { id: true, fullName: true, phone: true } },
        restaurantExt: true,
        kitchenTickets: {
          where: { status: { not: KitchenTicketStatus.cancelled } },
          select: { id: true, kotNumber: true, status: true },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      locationId: order.locationId,
      customer: order.customer,
      items: order.items.map((i) => ({
        id: i.id,
        description: i.description,
        quantity: Number(i.quantity),
        unitPrice: Number(i.unitPrice),
        lineTotal: Number(i.lineTotal),
        productId: i.productId,
        meta: i.meta,
      })),
      restaurant: order.restaurantExt,
      kots: order.kitchenTickets,
      totals: {
        subtotal: Number(order.subtotal),
        taxTotal: Number(order.taxTotal),
        discountTotal: Number(order.discountTotal),
        balanceDue: Number(order.balanceDue),
      },
    };
  }

  async moveTable(user: AuthUser, fromTableId: string, dto: MoveTableDto) {
    const from = await this.requireTable(user, fromTableId);
    const to = await this.requireTable(user, dto.toTableId);
    if (!from.currentOrderId) {
      throw new BadRequestException('Source table has no open order');
    }
    if (to.currentOrderId && to.currentOrderId !== from.currentOrderId) {
      throw new BadRequestException(
        'Target table already has a different order — merge instead',
      );
    }
    if (to.status === DiningTableStatus.blocked) {
      throw new BadRequestException('Target table is blocked');
    }
    const orderId = from.currentOrderId;
    await this.prisma.$transaction(async (tx) => {
      await tx.restaurantTable.update({
        where: { id: from.id },
        data: { status: DiningTableStatus.cleaning, currentOrderId: null },
      });
      await tx.resource.update({
        where: { id: from.resourceId },
        data: { status: ResourceStatus.maintenance },
      });
      await tx.restaurantTable.update({
        where: { id: to.id },
        data: { status: DiningTableStatus.occupied, currentOrderId: orderId },
      });
      await tx.resource.update({
        where: { id: to.resourceId },
        data: { status: ResourceStatus.occupied },
      });
      await tx.restaurantOrder.updateMany({
        where: { orderId, tenantId: user.tenantId },
        data: { tableId: to.id },
      });
      const order = await tx.order.findFirst({ where: { id: orderId } });
      const meta = (order?.meta ?? {}) as Record<string, unknown>;
      await tx.order.update({
        where: { id: orderId },
        data: { meta: { ...meta, tableId: to.id } },
      });
    });
    await this.audit(user, 'RestaurantTable', from.id, 'move', {
      fromTableId: from.id,
      toTableId: to.id,
      orderId,
    });
    return this.getDiningOrder(user, orderId);
  }

  async mergeTables(user: AuthUser, dto: MergeTablesDto) {
    const source = await this.requireTable(user, dto.sourceTableId);
    const target = await this.requireTable(user, dto.targetTableId);
    const check = canMergeTables({
      sourceStatus: source.status,
      targetStatus: target.status,
      sourceOrderId: source.currentOrderId,
      targetOrderId: target.currentOrderId,
    });
    if (!check.ok) throw new BadRequestException(check.reason);

    const sourceOrderId = source.currentOrderId!;
    let keepOrderId = target.currentOrderId ?? sourceOrderId;

    await this.prisma.$transaction(async (tx) => {
      if (target.currentOrderId && target.currentOrderId !== sourceOrderId) {
        const items = await tx.orderItem.findMany({
          where: { orderId: sourceOrderId, tenantId: user.tenantId },
        });
        for (const item of items) {
          await tx.orderItem.update({
            where: { id: item.id },
            data: { orderId: keepOrderId },
          });
        }
        await tx.kitchenTicket.updateMany({
          where: { orderId: sourceOrderId, tenantId: user.tenantId },
          data: { orderId: keepOrderId, tableId: target.id },
        });
        const srcExt = await tx.restaurantOrder.findUnique({
          where: { orderId: sourceOrderId },
        });
        const tgtExt = await tx.restaurantOrder.findUnique({
          where: { orderId: keepOrderId },
        });
        const merged = [
          ...(((tgtExt?.mergedFromTableIds as string[]) ?? []) || []),
          source.id,
        ];
        if (tgtExt) {
          await tx.restaurantOrder.update({
            where: { id: tgtExt.id },
            data: {
              mergedFromTableIds: merged,
              covers: (tgtExt.covers ?? 0) + (srcExt?.covers ?? 0),
            },
          });
        }
        await tx.restaurantOrder.deleteMany({
          where: { orderId: sourceOrderId, tenantId: user.tenantId },
        });
        const srcOrder = await tx.order.findFirst({
          where: { id: sourceOrderId, tenantId: user.tenantId },
        });
        const srcMeta = (srcOrder?.meta ?? {}) as Record<string, unknown>;
        await tx.order.update({
          where: { id: sourceOrderId },
          data: {
            status: OrderStatus.cancelled,
            meta: {
              ...srcMeta,
              parked: false,
              mergedIntoOrderId: keepOrderId,
              cancelledReason: 'merged_table',
            },
          },
        });
        await this.recomputeOrderTotals(tx, keepOrderId);
      } else {
        keepOrderId = sourceOrderId;
        await tx.restaurantOrder.updateMany({
          where: { orderId: keepOrderId, tenantId: user.tenantId },
          data: { tableId: target.id },
        });
      }

      await tx.restaurantTable.update({
        where: { id: source.id },
        data: { status: DiningTableStatus.cleaning, currentOrderId: null },
      });
      await tx.resource.update({
        where: { id: source.resourceId },
        data: { status: ResourceStatus.maintenance },
      });
      await tx.restaurantTable.update({
        where: { id: target.id },
        data: { status: DiningTableStatus.occupied, currentOrderId: keepOrderId },
      });
      await tx.resource.update({
        where: { id: target.resourceId },
        data: { status: ResourceStatus.occupied },
      });
    });

    await this.audit(user, 'RestaurantTable', target.id, 'merge', {
      sourceTableId: source.id,
      targetTableId: target.id,
      orderId: keepOrderId,
    });
    return this.getDiningOrder(user, keepOrderId);
  }

  async splitItems(user: AuthUser, fromOrderId: string, dto: SplitItemsDto) {
    const from = await this.getDiningOrder(user, fromOrderId);
    if (!from.restaurant) {
      throw new BadRequestException('Not a dining order');
    }
    const itemSet = new Set(from.items.map((i) => i.id));
    if (dto.orderItemIds.some((id) => !itemSet.has(id))) {
      throw new BadRequestException('Item does not belong to this order');
    }
    if (dto.orderItemIds.length >= from.items.length) {
      throw new BadRequestException('Keep at least one item on the original bill');
    }

    const opened = await this.openDiningOrder(user, {
      locationId: from.locationId,
      diningMode: from.restaurant.diningMode,
      tableId: dto.toTableId ?? undefined,
      channel: RestaurantOrderChannel.pos,
      covers: 1,
      skipTableRequirement: !dto.toTableId,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.updateMany({
        where: {
          id: { in: dto.orderItemIds },
          tenantId: user.tenantId,
          orderId: fromOrderId,
        },
        data: { orderId: opened.id },
      });
      await tx.restaurantOrder.updateMany({
        where: { orderId: opened.id, tenantId: user.tenantId },
        data: { parentOrderId: fromOrderId },
      });
      await this.recomputeOrderTotals(tx, fromOrderId);
      await this.recomputeOrderTotals(tx, opened.id);
    });

    await this.audit(user, 'RestaurantOrder', opened.id, 'split', {
      fromOrderId,
      itemIds: dto.orderItemIds,
    });
    return {
      original: await this.getDiningOrder(user, fromOrderId),
      split: await this.getDiningOrder(user, opened.id),
    };
  }

  async sendKot(user: AuthUser, orderId: string, dto: SendKotDto) {
    if (kotPostsInventory()) {
      throw new BadRequestException('Invalid consumption policy');
    }
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId },
      include: { items: true, restaurantExt: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.restaurantExt) {
      throw new BadRequestException('Open a dining order before sending KOT');
    }
    if (!order.items.length) {
      throw new BadRequestException('Add items before sending KOT');
    }

    const already = await this.prisma.kitchenTicketLine.findMany({
      where: {
        tenantId: user.tenantId,
        orderItemId: { in: order.items.map((i) => i.id) },
        ticket: { status: { not: KitchenTicketStatus.cancelled } },
      },
      select: { orderItemId: true },
    });
    const ticketed = new Set(already.map((l) => l.orderItemId));
    const pending = order.items.filter((i) => !ticketed.has(i.id));
    if (!pending.length) {
      throw new BadRequestException('All items already have an active KOT');
    }

    const key = dto.idempotencyKey?.trim() || `kot:${orderId}:${pending.map((i) => i.id).sort().join(',')}`;
    const existing = await this.prisma.kitchenTicket.findFirst({
      where: { tenantId: user.tenantId, idempotencyKey: key },
    });
    if (existing) return this.presentKot(existing.id, user);

    const kotNumber = await this.nextKotNumber(user.tenantId);
    const ticket = await this.prisma.$transaction(async (tx) => {
      const created = await tx.kitchenTicket.create({
        data: {
          tenantId: user.tenantId,
          locationId: order.locationId,
          orderId: order.id,
          tableId: order.restaurantExt?.tableId,
          stationId: dto.stationId,
          kotNumber,
          diningMode: order.restaurantExt!.diningMode,
          status: KitchenTicketStatus.new,
          priority: dto.priority ?? 0,
          specialInstructions: dto.specialInstructions,
          createdById: user.userId,
          idempotencyKey: key,
        },
      });
      for (const item of pending) {
        const meta = (item.meta ?? {}) as Record<string, unknown>;
        await tx.kitchenTicketLine.create({
          data: {
            tenantId: user.tenantId,
            ticketId: created.id,
            orderItemId: item.id,
            name: item.description ?? 'Item',
            quantity: item.quantity,
            notes: typeof meta.note === 'string' ? meta.note : null,
            modifiers: Array.isArray(meta.modifiers) ? meta.modifiers : [],
            stationId: dto.stationId,
          },
        });
      }
      await tx.restaurantOrder.update({
        where: { id: order.restaurantExt!.id },
        data: { kitchenPhase: 'kot_created' },
      });
      if (order.status === OrderStatus.draft) {
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.confirmed },
        });
      }
      return created;
    });

    await this.audit(user, 'KitchenTicket', ticket.id, 'create', {
      orderId,
      kotNumber,
      inventoryPosted: false,
    });
    return this.presentKot(ticket.id, user);
  }

  async listKots(
    user: AuthUser,
    query: { locationId?: string; status?: KitchenTicketStatus; stationId?: string },
  ) {
    if (query.locationId) {
      await assertLocationAccess(this.prisma, user, query.locationId);
    }
    const cfg = await this.getConfig(user);
    const rows = await this.prisma.kitchenTicket.findMany({
      where: {
        tenantId: user.tenantId,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.stationId ? { stationId: query.stationId } : {}),
      },
      orderBy: [{ createdAt: 'asc' }],
      include: {
        lines: true,
        table: { select: { id: true, name: true } },
        order: { select: { orderNumber: true, customerId: true } },
        station: { select: { id: true, name: true } },
      },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      kotNumber: row.kotNumber,
      orderId: row.orderId,
      orderNumber: row.order.orderNumber,
      tableId: row.tableId,
      tableName: row.table?.name ?? null,
      diningMode: row.diningMode,
      stationId: row.stationId,
      stationName: row.station?.name ?? null,
      status: row.status,
      priority: row.priority,
      specialInstructions: row.specialInstructions,
      createdAt: row.createdAt,
      aging: kotAgingBand({
        createdAt: row.createdAt,
        warnMinutes: cfg.prepWarnMinutes,
        criticalMinutes: cfg.prepCriticalMinutes,
      }),
      lines: row.lines.map((l) => ({
        id: l.id,
        name: l.name,
        quantity: Number(l.quantity),
        notes: l.notes,
        modifiers: l.modifiers,
        status: l.status,
      })),
    }));
  }

  async updateKotStatus(user: AuthUser, id: string, dto: UpdateKotStatusDto) {
    const ticket = await this.prisma.kitchenTicket.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!ticket) throw new NotFoundException('KOT not found');
    if (
      !canTransitionKot(
        ticket.status as KotStatusCode,
        dto.status as KotStatusCode,
      )
    ) {
      throw new BadRequestException(
        `Cannot change KOT from ${ticket.status} to ${dto.status}`,
      );
    }
    if (dto.status === KitchenTicketStatus.cancelled && !dto.cancelReason?.trim()) {
      throw new BadRequestException('Cancel reason is required');
    }
    const now = new Date();
    const updated = await this.prisma.kitchenTicket.update({
      where: { id: ticket.id },
      data: {
        status: dto.status,
        ...(dto.status === KitchenTicketStatus.accepted ? { acceptedAt: now } : {}),
        ...(dto.status === KitchenTicketStatus.preparing
          ? { preparingAt: now, recalledAt: ticket.status === 'ready' || ticket.status === 'served' ? now : ticket.recalledAt }
          : {}),
        ...(dto.status === KitchenTicketStatus.ready ? { readyAt: now } : {}),
        ...(dto.status === KitchenTicketStatus.served ? { servedAt: now } : {}),
        ...(dto.status === KitchenTicketStatus.cancelled
          ? {
              cancelledAt: now,
              cancelReason: dto.cancelReason?.trim(),
              cancelledById: user.userId,
            }
          : {}),
      },
    });
    await this.prisma.kitchenTicketLine.updateMany({
      where: { ticketId: ticket.id, tenantId: user.tenantId },
      data: { status: dto.status },
    });
    await this.audit(user, 'KitchenTicket', ticket.id, 'status', {
      from: ticket.status,
      to: dto.status,
      cancelReason: dto.cancelReason ?? null,
    });
    return this.presentKot(updated.id, user);
  }

  /**
   * Called from POS checkout after a successful sale close.
   * No-op for retail / rental / service. Never deducts a second time.
   */
  async onOrderFinalized(opts: {
    tenantId: string;
    orderId: string;
    actorUserId?: string;
  }) {
    const ext = await this.prisma.restaurantOrder.findUnique({
      where: { orderId: opts.orderId },
    });
    if (!ext || ext.tenantId !== opts.tenantId) return;
    const policy = normalizeConsumptionPolicy(
      (await this.prisma.restaurantConfig.findUnique({
        where: { tenantId: opts.tenantId },
        select: { consumptionPolicy: true },
      }))?.consumptionPolicy,
    );
    const post = shouldPostConsumption({
      policy,
      event: 'order_finalize',
      alreadyPosted: ext.consumptionPosted,
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.restaurantOrder.update({
        where: { id: ext.id },
        data: {
          billedAt: new Date(),
          kitchenPhase: 'billed',
          consumptionPosted: ext.consumptionPosted || post,
        },
      });
      const tables = await tx.restaurantTable.findMany({
        where: { tenantId: opts.tenantId, currentOrderId: opts.orderId },
        select: { id: true, resourceId: true },
      });
      await tx.restaurantTable.updateMany({
        where: {
          tenantId: opts.tenantId,
          currentOrderId: opts.orderId,
        },
        data: { status: DiningTableStatus.cleaning, currentOrderId: null },
      });
      if (tables.length) {
        await tx.resource.updateMany({
          where: { id: { in: tables.map((t) => t.resourceId) } },
          data: { status: ResourceStatus.maintenance },
        });
      }
    });
  }

  private async presentKot(id: string, user: AuthUser) {
    const rows = await this.listKots(user, {});
    const found = rows.find((r) => r.id === id);
    if (!found) throw new NotFoundException('KOT not found');
    return found;
  }

  private async requireFloor(user: AuthUser, id: string) {
    const row = await this.prisma.restaurantFloor.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Floor not found');
    return row;
  }

  private async requireTable(user: AuthUser, id: string) {
    const row = await this.prisma.restaurantTable.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Table not found');
    await assertLocationAccess(this.prisma, user, row.locationId);
    return row;
  }

  private async nextOrderNumber(tenantId: string) {
    const count = await this.prisma.order.count({ where: { tenantId } });
    return `ORD-${String(count + 1).padStart(5, '0')}`;
  }

  private async nextKotNumber(tenantId: string) {
    const count = await this.prisma.kitchenTicket.count({ where: { tenantId } });
    return `KOT-${String(count + 1).padStart(5, '0')}`;
  }

  private async recomputeOrderTotals(
    tx: Prisma.TransactionClient,
    orderId: string,
  ) {
    const items = await tx.orderItem.findMany({ where: { orderId } });
    const subtotal = items.reduce((s, i) => s + Number(i.lineTotal), 0);
    const taxTotal = items.reduce((s, i) => s + Number(i.taxAmount), 0);
    await tx.order.update({
      where: { id: orderId },
      data: {
        subtotal,
        taxTotal,
        balanceDue: subtotal + taxTotal,
      },
    });
  }

  private presentConfig(row: {
    id: string;
    tenantId: string;
    locationId: string | null;
    enabledDiningModes: Prisma.JsonValue;
    tableManagement: boolean;
    kotEnabled: boolean;
    kdsEnabled: boolean;
    captainOrdering: boolean;
    qrOrdering: boolean;
    onlineOrdering: boolean;
    recipesEnabled: boolean;
    reservationsEnabled: boolean;
    tokenManagement: boolean;
    consumptionPolicy: string;
    serviceChargePercent: Prisma.Decimal | number | null;
    packagingCharge: Prisma.Decimal | number | null;
    deliveryCharge: Prisma.Decimal | number | null;
    prepWarnMinutes: number;
    prepCriticalMinutes: number;
    otpOnQrOrder: boolean;
    meta: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id || null,
      tenantId: row.tenantId,
      locationId: row.locationId,
      enabledDiningModes: normalizeDiningModes(row.enabledDiningModes),
      tableManagement: row.tableManagement,
      kotEnabled: row.kotEnabled,
      kdsEnabled: row.kdsEnabled,
      captainOrdering: row.captainOrdering,
      qrOrdering: row.qrOrdering,
      onlineOrdering: row.onlineOrdering,
      recipesEnabled: row.recipesEnabled,
      reservationsEnabled: row.reservationsEnabled,
      tokenManagement: row.tokenManagement,
      consumptionPolicy: normalizeConsumptionPolicy(row.consumptionPolicy),
      serviceChargePercent:
        row.serviceChargePercent != null
          ? Number(row.serviceChargePercent)
          : null,
      packagingCharge:
        row.packagingCharge != null ? Number(row.packagingCharge) : null,
      deliveryCharge:
        row.deliveryCharge != null ? Number(row.deliveryCharge) : null,
      prepWarnMinutes: row.prepWarnMinutes,
      prepCriticalMinutes: row.prepCriticalMinutes,
      otpOnQrOrder: row.otpOnQrOrder,
      inventoryNote:
        'KOT never deducts stock. Consumption posts once at checkout (order_finalize).',
    };
  }

  async listTokens(user: AuthUser, locationId?: string) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const rows = await this.prisma.restaurantOrder.findMany({
      where: {
        tenantId: user.tenantId,
        tokenNumber: { not: null },
        createdAt: { gte: start },
        ...(locationId ? { locationId } : {}),
        order: { status: { in: [OrderStatus.draft, OrderStatus.confirmed] } },
      },
      include: {
        order: { select: { id: true, orderNumber: true, status: true } },
        table: { select: { name: true } },
      },
      orderBy: { tokenNumber: 'asc' },
      take: 200,
    });
    return rows.map((r) => ({
      orderId: r.orderId,
      orderNumber: r.order.orderNumber,
      tokenNumber: r.tokenNumber,
      diningMode: r.diningMode,
      tableName: r.table?.name ?? null,
      guestName: r.guestName,
      status: r.order.status,
    }));
  }

  async listReservations(user: AuthUser, locationId?: string) {
    return this.prisma.diningReservation.findMany({
      where: {
        tenantId: user.tenantId,
        ...(locationId ? { locationId } : {}),
        status: { not: 'cancelled' },
      },
      include: { table: { select: { id: true, name: true } } },
      orderBy: { startAt: 'asc' },
      take: 200,
    });
  }

  async createReservation(user: AuthUser, dto: CreateReservationDto) {
    await assertLocationAccess(this.prisma, user, dto.locationId);
    const startAt = new Date(dto.startAt);
    if (Number.isNaN(startAt.getTime())) {
      throw new BadRequestException('Invalid reservation time');
    }
    if (dto.tableId) {
      const table = await this.requireTable(user, dto.tableId);
      if (table.locationId !== dto.locationId) {
        throw new BadRequestException('Table is on another location');
      }
    }
    const row = await this.prisma.diningReservation.create({
      data: {
        tenantId: user.tenantId,
        locationId: dto.locationId,
        tableId: dto.tableId ?? null,
        guestName: dto.guestName.trim(),
        guestPhone: dto.guestPhone?.trim() || null,
        covers: dto.covers ?? 2,
        startAt,
        notes: dto.notes?.trim() || null,
      },
    });
    if (dto.tableId) {
      await this.prisma.restaurantTable.updateMany({
        where: {
          id: dto.tableId,
          tenantId: user.tenantId,
          status: DiningTableStatus.available,
        },
        data: { status: DiningTableStatus.reserved },
      });
    }
    return row;
  }

  async updateReservation(
    user: AuthUser,
    id: string,
    dto: UpdateReservationDto,
  ) {
    const row = await this.prisma.diningReservation.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!row) throw new NotFoundException('Reservation not found');
    if (dto.status === 'seated' && !canSeatReservation(row.status)) {
      throw new BadRequestException('Only booked reservations can be seated');
    }
    const next = await this.prisma.diningReservation.update({
      where: { id },
      data: { status: dto.status ?? row.status },
    });
    if (dto.status === 'cancelled' && row.tableId) {
      await this.prisma.restaurantTable.updateMany({
        where: {
          id: row.tableId,
          tenantId: user.tenantId,
          status: DiningTableStatus.reserved,
          currentOrderId: null,
        },
        data: { status: DiningTableStatus.available },
      });
    }
    return next;
  }

  private async audit(
    user: AuthUser,
    entityType: string,
    entityId: string,
    action: string,
    beforeAfter: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType,
        entityId,
        action,
        beforeAfter: beforeAfter as Prisma.InputJsonValue,
      },
    });
  }
}
