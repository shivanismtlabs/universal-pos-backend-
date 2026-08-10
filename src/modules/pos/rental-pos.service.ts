import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FulfillmentMode,
  OrderKind,
  PaymentType,
  Prisma,
  RentalOrderLifecycle,
  ReservationStatus,
  StockUnitStatus,
} from '@prisma/client';
import { saveProductImage } from '../../common/product-image';
import {
  COMMERCE_SCHEMAS,
  RENTAL_PRODUCT_FIELDS,
  parseCommerceModes,
} from '../../common/commerce-schema';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import {
  AddRentalProductDto,
  AddRentalUnitDto,
  AddSaleCategoryDto,
  RenameSaleCategoryDto,
  ExtendRentalDto,
  RentalExchangeDto,
  UpdateRentalProductDto,
  UpdateRentalUnitDto,
  UploadSaleImageDto,
} from './dto/pos.dto';

function metaPrice(meta: unknown): number | null {
  if (!meta || typeof meta !== 'object') return null;
  const n = Number((meta as Record<string, unknown>).rentalPrice);
  return Number.isFinite(n) ? n : null;
}

function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

@Injectable()
export class RentalPosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly paymentsService: PaymentsService,
  ) {}

  rentalSchema() {
    return {
      mode: 'rental' as const,
      label: COMMERCE_SCHEMAS.rental.label,
      description: COMMERCE_SCHEMAS.rental.description,
      fields: COMMERCE_SCHEMAS.rental.fields,
      categoryExamples: [...COMMERCE_SCHEMAS.rental.categoryExamples],
      lifecycle: [...(COMMERCE_SCHEMAS.rental.lifecycle ?? [])],
      ops: ['rent', 'return', 'exchange', 'inspect', 'cleaning'] as const,
    };
  }

  async rentalFloor(user: AuthUser, locationId?: string) {
    await this.assertRentalShop(user.tenantId);
    const locId = locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locId) throw new BadRequestException('No location configured');

    const [categories, products, units, openOut, available] = await Promise.all([
      this.prisma.category.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.product.count({
        where: {
          tenantId: user.tenantId,
          fulfillmentMode: FulfillmentMode.rental,
        },
      }),
      this.prisma.stockUnit.count({
        where: { tenantId: user.tenantId, locationId: locId },
      }),
      this.prisma.stockUnit.count({
        where: {
          tenantId: user.tenantId,
          locationId: locId,
          status: StockUnitStatus.checked_out,
        },
      }),
      this.prisma.stockUnit.count({
        where: {
          tenantId: user.tenantId,
          locationId: locId,
          status: StockUnitStatus.available,
        },
      }),
    ]);

    const recentUnits = await this.prisma.stockUnit.findMany({
      where: { tenantId: user.tenantId, locationId: locId },
      orderBy: { createdAt: 'desc' },
      take: 40,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            basePrice: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    return {
      schema: this.rentalSchema(),
      locationId: locId,
      counts: {
        categories: categories.length,
        products,
        units,
        available,
        checkedOut: openOut,
      },
      categories,
      units: recentUnits.map((u) => this.mapUnit(u)),
    };
  }

  async listRentalCategories(user: AuthUser) {
    await this.assertRentalShop(user.tenantId);
    const rows = await this.prisma.category.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        // Only rental-mode products (sale catalog may share category names)
        _count: {
          select: {
            products: {
              where: { fulfillmentMode: FulfillmentMode.rental },
            },
          },
        },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      productCount: c._count.products,
    }));
  }

  async addRentalCategory(user: AuthUser, dto: AddSaleCategoryDto) {
    await this.assertRentalShop(user.tenantId);
    try {
      return await this.prisma.category.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name.trim(),
        },
        select: { id: true, name: true },
      });
    } catch (error) {
      throwIfUnique(error, 'Category name already exists');
    }
  }

  async renameRentalCategory(
    user: AuthUser,
    id: string,
    dto: RenameSaleCategoryDto,
  ) {
    await this.assertRentalShop(user.tenantId);
    const exists = await this.prisma.category.findFirst({
      where: { id, tenantId: user.tenantId },
    });
    if (!exists) throw new NotFoundException('Category not found');
    try {
      return await this.prisma.category.update({
        where: { id },
        data: { name: dto.name.trim() },
        select: { id: true, name: true },
      });
    } catch (error) {
      throwIfUnique(error, 'Category name already exists');
      throw error;
    }
  }

  /** Product + first unit */
  async addRentalProduct(user: AuthUser, dto: AddRentalProductDto) {
    await this.assertRentalShop(user.tenantId);
    const locationId =
      dto.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const cat = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, tenantId: user.tenantId },
    });
    if (!cat) throw new NotFoundException('Category not found');

    const variant = (dto.variant ?? dto.size)?.trim() || null;

    try {
      const product = await this.prisma.product.create({
        data: {
          tenantId: user.tenantId,
          categoryId: dto.categoryId,
          name: dto.title.trim(),
          skuCode: dto.sku.trim().toUpperCase(),
          description: dto.description?.trim() || null,
          kind: 'physical',
          fulfillmentMode: FulfillmentMode.rental,
          trackQty: false,
          trackSerial: true,
          basePrice: Number(dto.rentalPrice),
        },
      });
      const unit = await this.prisma.stockUnit.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          productId: product.id,
          barcodeSku: dto.barcode.trim().toUpperCase(),
          variantLabel: variant,
          condition: 'good',
          status: StockUnitStatus.available,
          ownership: 'own',
          depositAmount: Number(dto.deposit ?? 0).toFixed(2),
          meta: { rentalPrice: Number(dto.rentalPrice) },
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              skuCode: true,
              basePrice: true,
              photoUrl: true,
            category: { select: { id: true, name: true } },
            },
          },
        },
      });
      return {
        mode: 'rental' as const,
        fieldsUsed: RENTAL_PRODUCT_FIELDS.map((f) => f.key),
        product: {
          id: product.id,
          title: product.name,
          sku: product.skuCode,
          category: cat,
        },
        unit: this.mapUnit(unit),
      };
    } catch (error) {
      throwIfUnique(error, 'SKU or barcode already exists for this shop');
    }
  }

  async addRentalUnit(user: AuthUser, dto: AddRentalUnitDto) {
    await this.assertRentalShop(user.tenantId);
    const product = await this.prisma.product.findFirst({
      where: {
        id: dto.productId,
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.rental,
      },
    });
    if (!product) throw new NotFoundException('Rental product not found');

    const locationId =
      dto.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const rentalPrice =
      dto.rentalPrice !== undefined
        ? Number(dto.rentalPrice)
        : Number(product.basePrice);
    const variant = (dto.variant ?? dto.size)?.trim() || null;

    try {
      const unit = await this.prisma.stockUnit.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          productId: product.id,
          barcodeSku: dto.barcode.trim().toUpperCase(),
          variantLabel: variant,
          condition: 'good',
          status: StockUnitStatus.available,
          ownership: 'own',
          depositAmount: Number(dto.deposit ?? 0).toFixed(2),
          meta: { rentalPrice },
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              skuCode: true,
              basePrice: true,
              photoUrl: true,
            category: { select: { id: true, name: true } },
            },
          },
        },
      });
      return this.mapUnit(unit);
    } catch (error) {
      throwIfUnique(error, 'Barcode already exists for this shop');
    }
  }

  async listRentalProducts(
    user: AuthUser,
    opts: { q?: string; categoryId?: string } = {},
  ) {
    await this.assertRentalShop(user.tenantId);
    const q = opts.q?.trim();
    const rows = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.rental,
        ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { skuCode: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { stockUnits: true } },
        stockUnits: {
          take: 1,
          orderBy: { createdAt: 'asc' },
          select: { depositAmount: true, meta: true },
        },
      },
    });

    return {
      fields: RENTAL_PRODUCT_FIELDS,
      items: rows.map((p) => {
        const first = p.stockUnits[0];
        return {
          id: p.id,
          title: p.name,
          sku: p.skuCode,
          description: p.description,
          rentalPrice: p.basePrice,
          deposit: first?.depositAmount ?? 0,
          isActive: p.isActive,
          category: p.category,
          unitCount: p._count.stockUnits,
          image: p.photoUrl,
          photoUrl: p.photoUrl,
        };
      }),
    };
  }

  async listRentalUnits(
    user: AuthUser,
    opts: {
      locationId?: string;
      q?: string;
      categoryId?: string;
      productId?: string;
      status?: string;
    } = {},
  ) {
    await this.assertRentalShop(user.tenantId);
    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const q = opts.q?.trim();
    const statusFilter =
      opts.status &&
      Object.values(StockUnitStatus).includes(opts.status as StockUnitStatus)
        ? (opts.status as StockUnitStatus)
        : undefined;

    const rows = await this.prisma.stockUnit.findMany({
      where: {
        tenantId: user.tenantId,
        locationId,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(opts.productId ? { productId: opts.productId } : {}),
        product: {
          fulfillmentMode: FulfillmentMode.rental,
          ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
        },
        ...(q
          ? {
              OR: [
                { barcodeSku: { contains: q, mode: 'insensitive' } },
                { variantLabel: { contains: q, mode: 'insensitive' } },
                {
                  product: {
                    OR: [
                      { name: { contains: q, mode: 'insensitive' } },
                      { skuCode: { contains: q, mode: 'insensitive' } },
                    ],
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ product: { name: 'asc' } }, { barcodeSku: 'asc' }],
      take: 200,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            basePrice: true,
            isActive: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    return {
      locationId,
      fields: RENTAL_PRODUCT_FIELDS,
      items: rows.map((u) => this.mapUnit(u)),
    };
  }

  async updateRentalProduct(
    user: AuthUser,
    productId: string,
    dto: UpdateRentalProductDto,
  ) {
    await this.assertRentalShop(user.tenantId);
    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.rental,
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    if (dto.categoryId) {
      const cat = await this.prisma.category.findFirst({
        where: { id: dto.categoryId, tenantId: user.tenantId },
      });
      if (!cat) throw new NotFoundException('Category not found');
    }

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...(dto.title !== undefined ? { name: dto.title.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() || null }
          : {}),
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.rentalPrice !== undefined
          ? { basePrice: Number(dto.rentalPrice) }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { stockUnits: true } },
      },
    });

    if (dto.rentalPrice !== undefined) {
      const units = await this.prisma.stockUnit.findMany({
        where: { productId, tenantId: user.tenantId },
        select: { id: true, meta: true },
      });
      await Promise.all(
        units.map((u) =>
          this.prisma.stockUnit.update({
            where: { id: u.id },
            data: {
              meta: {
                ...((u.meta as object) ?? {}),
                rentalPrice: Number(dto.rentalPrice),
              },
            },
          }),
        ),
      );
    }

    return {
      id: updated.id,
      title: updated.name,
      sku: updated.skuCode,
      description: updated.description,
      rentalPrice: updated.basePrice,
      isActive: updated.isActive,
      category: updated.category,
      unitCount: updated._count.stockUnits,
      image: updated.photoUrl ?? null,
    };
  }

  async uploadRentalProductImage(
    user: AuthUser,
    productId: string,
    dto: UploadSaleImageDto,
  ) {
    await this.assertRentalShop(user.tenantId);
    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        tenantId: user.tenantId,
        fulfillmentMode: FulfillmentMode.rental,
      },
    });
    if (!product) throw new NotFoundException('Product not found');

    const photoUrl = await saveProductImage(user.tenantId, dto.imageBase64);
    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: { photoUrl },
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { stockUnits: true } },
      },
    });

    return {
      id: updated.id,
      title: updated.name,
      sku: updated.skuCode,
      image: updated.photoUrl,
      category: updated.category,
      unitCount: updated._count.stockUnits,
    };
  }

  /**
   * Units free for a date range (not overlapping held reservations).
   */
  async rentalAvailability(
    user: AuthUser,
    opts: {
      from: string;
      to: string;
      productId?: string;
      locationId?: string;
    },
  ) {
    await this.assertRentalShop(user.tenantId);
    if (!opts.from || !opts.to) {
      throw new BadRequestException('from and to (YYYY-MM-DD) are required');
    }
    const from = new Date(`${opts.from}T00:00:00.000Z`);
    const to = new Date(`${opts.to}T00:00:00.000Z`);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to < from
    ) {
      throw new BadRequestException('Invalid from/to date range');
    }

    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const units = await this.prisma.stockUnit.findMany({
      where: {
        tenantId: user.tenantId,
        locationId,
        status: StockUnitStatus.available,
        ...(opts.productId ? { productId: opts.productId } : {}),
        product: { fulfillmentMode: FulfillmentMode.rental, isActive: true },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            basePrice: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
          },
        },
        reservations: {
          where: {
            status: ReservationStatus.held,
            startDate: { lte: to },
            endDate: { gte: from },
          },
          select: { id: true },
        },
      },
      orderBy: { barcodeSku: 'asc' },
      take: 200,
    });

    const available = units
      .filter((u) => u.reservations.length === 0)
      .map((u) => this.mapUnit(u));

    return {
      from: opts.from,
      to: opts.to,
      locationId,
      productId: opts.productId ?? null,
      availableCount: available.length,
      items: available,
    };
  }

  async updateRentalUnit(
    user: AuthUser,
    unitId: string,
    dto: UpdateRentalUnitDto,
  ) {
    await this.assertRentalShop(user.tenantId);
    const unit = await this.prisma.stockUnit.findFirst({
      where: { id: unitId, tenantId: user.tenantId },
      include: { product: true },
    });
    if (!unit) throw new NotFoundException('Unit not found');
    if (unit.product.fulfillmentMode !== FulfillmentMode.rental) {
      throw new BadRequestException('Not a rental unit');
    }

    const meta = {
      ...((unit.meta as object) ?? {}),
      ...(dto.rentalPrice !== undefined
        ? { rentalPrice: Number(dto.rentalPrice) }
        : {}),
    };

    const updated = await this.prisma.stockUnit.update({
      where: { id: unitId },
      data: {
        ...(dto.variant !== undefined
          ? { variantLabel: dto.variant.trim() || null }
          : {}),
        ...(dto.deposit !== undefined
          ? { depositAmount: Number(dto.deposit).toFixed(2) }
          : {}),
        meta,
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            basePrice: true,
            isActive: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (dto.isActive === false && updated.status === StockUnitStatus.available) {
      await this.prisma.stockUnit.update({
        where: { id: unitId },
        data: { status: StockUnitStatus.retired },
      });
    }
    if (dto.isActive === true && updated.status === StockUnitStatus.retired) {
      await this.prisma.stockUnit.update({
        where: { id: unitId },
        data: { status: StockUnitStatus.available },
      });
    }

    const fresh = await this.prisma.stockUnit.findFirstOrThrow({
      where: { id: unitId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            basePrice: true,
            isActive: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });
    return this.mapUnit(fresh);
  }

  async rentalCatalog(
    user: AuthUser,
    opts: { locationId?: string; q?: string; limit?: number } = {},
  ) {
    await this.assertRentalShop(user.tenantId);
    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const limit = Math.min(Math.max(opts.limit ?? 80, 1), 200);
    const q = opts.q?.trim();

    const rows = await this.prisma.stockUnit.findMany({
      where: {
        tenantId: user.tenantId,
        locationId,
        status: StockUnitStatus.available,
        product: {
          fulfillmentMode: FulfillmentMode.rental,
          isActive: true,
        },
        ...(q
          ? {
              OR: [
                { barcodeSku: { contains: q, mode: 'insensitive' } },
                { variantLabel: { contains: q, mode: 'insensitive' } },
                {
                  product: {
                    OR: [
                      { name: { contains: q, mode: 'insensitive' } },
                      { skuCode: { contains: q, mode: 'insensitive' } },
                    ],
                  },
                },
              ],
            }
          : {}),
      },
      take: limit,
      orderBy: [{ product: { name: 'asc' } }, { barcodeSku: 'asc' }],
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            basePrice: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    return {
      locationId,
      items: rows.map((u) => this.mapUnit(u)),
    };
  }

  async rentalLookup(
    user: AuthUser,
    opts: { barcode: string; locationId?: string },
  ) {
    await this.assertRentalShop(user.tenantId);
    const barcode = opts.barcode.trim().toUpperCase();
    if (!barcode) throw new BadRequestException('barcode is required');

    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId));

    const include = {
      product: {
        select: {
          id: true,
          name: true,
          skuCode: true,
          basePrice: true,
          photoUrl: true,
            category: { select: { id: true, name: true } },
        },
      },
    } as const;

    const baseWhere = {
      tenantId: user.tenantId,
      barcodeSku: { equals: barcode, mode: 'insensitive' as const },
      product: {
        fulfillmentMode: FulfillmentMode.rental,
        isActive: true,
      },
    };

    let row = locationId
      ? await this.prisma.stockUnit.findFirst({
          where: { ...baseWhere, locationId },
          include,
        })
      : null;

    // Fallback: any location in tenant (multi-store / moved units)
    if (!row) {
      row = await this.prisma.stockUnit.findFirst({
        where: baseWhere,
        include,
      });
    }

    if (!row) throw new NotFoundException(`Barcode not found: ${barcode}`);
    return this.mapUnit(row);
  }

  async listRecentRentals(user: AuthUser, limit = 20) {
    await this.assertRentalShop(user.tenantId);
    const take = Math.min(Math.max(limit, 1), 50);
    const orders = await this.prisma.order.findMany({
      where: { tenantId: user.tenantId, kind: OrderKind.rental },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        subtotal: true,
        balanceDue: true,
        createdAt: true,
        customer: { select: { fullName: true, phone: true } },
        rentalExt: {
          select: {
            lifecycle: true,
            pickupDate: true,
            returnDueDate: true,
          },
        },
        _count: { select: { items: true } },
      },
    });
    return {
      items: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        lifecycle: o.rentalExt?.lifecycle ?? null,
        subtotal: o.subtotal,
        balanceDue: o.balanceDue,
        createdAt: o.createdAt,
        pickupDate: o.rentalExt?.pickupDate ?? null,
        returnDueDate: o.rentalExt?.returnDueDate ?? null,
        customerName: o.customer?.fullName ?? 'Walk-in',
        itemCount: o._count.items,
      })),
    };
  }

  /**
   * Swap a unit on an open rental ticket (reserved or checked_out).
   * Works for any rentable item — not clothes-specific.
   */
  async exchange(user: AuthUser, dto: RentalExchangeDto) {
    await this.assertRentalShop(user.tenantId);
    if (dto.fromStockUnitId === dto.toStockUnitId) {
      throw new BadRequestException('from and to units must differ');
    }

    const order = await this.prisma.order.findFirst({
      where: {
        id: dto.orderId,
        tenantId: user.tenantId,
        kind: OrderKind.rental,
      },
      include: { rentalExt: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const lc = order.rentalExt?.lifecycle;
    if (
      lc !== RentalOrderLifecycle.checked_out &&
      lc !== RentalOrderLifecycle.reserved &&
      lc !== RentalOrderLifecycle.fitted
    ) {
      throw new BadRequestException(
        `Exchange only when reserved / fitted / checked_out (now: ${lc ?? 'n/a'})`,
      );
    }

    const fromItem = await this.prisma.orderItem.findFirst({
      where: {
        orderId: order.id,
        tenantId: user.tenantId,
        stockUnitId: dto.fromStockUnitId,
      },
      include: { stockUnit: true },
    });
    if (!fromItem?.stockUnit) {
      throw new BadRequestException('From unit is not on this order');
    }

    const toUnit = await this.prisma.stockUnit.findFirst({
      where: { id: dto.toStockUnitId, tenantId: user.tenantId },
      include: {
        product: { select: { id: true, name: true, skuCode: true } },
      },
    });
    if (!toUnit) throw new NotFoundException('To unit not found');
    if (toUnit.status !== StockUnitStatus.available) {
      throw new BadRequestException(
        `To unit is ${toUnit.status} — must be available`,
      );
    }

    const targetStatus =
      lc === RentalOrderLifecycle.checked_out
        ? StockUnitStatus.checked_out
        : StockUnitStatus.reserved;
    const targetResStatus =
      lc === RentalOrderLifecycle.checked_out
        ? ReservationStatus.checked_out
        : ReservationStatus.held;

    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.update({
        where: { id: fromItem.id },
        data: {
          stockUnitId: toUnit.id,
          productId: toUnit.productId,
          description: toUnit.product.name,
        },
      });

      await tx.stockReservation.updateMany({
        where: {
          tenantId: user.tenantId,
          orderItemId: fromItem.id,
          stockUnitId: dto.fromStockUnitId,
          status: {
            in: [ReservationStatus.held, ReservationStatus.checked_out],
          },
        },
        data: { status: ReservationStatus.released },
      });

      await tx.stockUnit.update({
        where: { id: dto.fromStockUnitId },
        data: { status: StockUnitStatus.available },
      });
      await tx.stockMovement.create({
        data: {
          tenantId: user.tenantId,
          stockUnitId: dto.fromStockUnitId,
          fromStatus: fromItem.stockUnit!.status,
          toStatus: StockUnitStatus.available,
          reason: 'rental.exchanged_out',
          actorUserId: user.userId,
          orderId: order.id,
        },
      });

      const pickup = order.rentalExt?.pickupDate ?? new Date();
      const ret =
        order.rentalExt?.returnDueDate ??
        new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

      await tx.stockReservation.create({
        data: {
          tenantId: user.tenantId,
          stockUnitId: toUnit.id,
          orderItemId: fromItem.id,
          startDate: pickup,
          endDate: ret,
          status: targetResStatus,
        },
      });

      await tx.stockUnit.update({
        where: { id: toUnit.id },
        data: { status: targetStatus },
      });
      await tx.stockMovement.create({
        data: {
          tenantId: user.tenantId,
          stockUnitId: toUnit.id,
          fromStatus: StockUnitStatus.available,
          toStatus: targetStatus,
          reason: 'rental.exchanged_in',
          actorUserId: user.userId,
          orderId: order.id,
        },
      });

      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'pos.rental.exchanged',
          aggregateType: 'order',
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            fromStockUnitId: dto.fromStockUnitId,
            toStockUnitId: dto.toStockUnitId,
            reason: dto.reason ?? null,
          },
        },
      });
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      fromStockUnitId: dto.fromStockUnitId,
      toStockUnitId: dto.toStockUnitId,
      lifecycle: lc,
      reason: dto.reason ?? null,
    };
  }

  /**
   * Extend return-due date on an open rental; posts extension fee and optional payment.
   */
  async extend(user: AuthUser, dto: ExtendRentalDto) {
    await this.assertRentalShop(user.tenantId);

    const order = await this.prisma.order.findFirst({
      where: {
        id: dto.orderId,
        tenantId: user.tenantId,
        kind: OrderKind.rental,
      },
      include: {
        rentalExt: true,
        items: { where: { stockUnitId: { not: null } } },
      },
    });
    if (!order?.rentalExt) throw new NotFoundException('Rental order not found');

    const lc = order.rentalExt.lifecycle;
    if (
      lc !== RentalOrderLifecycle.checked_out &&
      lc !== RentalOrderLifecycle.ready &&
      lc !== RentalOrderLifecycle.reserved
    ) {
      throw new BadRequestException(
        `Extend only when reserved/ready/checked_out (now: ${lc})`,
      );
    }

    const oldDue = order.rentalExt.returnDueDate
      ? new Date(order.rentalExt.returnDueDate)
      : null;
    if (!oldDue) {
      throw new BadRequestException('Order has no return due date to extend');
    }

    const newDue = new Date(dto.newReturnDueDate);
    if (Number.isNaN(newDue.getTime())) {
      throw new BadRequestException('Invalid newReturnDueDate');
    }
    newDue.setHours(0, 0, 0, 0);
    oldDue.setHours(0, 0, 0, 0);
    if (newDue.getTime() <= oldDue.getTime()) {
      throw new BadRequestException('newReturnDueDate must be after current due date');
    }

    const extraDays = daysBetween(oldDue, newDue);
    const pickup = order.rentalExt.pickupDate
      ? new Date(order.rentalExt.pickupDate)
      : null;
    const originalDays =
      pickup && oldDue ? Math.max(1, daysBetween(pickup, oldDue)) : 1;
    const lineRent = order.items.reduce((s, i) => s + Number(i.lineTotal), 0);
    const defaultDaily = lineRent / originalDays;
    const rate =
      dto.ratePerDay !== undefined && dto.ratePerDay >= 0
        ? dto.ratePerDay
        : defaultDaily;
    const feeAmount =
      dto.extensionAmount !== undefined
        ? dto.extensionAmount
        : Math.round(rate * extraDays * 100) / 100;

    if (feeAmount < 0) {
      throw new BadRequestException('Extension fee cannot be negative');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.modRentalOrder.update({
        where: { orderId: order.id },
        data: { returnDueDate: newDue },
      });

      if (feeAmount > 0) {
        await tx.orderFee.create({
          data: {
            tenantId: user.tenantId,
            orderId: order.id,
            feeCode: 'extension',
            amount: feeAmount.toFixed(2),
            reason: `Extended ${extraDays} day(s) to ${dto.newReturnDueDate}`,
          },
        });
      }

      const meta = (order.meta ?? {}) as Record<string, unknown>;
      await tx.order.update({
        where: { id: order.id },
        data: {
          meta: {
            ...meta,
            lastExtension: {
              from: oldDue.toISOString().slice(0, 10),
              to: dto.newReturnDueDate,
              extraDays,
              feeAmount,
              byUserId: user.userId,
              at: new Date().toISOString(),
            },
          },
        },
      });

      await this.ordersService.recalculateTotals(tx, user.tenantId, order.id);

      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'pos.rental.extended',
          aggregateType: 'order',
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            extraDays,
            feeAmount,
            newReturnDueDate: dto.newReturnDueDate,
          },
        },
      });
    });

    let payment = null;
    if (dto.payment && feeAmount > 0) {
      payment = await this.paymentsService.create(user, {
        orderId: order.id,
        method: dto.payment.method,
        amount: dto.payment.amount,
        idempotencyKey: dto.payment.idempotencyKey,
        type: dto.payment.type ?? PaymentType.payment,
      });
    }

    const refreshed = await this.prisma.order.findFirstOrThrow({
      where: { id: order.id },
      include: { rentalExt: true },
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      previousReturnDueDate: oldDue.toISOString().slice(0, 10),
      newReturnDueDate: dto.newReturnDueDate,
      extraDays,
      extensionFee: feeAmount,
      balanceDue: refreshed.balanceDue,
      payment,
      lifecycle: refreshed.rentalExt?.lifecycle ?? lc,
    };
  }

  private mapUnit(u: {
    id: string;
    barcodeSku: string;
    variantLabel: string | null;
    status: StockUnitStatus;
    depositAmount: Prisma.Decimal | string | number;
    meta: unknown;
    product: {
      id: string;
      name: string;
      skuCode: string;
      basePrice: Prisma.Decimal | string | number;
      isActive?: boolean;
      photoUrl?: string | null;
      category?: { id: string; name: string } | null;
    };
  }) {
    const rentalPrice = metaPrice(u.meta) ?? Number(u.product.basePrice);
    return {
      id: u.id,
      barcode: u.barcodeSku,
      barcodeSku: u.barcodeSku,
      variant: u.variantLabel,
      size: u.variantLabel,
      status: u.status,
      deposit: u.depositAmount,
      rentalPrice,
      productId: u.product.id,
      title: u.product.name,
      sku: u.product.skuCode,
      isActive: u.product.isActive ?? true,
      category: u.product.category ?? null,
      image: u.product.photoUrl ?? null,
      photoUrl: u.product.photoUrl ?? null,
    };
  }

  private async assertRentalShop(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { settings: true },
    });
    const parsed = parseCommerceModes(tenant.settings);
    if (!parsed.modes.includes('rental')) {
      throw new BadRequestException('Rental POS is not enabled for this shop');
    }
  }

  private async defaultLocationId(tenantId: string) {
    const main = await this.prisma.location.findFirst({
      where: { tenantId, isActive: true, code: 'MAIN' },
      select: { id: true },
    });
    if (main) return main.id;
    const any = await this.prisma.location.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return any?.id ?? null;
  }
}
