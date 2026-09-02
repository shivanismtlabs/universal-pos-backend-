import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FulfillmentMode,
  InspectStatus,
  OrderKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Prisma,
  ProductKind,
  ProductStatus,
  RentalOrderLifecycle,
  ReservationStatus,
  StockUnitCondition,
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
  CheckRentalAvailabilityDto,
  RentalPickupDto,
  RentalReturnSettleDto,
  CancelRentalBookingDto,
} from './dto/pos.dto';
import {
  BLOCKED_UNIT_STATUSES,
  calcLateFee,
  readRentalFeeConfig,
} from './rental-unit-lifecycle';

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

    const [categories, products, units, openOut, available, serviceRows] =
      await Promise.all([
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
        // Service catalog items (no stock units) — rentable as product lines
        this.prisma.product.findMany({
          where: {
            tenantId: user.tenantId,
            isActive: true,
            availableInPos: true,
            status: ProductStatus.active,
            OR: [
              { kind: ProductKind.service },
              { fulfillmentMode: FulfillmentMode.service },
            ],
          },
          orderBy: { name: 'asc' },
          take: 80,
          select: {
            id: true,
            name: true,
            skuCode: true,
            basePrice: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
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
        services: serviceRows.length,
      },
      categories,
      units: recentUnits.map((u) => this.mapUnit(u)),
      services: serviceRows.map((p) => ({
        id: p.id,
        productId: p.id,
        title: p.name,
        sku: p.skuCode,
        rentalPrice: Number(p.basePrice),
        deposit: 0,
        kind: 'service' as const,
        category: p.category,
        image: p.photoUrl,
        photoUrl: p.photoUrl,
      })),
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
    const rentalPrice = Number(dto.rentalPrice ?? 0);
    const feeMeta = {
      rentalPrice,
      ratePeriod: dto.ratePeriod || 'day',
      minDuration: Number(dto.minDuration ?? 1),
      deposit: Number(dto.deposit ?? 0),
      lateFeePerDay: Number(dto.lateFeePerDay ?? 0),
      lateFeePerHour: Number(dto.lateFeePerHour ?? 0),
      lateFeeEnabled: dto.lateFeeEnabled !== false,
      cleaningFee: Number(dto.cleaningFee ?? 0),
      damageFeeDefault: Number(dto.damageFeeDefault ?? 0),
      replacementValue: Number(dto.replacementValue ?? 0),
      canRent: dto.canRent !== false,
      canSell: Boolean(dto.canSell),
      salePrice: Number(dto.salePrice ?? 0),
      trackSerial: dto.trackSerial !== false,
    };

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
          trackQty: !feeMeta.trackSerial,
          trackSerial: feeMeta.trackSerial,
          canSell: feeMeta.canSell,
          canPurchase: true,
          basePrice: rentalPrice,
          meta: feeMeta,
        },
      });

      const barcode = dto.barcode?.trim() ? dto.barcode.trim().toUpperCase() : `${product.skuCode}-001`;
      const unit = await this.prisma.stockUnit.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          productId: product.id,
          barcodeSku: barcode,
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
      return {
        mode: 'rental' as const,
        fieldsUsed: RENTAL_PRODUCT_FIELDS.map((f) => f.key),
        product: {
          id: product.id,
          title: product.name,
          sku: product.skuCode,
          category: cat,
          rentalConfig: feeMeta,
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

    const existingMeta = ((product.meta as Record<string, unknown>) ?? {});
    const newRentalPrice =
      dto.rentalPrice !== undefined
        ? Number(dto.rentalPrice)
        : Number(product.basePrice);

    const mergedMeta = {
      ...existingMeta,
      rentalPrice: newRentalPrice,
      ...(dto.ratePeriod !== undefined ? { ratePeriod: dto.ratePeriod } : {}),
      ...(dto.minDuration !== undefined
        ? { minDuration: Number(dto.minDuration) }
        : {}),
      ...(dto.deposit !== undefined ? { deposit: Number(dto.deposit) } : {}),
      ...(dto.lateFeePerDay !== undefined
        ? { lateFeePerDay: Number(dto.lateFeePerDay) }
        : {}),
      ...(dto.lateFeePerHour !== undefined
        ? { lateFeePerHour: Number(dto.lateFeePerHour) }
        : {}),
      ...(dto.lateFeeEnabled !== undefined
        ? { lateFeeEnabled: dto.lateFeeEnabled }
        : {}),
      ...(dto.cleaningFee !== undefined
        ? { cleaningFee: Number(dto.cleaningFee) }
        : {}),
      ...(dto.damageFeeDefault !== undefined
        ? { damageFeeDefault: Number(dto.damageFeeDefault) }
        : {}),
      ...(dto.replacementValue !== undefined
        ? { replacementValue: Number(dto.replacementValue) }
        : {}),
      ...(dto.canRent !== undefined ? { canRent: dto.canRent } : {}),
      ...(dto.canSell !== undefined ? { canSell: dto.canSell } : {}),
      ...(dto.salePrice !== undefined
        ? { salePrice: Number(dto.salePrice) }
        : {}),
    };

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: {
        ...(dto.title !== undefined ? { name: dto.title.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() || null }
          : {}),
        ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
        ...(dto.rentalPrice !== undefined
          ? { basePrice: newRentalPrice }
          : {}),
        ...(dto.canSell !== undefined ? { canSell: dto.canSell } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        meta: mergedMeta,
      },
      include: {
        category: { select: { id: true, name: true } },
        _count: { select: { stockUnits: true } },
      },
    });

    if (dto.rentalPrice !== undefined || dto.deposit !== undefined) {
      const units = await this.prisma.stockUnit.findMany({
        where: { productId, tenantId: user.tenantId },
        select: { id: true, meta: true },
      });
      await Promise.all(
        units.map((u) =>
          this.prisma.stockUnit.update({
            where: { id: u.id },
            data: {
              ...(dto.deposit !== undefined
                ? { depositAmount: Number(dto.deposit).toFixed(2) }
                : {}),
              meta: {
                ...((u.meta as object) ?? {}),
                rentalPrice: newRentalPrice,
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
      rentalConfig: mergedMeta,
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
        status: { notIn: BLOCKED_UNIT_STATUSES },
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
            status: {
              in: [ReservationStatus.held, ReservationStatus.checked_out],
            },
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

  /**
   * Preview late fee for a rental ticket (does not charge).
   * Uses product meta.lateFeePerDay / lateFeeEnabled from line units.
   */
  async lateFeePreview(user: AuthUser, orderId: string) {
    await this.assertRentalShop(user.tenantId);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId, kind: OrderKind.rental },
      include: {
        rentalExt: true,
        items: {
          include: {
            stockUnit: {
              include: { product: { select: { meta: true, id: true } } },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Rental order not found');

    const due = order.rentalExt?.returnDueDate ?? null;
    let suggested = 0;
    let days = 0;
    let applicable = false;
    const lines: Array<{
      stockUnitId: string | null;
      lateFeePerDay: number;
      daysLate: number;
      amount: number;
    }> = [];

    for (const item of order.items) {
      const feeConfig = readRentalFeeConfig(item.stockUnit?.product?.meta);
      const calc = calcLateFee({ returnDue: due, feeConfig });
      if (calc.applicable) {
        applicable = true;
        days = Math.max(days, calc.daysLate);
        suggested = Math.round((suggested + calc.suggested) * 100) / 100;
      }
      lines.push({
        stockUnitId: item.stockUnitId,
        lateFeePerDay: feeConfig.lateFeePerDay,
        daysLate: calc.daysLate,
        amount: calc.suggested,
      });
    }

    return {
      orderId,
      returnDueDate: due,
      daysLate: days,
      applicable,
      suggestedLateFee: suggested,
      lines,
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

  /**
   * Check rental availability across a date/time window.
   * Enforces date overlap checks against existing held/checked_out reservations.
   */
  async checkAvailability(user: AuthUser, dto: CheckRentalAvailabilityDto) {
    await this.assertRentalShop(user.tenantId);
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw new BadRequestException('Invalid startDate or endDate');
    }
    const locationId = dto.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const requestedQty = Math.max(1, dto.quantity ?? 1);

    const units = await this.prisma.stockUnit.findMany({
      where: {
        tenantId: user.tenantId,
        locationId,
        status: { notIn: BLOCKED_UNIT_STATUSES },
        ...(dto.productId ? { productId: dto.productId } : {}),
        ...(dto.stockUnitId ? { id: dto.stockUnitId } : {}),
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
            meta: true,
            category: { select: { id: true, name: true } },
          },
        },
        reservations: {
          where: {
            status: {
              in: [ReservationStatus.held, ReservationStatus.checked_out],
            },
            startDate: { lte: end },
            endDate: { gte: start },
          },
          select: { id: true },
        },
      },
      orderBy: { barcodeSku: 'asc' },
      take: 200,
    });

    const availableUnits = units.filter((u) => u.reservations.length === 0);
    const isAvailable = availableUnits.length >= requestedQty;

    return {
      available: isAvailable,
      availableCount: availableUnits.length,
      requestedQuantity: requestedQty,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      items: availableUnits.map((u) => this.mapUnit(u)),
    };
  }

  /**
   * Pickup rental order: assign assets, record condition, transition to checked_out.
   */
  async pickup(user: AuthUser, dto: RentalPickupDto) {
    await this.assertRentalShop(user.tenantId);
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId, kind: OrderKind.rental },
      include: {
        rentalExt: true,
        items: {
          include: {
            stockUnit: true,
            product: true,
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Rental order not found');

    const lc = order.rentalExt?.lifecycle;
    if (
      lc === RentalOrderLifecycle.checked_out ||
      lc === RentalOrderLifecycle.returned ||
      lc === RentalOrderLifecycle.closed ||
      lc === RentalOrderLifecycle.cancelled
    ) {
      throw new BadRequestException(
        `Order is already ${lc} — cannot pickup again`,
      );
    }

    const pickupDate = order.rentalExt?.pickupDate ?? new Date();
    const returnDue = order.rentalExt?.returnDueDate ?? new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      // If explicit stockUnitIds provided, map them to lines
      if (dto.stockUnitIds && dto.stockUnitIds.length > 0) {
        for (let i = 0; i < dto.stockUnitIds.length; i++) {
          const unitId = dto.stockUnitIds[i];
          const item = order.items[i];
          if (item && item.stockUnitId !== unitId) {
            await tx.orderItem.update({
              where: { id: item.id },
              data: { stockUnitId: unitId },
            });
          }
        }
      }

      // Transition units to checked_out and create/update reservations
      const refreshedItems = await tx.orderItem.findMany({
        where: { orderId: order.id, tenantId: user.tenantId },
        include: { stockUnit: true },
      });

      for (const item of refreshedItems) {
        if (item.stockUnitId) {
          await tx.stockUnit.update({
            where: { id: item.stockUnitId },
            data: { status: StockUnitStatus.checked_out },
          });

          await tx.stockMovement.create({
            data: {
              tenantId: user.tenantId,
              stockUnitId: item.stockUnitId,
              fromStatus: item.stockUnit?.status ?? StockUnitStatus.available,
              toStatus: StockUnitStatus.checked_out,
              reason: 'rental.pickup',
              actorUserId: user.userId,
              orderId: order.id,
            },
          });

          const existingRes = await tx.stockReservation.findFirst({
            where: {
              tenantId: user.tenantId,
              orderItemId: item.id,
              stockUnitId: item.stockUnitId,
            },
          });

          if (existingRes) {
            await tx.stockReservation.update({
              where: { id: existingRes.id },
              data: { status: ReservationStatus.checked_out },
            });
          } else {
            await tx.stockReservation.create({
              data: {
                tenantId: user.tenantId,
                stockUnitId: item.stockUnitId,
                orderItemId: item.id,
                startDate: pickupDate,
                endDate: returnDue,
                status: ReservationStatus.checked_out,
              },
            });
          }
        }
      }

      // Update Rental Order Lifecycle to checked_out
      await tx.modRentalOrder.update({
        where: { orderId: order.id },
        data: {
          lifecycle: RentalOrderLifecycle.checked_out,
          pickupDate: new Date(),
        },
      });

      // Update Order meta with pickup record
      const currentMeta = (order.meta as Record<string, unknown>) ?? {};
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.fulfilled,
          meta: {
            ...currentMeta,
            pickupRecord: {
              pickupAt: new Date().toISOString(),
              pickedUpByUserId: user.userId,
              pickupCondition: dto.pickupCondition || 'good',
              accessories: dto.accessories || null,
              notes: dto.pickupNotes || null,
            },
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'pos.rental.picked_up',
          aggregateType: 'order',
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            pickupDate: new Date().toISOString(),
            condition: dto.pickupCondition || 'good',
          },
        },
      });
    });

    return this.ordersService.getById(user, order.id);
  }

  /**
   * Universal Return Inspection & Deposit Settlement.
   * Inspects units, calculates late & damage charges, adjusts held deposit, and returns final balance.
   */
  async returnSettle(user: AuthUser, dto: RentalReturnSettleDto) {
    await this.assertRentalShop(user.tenantId);
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId, kind: OrderKind.rental },
      include: {
        rentalExt: true,
        items: {
          include: {
            stockUnit: {
              include: { product: { select: { meta: true, basePrice: true } } },
            },
          },
        },
        fees: true,
        payments: true,
      },
    });
    if (!order) throw new NotFoundException('Rental order not found');

    const due = order.rentalExt?.returnDueDate ?? null;
    const now = new Date();

    // 1. Calculate Late Fee
    let lateFee = 0;
    if (dto.lateFeeOverride !== undefined && dto.lateFeeOverride >= 0) {
      lateFee = dto.lateFeeOverride;
    } else if (due && now.getTime() > new Date(due).getTime()) {
      for (const item of order.items) {
        const feeConfig = readRentalFeeConfig(item.stockUnit?.product?.meta);
        const calc = calcLateFee({ returnDue: due, feeConfig, actualReturn: now });
        if (calc.applicable) {
          lateFee = Math.round((lateFee + calc.suggested) * 100) / 100;
        }
      }
    }

    // 2. Calculate Damage Charges from items
    let totalDamageCharge = dto.damageCharges ?? 0;
    for (const itemDto of dto.items ?? []) {
      totalDamageCharge += Number(itemDto.damageCharge ?? 0) + Number(itemDto.missingCharge ?? 0);
    }

    const depositHeld = Number(order.depositTotal ?? 0);
    const totalDeductions = lateFee + totalDamageCharge;
    const autoRefund = Math.max(0, depositHeld - totalDeductions);
    const refundAmount =
      dto.depositRefundAmount !== undefined
        ? Number(dto.depositRefundAmount)
        : autoRefund;

    await this.prisma.$transaction(async (tx) => {
      // Process each returned unit
      for (const itemInspection of dto.items ?? []) {
        const unitId = itemInspection.stockUnitId;
        const cond = itemInspection.condition;
        const isDamaged = cond === 'minor_damage' || cond === 'major_damage';
        const isLost = cond === 'missing' || cond === 'lost';
        const isCleaning = itemInspection.cleaningRequired || false;

        let nextStatus: StockUnitStatus = StockUnitStatus.available;
        let nextCond: StockUnitCondition = StockUnitCondition.good;

        if (isLost) {
          nextStatus = StockUnitStatus.lost;
          nextCond = StockUnitCondition.damaged;
        } else if (isDamaged) {
          nextStatus = StockUnitStatus.repair;
          nextCond = StockUnitCondition.damaged;
        } else if (isCleaning) {
          nextStatus = StockUnitStatus.cleaning;
          nextCond = StockUnitCondition.good;
        }

        // Release reservation
        await tx.stockReservation.updateMany({
          where: {
            tenantId: user.tenantId,
            stockUnitId: unitId,
            status: { in: [ReservationStatus.held, ReservationStatus.checked_out] },
          },
          data: { status: ReservationStatus.released },
        });

        // Update unit status & condition
        await tx.stockUnit.update({
          where: { id: unitId },
          data: { status: nextStatus, condition: nextCond },
        });

        // Record stock movement
        await tx.stockMovement.create({
          data: {
            tenantId: user.tenantId,
            stockUnitId: unitId,
            fromStatus: StockUnitStatus.checked_out,
            toStatus: nextStatus,
            reason: `rental.returned:${cond}`,
            actorUserId: user.userId,
            orderId: order.id,
          },
        });

        // Create return event
        await tx.returnEvent.create({
          data: {
            tenantId: user.tenantId,
            orderId: order.id,
            stockUnitId: unitId,
            receivedById: user.userId,
            notes: itemInspection.notes || `Condition: ${cond}`,
          },
        });

        // Create damage record if damaged or missing
        if (isDamaged || (itemInspection.damageCharge && itemInspection.damageCharge > 0)) {
          await tx.modRentalDamageRecord.create({
            data: {
              tenantId: user.tenantId,
              stockUnitId: unitId,
              inspectStatus: isDamaged ? InspectStatus.damaged : InspectStatus.clean_ready,
              chargeAmount: Number(itemInspection.damageCharge ?? 0).toFixed(2),
              notes: itemInspection.notes || `Condition: ${cond}`,
            },
          });
        }

        // Create cleaning job if needed
        if (isCleaning) {
          await tx.modRentalCleaningJob.create({
            data: {
              tenantId: user.tenantId,
              stockUnitId: unitId,
              status: 'queued',
              notes: itemInspection.notes,
            },
          });
        }
      }

      // Add Late Fee if applicable
      if (lateFee > 0) {
        await tx.orderFee.create({
          data: {
            tenantId: user.tenantId,
            orderId: order.id,
            feeCode: 'late_fee',
            amount: lateFee.toFixed(2),
            reason: 'Late return fee',
          },
        });
      }

      // Add Damage Fee if applicable
      if (totalDamageCharge > 0) {
        await tx.orderFee.create({
          data: {
            tenantId: user.tenantId,
            orderId: order.id,
            feeCode: 'damage',
            amount: totalDamageCharge.toFixed(2),
            reason: 'Damage / missing item assessment',
          },
        });
      }

      // Process Deposit Refund if amount > 0
      if (refundAmount > 0) {
        await tx.payment.create({
          data: {
            tenantId: user.tenantId,
            orderId: order.id,
            type: PaymentType.deposit_refund,
            method: dto.refundMethod ?? PaymentMethod.cash,
            status: PaymentStatus.succeeded,
            amount: refundAmount.toFixed(2),
            currencyCode: order.currencyCode,
            idempotencyKey: `dep-ref-${order.id}-${Date.now()}`,
          },
        });
      }

      // Update Rental Order lifecycle to returned
      await tx.modRentalOrder.update({
        where: { orderId: order.id },
        data: { lifecycle: RentalOrderLifecycle.returned },
      });

      // Recalculate totals
      await this.ordersService.recalculateTotals(tx, user.tenantId, order.id);

      // Record audit outbox
      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'pos.rental.return_settled',
          aggregateType: 'order',
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            lateFee,
            totalDamageCharge,
            refundAmount,
            returnedAt: now.toISOString(),
          },
        },
      });
    });

    return this.ordersService.getById(user, order.id);
  }

  /**
   * Cancel a rental booking and release all holds.
   */
  async cancel(user: AuthUser, dto: CancelRentalBookingDto) {
    await this.assertRentalShop(user.tenantId);
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId, kind: OrderKind.rental },
      include: {
        rentalExt: true,
        items: { include: { stockUnit: true } },
        payments: true,
      },
    });
    if (!order) throw new NotFoundException('Rental order not found');

    const lc = order.rentalExt?.lifecycle;
    if (lc === RentalOrderLifecycle.checked_out) {
      throw new BadRequestException('Cannot cancel an active rental that is already checked out. Please process a return.');
    }
    if (lc === RentalOrderLifecycle.cancelled || order.status === OrderStatus.cancelled) {
      throw new BadRequestException('Order is already cancelled');
    }

    await this.prisma.$transaction(async (tx) => {
      // Release all reservations
      for (const item of order.items) {
        if (item.stockUnitId) {
          await tx.stockReservation.updateMany({
            where: {
              tenantId: user.tenantId,
              stockUnitId: item.stockUnitId,
              status: { in: [ReservationStatus.held, ReservationStatus.checked_out] },
            },
            data: { status: ReservationStatus.released },
          });

          await tx.stockUnit.update({
            where: { id: item.stockUnitId },
            data: { status: StockUnitStatus.available },
          });
        }
      }

      // Add cancellation fee if specified
      if (dto.cancellationFee && dto.cancellationFee > 0) {
        await tx.orderFee.create({
          data: {
            tenantId: user.tenantId,
            orderId: order.id,
            feeCode: 'cancellation',
            amount: Number(dto.cancellationFee).toFixed(2),
            reason: dto.reason || 'Booking cancellation fee',
          },
        });
      }

      // Update lifecycle and order status
      await tx.modRentalOrder.update({
        where: { orderId: order.id },
        data: { lifecycle: RentalOrderLifecycle.cancelled },
      });

      const currentMeta = (order.meta as Record<string, unknown>) ?? {};
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.cancelled,
          meta: {
            ...currentMeta,
            cancelledRecord: {
              cancelledAt: new Date().toISOString(),
              cancelledByUserId: user.userId,
              reason: dto.reason || 'Cancelled by staff',
              cancellationFee: dto.cancellationFee ?? 0,
            },
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'pos.rental.cancelled',
          aggregateType: 'order',
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            reason: dto.reason,
            cancellationFee: dto.cancellationFee,
          },
        },
      });
    });

    return this.ordersService.getById(user, order.id);
  }

  /**
   * Calendar timeline events for rental bookings, pickups, and return due dates.
   */
  async calendar(user: AuthUser, from?: string, to?: string) {
    await this.assertRentalShop(user.tenantId);
    const startDate = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endDate = to ? new Date(to) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        kind: OrderKind.rental,
        rentalExt: {
          OR: [
            { pickupDate: { gte: startDate, lte: endDate } },
            { returnDueDate: { gte: startDate, lte: endDate } },
            { lifecycle: { in: [RentalOrderLifecycle.checked_out, RentalOrderLifecycle.reserved, RentalOrderLifecycle.quote] } },
          ],
        },
      },
      include: {
        customer: { select: { id: true, fullName: true, phone: true } },
        rentalExt: true,
        items: {
          include: {
            stockUnit: { select: { id: true, barcodeSku: true, variantLabel: true } },
            product: { select: { id: true, name: true, skuCode: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const now = Date.now();
    return {
      from: startDate.toISOString(),
      to: endDate.toISOString(),
      events: orders.map((o) => {
        const pickup = o.rentalExt?.pickupDate ?? o.createdAt;
        const returnDue = o.rentalExt?.returnDueDate ?? pickup;
        const isOverdue =
          o.rentalExt?.lifecycle === RentalOrderLifecycle.checked_out &&
          new Date(returnDue).getTime() < now;

        return {
          id: o.id,
          orderId: o.id,
          orderNumber: o.orderNumber,
          customerName: o.customer?.fullName ?? 'Walk-in',
          customerPhone: o.customer?.phone ?? null,
          pickupDate: pickup,
          returnDueDate: returnDue,
          lifecycle: o.rentalExt?.lifecycle ?? 'quote',
          status: o.status,
          isOverdue,
          totalAmount: o.subtotal,
          balanceDue: o.balanceDue,
          items: o.items.map((it) => ({
            name: it.product?.name ?? it.description ?? 'Rental Item',
            sku: it.product?.skuCode ?? null,
            barcode: it.stockUnit?.barcodeSku ?? null,
            quantity: Number(it.quantity),
          })),
        };
      }),
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
