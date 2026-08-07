import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FulfillmentMode,
  OrderItemKind,
  OrderKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import {
  SALE_PRODUCT_FIELDS,
  getCommerceSchema,
  parseCommerceModes,
} from '../../common/commerce-schema';
import { saveProductImage } from '../../common/product-image';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import {
  buildTaxProfile,
  computeLineTax,
} from '../../common/tax-engine';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import {
  AddSaleCategoryDto,
  AddSaleProductDto,
  AdjustSaleStockDto,
  CheckoutDto,
  CloseRegisterDto,
  OpenRegisterDto,
  ParkSaleDto,
  PrepareSaleCheckoutDto,
  RenameSaleCategoryDto,
  SaleCheckoutDto,
  SaleReturnDto,
  UpdateSaleProductDto,
  UploadSaleImageDto,
} from './dto/pos.dto';

const READY_FROM: OrderStatus[] = [
  OrderStatus.confirmed,
  OrderStatus.in_progress,
];

const IMMEDIATE_PAY: PaymentMethod[] = [
  PaymentMethod.cash,
  PaymentMethod.card,
  PaymentMethod.upi,
];

function money(n: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(n);
}

@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly ordersService: OrdersService,
  ) {}

  /**
   * Universal Sale product schema — identical keys for every Sale tenant.
   * title, description, categoryId, sku, price, qty
   */
  saleSchema() {
    return {
      mode: 'sale' as const,
      label: 'Sale',
      description:
        'Same product keys for every Sale shop. Values (titles, categories) are yours.',
      fields: SALE_PRODUCT_FIELDS,
    };
  }

  /** Schema for any registered mode — used by DynamicCommerceForm */
  modeSchema(mode: string) {
    const entry = getCommerceSchema(mode);
    if (!entry) {
      throw new BadRequestException(`Unknown commerce mode: ${mode}`);
    }
    return {
      mode: entry.mode,
      label: entry.label,
      description: entry.description,
      fields: entry.fields,
      categoryExamples: [...entry.categoryExamples],
      lifecycle: entry.lifecycle ? [...entry.lifecycle] : undefined,
    };
  }

  /** Sale floor bootstrap: schema + categories + stock counts */
  async saleFloor(user: AuthUser, locationId?: string) {
    await this.assertSaleShop(user.tenantId);
    const locId = locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locId) throw new BadRequestException('No location configured');

    const [categories, stockRows, products, catalog] = await Promise.all([
      this.prisma.category.findMany({
        where: { tenantId: user.tenantId },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      }),
      this.prisma.stockLevel.count({
        where: { tenantId: user.tenantId, locationId: locId },
      }),
      this.prisma.product.count({
        where: {
          tenantId: user.tenantId,
          fulfillmentMode: FulfillmentMode.sale,
        },
      }),
      this.saleCatalog(user, { locationId: locId, limit: 100 }),
    ]);

    return {
      schema: this.saleSchema(),
      locationId: locId,
      counts: {
        categories: categories.length,
        products,
        stockRows,
        inStock: catalog.items.length,
      },
      categories,
      items: catalog.items,
    };
  }

  /** Add category from Sale POS (same for every shop) */
  async addSaleCategory(user: AuthUser, dto: AddSaleCategoryDto) {
    await this.assertSaleShop(user.tenantId);
    try {
      return await this.prisma.category.create({
        data: { tenantId: user.tenantId, name: dto.name.trim() },
        select: { id: true, name: true },
      });
    } catch (error) {
      throwIfUnique(error, 'Category name already exists');
    }
  }

  /**
   * Add sale product with universal keys.
   * Every Sale tenant fills the same keys; then item appears on POS catalog.
   */
  async addSaleProduct(user: AuthUser, dto: AddSaleProductDto) {
    await this.assertSaleShop(user.tenantId);

    const cat = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, tenantId: user.tenantId },
      select: { id: true, name: true },
    });
    if (!cat) throw new NotFoundException('Category not found');

    let locationId = dto.locationId;
    if (!locationId) {
      locationId = (await this.defaultLocationId(user.tenantId)) ?? undefined;
    }
    if (!locationId) throw new BadRequestException('No location configured');

    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    try {
      const product = await this.prisma.product.create({
        data: {
          tenantId: user.tenantId,
          categoryId: dto.categoryId,
          name: dto.title.trim(),
          skuCode: dto.sku.trim().toUpperCase(),
          description: dto.description?.trim(),
          photoUrl: (dto.image ?? dto.photoUrl)?.trim() || null,
          kind: 'physical',
          fulfillmentMode: FulfillmentMode.sale,
          trackQty: true,
          trackSerial: false,
          basePrice: Number(dto.price),
        },
      });
      const level = await this.prisma.stockLevel.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          productId: product.id,
          sku: dto.sku.trim().toUpperCase(),
          qtyOnHand: dto.qty,
          sellPrice: Number(dto.price).toFixed(2),
        },
      });
      return {
        mode: 'sale' as const,
        fieldsUsed: SALE_PRODUCT_FIELDS.map((f) => f.key),
        product: {
          id: product.id,
          title: product.name,
          sku: product.skuCode,
          description: product.description,
          image: product.photoUrl,
          photoUrl: product.photoUrl,
          category: cat,
        },
        stockLevel: {
          id: level.id,
          sku: level.sku,
          sellPrice: level.sellPrice,
          qtyOnHand: level.qtyOnHand,
        },
        /** Ready to sell on POS immediately */
        posItem: {
          id: level.id,
          sku: level.sku,
          name: product.name,
          sellPrice: level.sellPrice,
          qtyOnHand: level.qtyOnHand,
          image: product.photoUrl,
          photoUrl: product.photoUrl,
          category: cat,
        },
      };
    } catch (error) {
      throwIfUnique(error, 'SKU already exists for this shop');
    }
  }

  /** All sale products (incl. zero stock) — manage + sell */
  async listSaleProducts(
    user: AuthUser,
    opts: { locationId?: string; q?: string; categoryId?: string } = {},
  ) {
    await this.assertSaleShop(user.tenantId);
    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const q = opts.q?.trim();
    const rows = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: user.tenantId,
        locationId,
        product: {
          fulfillmentMode: FulfillmentMode.sale,
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
      },
      orderBy: [{ product: { name: 'asc' } }],
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            description: true,
            photoUrl: true,
            isActive: true,
            basePrice: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    return {
      locationId,
      fields: SALE_PRODUCT_FIELDS,
      items: rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        sku: r.sku,
        title: r.product.name,
        description: r.product.description,
        image: r.product.photoUrl,
        photoUrl: r.product.photoUrl,
        price: r.sellPrice,
        qty: r.qtyOnHand,
        isActive: r.product.isActive,
        category: r.product.category,
      })),
    };
  }

  async updateSaleProduct(
    user: AuthUser,
    stockLevelId: string,
    dto: UpdateSaleProductDto,
  ) {
    await this.assertSaleShop(user.tenantId);
    const level = await this.prisma.stockLevel.findFirst({
      where: { id: stockLevelId, tenantId: user.tenantId },
      include: { product: true },
    });
    if (!level) throw new NotFoundException('Product not found');
    if (level.product.fulfillmentMode !== FulfillmentMode.sale) {
      throw new BadRequestException('Not a sale product');
    }

    if (dto.categoryId) {
      const cat = await this.prisma.category.findFirst({
        where: { id: dto.categoryId, tenantId: user.tenantId },
      });
      if (!cat) throw new NotFoundException('Category not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: level.productId },
        data: {
          ...(dto.title !== undefined ? { name: dto.title.trim() } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description.trim() || null }
            : {}),
          ...(dto.categoryId ? { categoryId: dto.categoryId } : {}),
          ...(dto.image !== undefined || dto.photoUrl !== undefined
            ? {
                photoUrl:
                  (dto.image ?? dto.photoUrl)?.trim() || null,
              }
            : {}),
          ...(dto.price !== undefined
            ? { basePrice: Number(dto.price) }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
      await tx.stockLevel.update({
        where: { id: level.id },
        data: {
          ...(dto.price !== undefined
            ? { sellPrice: Number(dto.price).toFixed(2) }
            : {}),
          ...(dto.qty !== undefined ? { qtyOnHand: dto.qty } : {}),
        },
      });
    });

    return this.getSaleProduct(user, stockLevelId);
  }

  async adjustSaleStock(
    user: AuthUser,
    stockLevelId: string,
    dto: AdjustSaleStockDto,
  ) {
    await this.assertSaleShop(user.tenantId);
    const level = await this.prisma.stockLevel.findFirst({
      where: { id: stockLevelId, tenantId: user.tenantId },
    });
    if (!level) throw new NotFoundException('Product not found');

    const next = level.qtyOnHand + dto.delta;
    if (next < 0) {
      throw new BadRequestException(
        `Cannot reduce below 0 (have ${level.qtyOnHand})`,
      );
    }

    const updated = await this.prisma.stockLevel.update({
      where: { id: level.id },
      data: { qtyOnHand: next },
    });
    return {
      id: updated.id,
      sku: updated.sku,
      qty: updated.qtyOnHand,
      delta: dto.delta,
    };
  }

  async getSaleProduct(user: AuthUser, stockLevelId: string) {
    const level = await this.prisma.stockLevel.findFirst({
      where: { id: stockLevelId, tenantId: user.tenantId },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            description: true,
            photoUrl: true,
            isActive: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!level) throw new NotFoundException('Product not found');
    return {
      id: level.id,
      productId: level.productId,
      sku: level.sku,
      title: level.product.name,
      description: level.product.description,
      image: level.product.photoUrl,
      photoUrl: level.product.photoUrl,
      price: level.sellPrice,
      qty: level.qtyOnHand,
      isActive: level.product.isActive,
      category: level.product.category,
    };
  }

  /** Upload / replace product image (universal — any sale category) */
  async uploadSaleProductImage(
    user: AuthUser,
    stockLevelId: string,
    dto: UploadSaleImageDto,
  ) {
    await this.assertSaleShop(user.tenantId);
    const level = await this.prisma.stockLevel.findFirst({
      where: { id: stockLevelId, tenantId: user.tenantId },
      include: { product: true },
    });
    if (!level) throw new NotFoundException('Product not found');
    if (level.product.fulfillmentMode !== FulfillmentMode.sale) {
      throw new BadRequestException('Not a sale product');
    }

    const photoUrl = await saveProductImage(user.tenantId, dto.imageBase64);
    await this.prisma.product.update({
      where: { id: level.productId },
      data: { photoUrl },
    });

    return this.getSaleProduct(user, stockLevelId);
  }

  async listSaleCategories(user: AuthUser) {
    await this.assertSaleShop(user.tenantId);
    const rows = await this.prisma.category.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        _count: { select: { products: true } },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      productCount: c._count.products,
    }));
  }

  async renameSaleCategory(
    user: AuthUser,
    id: string,
    dto: RenameSaleCategoryDto,
  ) {
    await this.assertSaleShop(user.tenantId);
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

  /** Recent closed sale tickets for the floor */
  async listRecentSales(user: AuthUser, limit = 20) {
    await this.assertSaleShop(user.tenantId);
    const take = Math.min(Math.max(limit, 1), 50);
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        status: { in: [OrderStatus.closed, OrderStatus.fulfilled] },
      },
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
        _count: { select: { items: true } },
      },
    });
    return {
      items: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        subtotal: o.subtotal,
        balanceDue: o.balanceDue,
        createdAt: o.createdAt,
        customerName: o.customer?.fullName ?? 'Walk-in',
        itemCount: o._count.items,
      })),
    };
  }

  private async assertSaleShop(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { settings: true },
    });
    const parsed = parseCommerceModes(tenant.settings);
    if (!parsed.setupComplete) {
      throw new BadRequestException('Shop commerce is not ready');
    }
    if (!parsed.modes.includes('sale')) {
      throw new BadRequestException(
        'Sale POS is not enabled for this shop',
      );
    }
  }

  /**
   * Cashiers are capped by settings.pos.maxCashierDiscountPercent (default 15).
   * Admin/manager may exceed the cap (audited on order meta).
   */
  private assertDiscountAllowed(
    user: AuthUser,
    settings: unknown,
    discountAmount: number | undefined,
    merchandiseSubtotal: number,
  ) {
    if (discountAmount === undefined || discountAmount <= 0) return;
    if (merchandiseSubtotal <= 0) {
      throw new BadRequestException('Cannot discount an empty sale');
    }
    if (discountAmount > merchandiseSubtotal + 1e-9) {
      throw new BadRequestException('Discount cannot exceed merchandise subtotal');
    }

    const root =
      settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>)
        : {};
    const pos =
      root.pos && typeof root.pos === 'object'
        ? (root.pos as Record<string, unknown>)
        : {};
    const cap =
      typeof pos.maxCashierDiscountPercent === 'number' &&
      Number.isFinite(pos.maxCashierDiscountPercent)
        ? Math.min(100, Math.max(0, pos.maxCashierDiscountPercent))
        : 15;

    const pct = (discountAmount / merchandiseSubtotal) * 100;
    const isLead = user.roles.some((r) => r === 'admin' || r === 'manager');
    if (pct > cap + 1e-6 && !isLead) {
      throw new BadRequestException(
        `Discount ${pct.toFixed(1)}% exceeds cashier limit of ${cap}%. Ask a manager.`,
      );
    }
  }

  /**
   * Retail catalog for the counter — searchable stock levels at a location.
   */
  async saleCatalog(
    user: AuthUser,
    opts: {
      locationId?: string;
      q?: string;
      limit?: number;
      lowStock?: boolean;
      maxQty?: number;
    },
  ) {
    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    const limit = Math.min(Math.max(opts.limit ?? 80, 1), 200);
    const q = opts.q?.trim();
    const threshold = Math.min(Math.max(opts.maxQty ?? 5, 1), 100);

    const where: Prisma.StockLevelWhereInput = {
      tenantId: user.tenantId,
      locationId,
      qtyOnHand: opts.lowStock
        ? { gt: 0, lte: threshold }
        : { gt: 0 },
      AND: [
        {
          product: {
            fulfillmentMode: FulfillmentMode.sale,
            isActive: true,
          },
        },
        ...(q
          ? [
              {
                OR: [
                  { sku: { contains: q, mode: 'insensitive' as const } },
                  {
                    product: {
                      name: { contains: q, mode: 'insensitive' as const },
                    },
                  },
                  {
                    product: {
                      skuCode: { contains: q, mode: 'insensitive' as const },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };

    const items = await this.prisma.stockLevel.findMany({
      where,
      take: limit,
      orderBy: [{ product: { name: 'asc' } }, { sku: 'asc' }],
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            description: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
          },
        },
        location: { select: { id: true, name: true, code: true } },
      },
    });

    return {
      locationId,
      lowStock: Boolean(opts.lowStock),
      maxQty: opts.lowStock ? threshold : undefined,
      items: items.map((row) => ({
        id: row.id,
        sku: row.sku,
        sellPrice: row.sellPrice,
        qtyOnHand: row.qtyOnHand,
        lowStock: row.qtyOnHand > 0 && row.qtyOnHand <= threshold,
        name: row.product.name,
        productSku: row.product.skuCode,
        description: row.product.description,
        image: row.product.photoUrl,
        photoUrl: row.product.photoUrl,
        category: row.product.category,
        location: row.location,
      })),
    };
  }

  /** Exact SKU / barcode scan for sale POS */
  async saleLookup(
    user: AuthUser,
    opts: { sku: string; locationId?: string },
  ) {
    const sku = opts.sku.trim().toUpperCase();
    if (!sku) throw new BadRequestException('sku is required');

    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locationId) throw new BadRequestException('No location configured');

    const row = await this.prisma.stockLevel.findFirst({
      where: {
        tenantId: user.tenantId,
        locationId,
        sku: { equals: sku, mode: 'insensitive' },
        product: {
          fulfillmentMode: FulfillmentMode.sale,
          isActive: true,
        },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            photoUrl: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!row) throw new NotFoundException(`SKU not found: ${sku}`);
    if (row.qtyOnHand < 1) {
      throw new BadRequestException(`Out of stock: ${sku}`);
    }

    return {
      id: row.id,
      sku: row.sku,
      sellPrice: row.sellPrice,
      qtyOnHand: row.qtyOnHand,
      name: row.product.name,
      productSku: row.product.skuCode,
      image: row.product.photoUrl,
      photoUrl: row.product.photoUrl,
      category: row.product.category,
    };
  }

  /**
   * Unpaid sale ticket for Stripe card/UPI.
   * Stock is NOT decremented until Stripe verify succeeds.
   */
  async prepareSaleCheckout(user: AuthUser, dto: PrepareSaleCheckoutDto) {
    await this.assertSaleShop(user.tenantId);

    const loc = await this.prisma.location.findFirst({
      where: {
        id: dto.locationId,
        tenantId: user.tenantId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: {
          id: dto.customerId,
          tenantId: user.tenantId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');
    }

    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { currencyCode: true, taxMode: true, taxId: true, settings: true },
    });
    const taxProfile = buildTaxProfile({
      taxMode: tenant.taxMode,
      taxId: tenant.taxId,
      settings: tenant.settings,
    });

    const orderCount = await this.prisma.order.count({
      where: { tenantId: user.tenantId },
    });
    const orderNumber = `ORD-${String(orderCount + 1).padStart(5, '0')}`;

    const orderId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          customerId: dto.customerId,
          orderNumber,
          kind: OrderKind.sale,
          status: OrderStatus.confirmed,
          createdById: user.userId,
          currencyCode: tenant.currencyCode,
          meta: {
            awaitingStripePayment: true,
            taxSnapshot: {
              rate: taxProfile.rate,
              inclusive: taxProfile.inclusive,
              taxMode: taxProfile.taxMode,
              taxId: taxProfile.taxId,
            },
            ...(dto.note ? { note: dto.note } : {}),
          },
          ...(dto.discountAmount !== undefined && dto.discountAmount > 0
            ? { discountTotal: money(dto.discountAmount).toFixed(2) }
            : {}),
        },
      });

      for (const line of dto.items) {
        const level = await tx.stockLevel.findFirst({
          where: {
            id: line.stockLevelId,
            tenantId: user.tenantId,
            locationId: dto.locationId,
          },
          include: { product: true },
        });
        if (!level) {
          throw new NotFoundException(
            `Stock level not found: ${line.stockLevelId}`,
          );
        }
        if (level.qtyOnHand < line.quantity) {
          throw new BadRequestException(
            `Insufficient stock for ${level.sku} (have ${level.qtyOnHand}, need ${line.quantity})`,
          );
        }

        const unitPrice =
          line.unitPrice !== undefined
            ? money(line.unitPrice)
            : money(level.sellPrice);
        const lineGross = unitPrice.mul(line.quantity);
        const taxed = computeLineTax(taxProfile, { lineGross });

        await tx.orderItem.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: line.quantity,
            unitPrice: unitPrice.toFixed(2),
            lineTotal: taxed.lineTotal.toFixed(2),
            taxAmount: taxed.taxAmount.toFixed(2),
            meta: {
              taxRate: taxProfile.rate,
              taxInclusive: taxProfile.inclusive,
            },
          },
        });
      }

      const lineSum = await tx.orderItem.aggregate({
        where: { orderId: created.id, tenantId: user.tenantId },
        _sum: { lineTotal: true },
      });
      const merchandise = Number(lineSum._sum.lineTotal ?? 0);
      this.assertDiscountAllowed(
        user,
        tenant.settings,
        dto.discountAmount,
        merchandise,
      );
      if (
        dto.discountAmount !== undefined &&
        dto.discountAmount > 0 &&
        user.roles.some((r) => r === 'admin' || r === 'manager')
      ) {
        const root =
          tenant.settings && typeof tenant.settings === 'object'
            ? (tenant.settings as Record<string, unknown>)
            : {};
        const pos =
          root.pos && typeof root.pos === 'object'
            ? (root.pos as Record<string, unknown>)
            : {};
        const cap =
          typeof pos.maxCashierDiscountPercent === 'number'
            ? pos.maxCashierDiscountPercent
            : 15;
        const pct = (dto.discountAmount / merchandise) * 100;
        if (pct > cap + 1e-6) {
          await tx.order.update({
            where: { id: created.id },
            data: {
              meta: {
                awaitingStripePayment: true,
                ...(dto.note ? { note: dto.note } : {}),
                taxSnapshot: {
                  rate: taxProfile.rate,
                  inclusive: taxProfile.inclusive,
                  taxMode: taxProfile.taxMode,
                  taxId: taxProfile.taxId,
                },
                discountOverride: {
                  byUserId: user.userId,
                  percent: pct,
                  cap,
                },
              },
            },
          });
        }
      }

      await this.ordersService.recalculateTotals(
        tx,
        user.tenantId,
        created.id,
      );

      const after = await tx.order.findFirstOrThrow({
        where: { id: created.id },
        select: { balanceDue: true },
      });
      if (money(after.balanceDue).lte(0)) {
        throw new BadRequestException('Sale total must be greater than 0');
      }

      return created.id;
    });

    const order = await this.loadOrder(user.tenantId, orderId);
    return {
      orderId,
      orderNumber: order!.orderNumber,
      balanceDue: order!.balanceDue,
      currencyCode: order!.currencyCode,
      awaitingStripePayment: true,
    };
  }

  async cancelPreparedSale(user: AuthUser, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId, kind: OrderKind.sale },
    });
    if (!order) throw new NotFoundException('Order not found');
    const meta = (order.meta ?? {}) as Record<string, unknown>;
    if (!meta.awaitingStripePayment) {
      throw new BadRequestException('Order is not an unpaid Stripe sale');
    }
    if (order.status === OrderStatus.closed) {
      throw new BadRequestException('Order already closed');
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.cancelled,
        meta: { ...meta, awaitingStripePayment: false, cancelledStripe: true },
      },
    });
    return { id: orderId, status: OrderStatus.cancelled };
  }

  /**
   * After Stripe payment succeeds — decrement stock and close sale ticket.
   * Safe to call only when meta.awaitingStripePayment is true.
   */
  async finalizeStripeSale(user: AuthUser, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: user.tenantId, kind: OrderKind.sale },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const meta = (order.meta ?? {}) as Record<string, unknown>;
    if (!meta.awaitingStripePayment) {
      return this.getReceipt(user, orderId);
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        if (!item.stockLevelId) continue;
        const qty = Number(item.quantity);
        const level = await tx.stockLevel.findFirst({
          where: { id: item.stockLevelId, tenantId: user.tenantId },
        });
        if (!level) {
          throw new NotFoundException(`Stock level missing for line ${item.id}`);
        }
        if (level.qtyOnHand < qty) {
          throw new BadRequestException(
            `Insufficient stock for ${level.sku} after payment (have ${level.qtyOnHand})`,
          );
        }
        await tx.stockLevel.update({
          where: { id: level.id },
          data: { qtyOnHand: { decrement: qty } },
        });
      }

      await this.ordersService.recalculateTotals(tx, user.tenantId, orderId);
      const final = await tx.order.findFirstOrThrow({
        where: { id: orderId },
        select: { balanceDue: true },
      });
      if (money(final.balanceDue).gt(0)) {
        throw new BadRequestException(
          `Sale still has balance due ${final.balanceDue}`,
        );
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.fulfilled,
          meta: { ...meta, awaitingStripePayment: false },
        },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.closed },
      });

      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'pos.sale.completed',
          aggregateType: 'order',
          aggregateId: orderId,
          payload: { orderId, via: 'stripe' },
        },
      });
    });

    return this.getReceipt(user, orderId);
  }

  /**
   * Atomic retail checkout — cart → paid closed sale in one call.
   * Stock decrements only if payment succeeds (same transaction).
   */
  async saleCheckout(user: AuthUser, dto: SaleCheckoutDto) {
    await this.assertSaleShop(user.tenantId);

    const loc = await this.prisma.location.findFirst({
      where: {
        id: dto.locationId,
        tenantId: user.tenantId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: {
          id: dto.customerId,
          tenantId: user.tenantId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');
    }

    const payTotal = dto.payments.reduce((s, p) => s + Number(p.amount), 0);
    if (payTotal <= 0) {
      throw new BadRequestException('Payment amount must be greater than 0');
    }

    const hasCash = dto.payments.some((p) => p.method === PaymentMethod.cash);
    if (hasCash && dto.cashTendered !== undefined) {
      if (Number(dto.cashTendered) + 1e-9 < payTotal) {
        throw new BadRequestException(
          'Cash tendered is less than payment total',
        );
      }
    }

    // Idempotency: if primary key already paid a closed sale, return it
    const primaryKey = dto.payments[0]?.idempotencyKey;
    if (primaryKey) {
      const existingPay = await this.prisma.payment.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: user.tenantId,
            idempotencyKey: primaryKey,
          },
        },
      });
      if (existingPay) {
        const receipt = await this.getReceipt(user, existingPay.orderId);
        const order = await this.loadOrder(user.tenantId, existingPay.orderId);
        return {
          order,
          payments: [existingPay],
          change: money(0).toFixed(2),
          cashTendered: dto.cashTendered?.toFixed(2) ?? null,
          receipt,
          replayed: true,
        };
      }
    }

    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { currencyCode: true, taxMode: true, taxId: true, settings: true },
    });
    const taxProfile = buildTaxProfile({
      taxMode: tenant.taxMode,
      taxId: tenant.taxId,
      settings: tenant.settings,
    });

    const orderCount = await this.prisma.order.count({
      where: { tenantId: user.tenantId },
    });
    const orderNumber = `ORD-${String(orderCount + 1).padStart(5, '0')}`;

    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
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
            ...(dto.note ? { note: dto.note } : {}),
            taxSnapshot: {
              rate: taxProfile.rate,
              inclusive: taxProfile.inclusive,
              taxMode: taxProfile.taxMode,
              taxId: taxProfile.taxId,
            },
          },
        },
      });

      for (const line of dto.items) {
        const level = await tx.stockLevel.findFirst({
          where: {
            id: line.stockLevelId,
            tenantId: user.tenantId,
            locationId: dto.locationId,
          },
          include: { product: true },
        });
        if (!level) {
          throw new NotFoundException(
            `Stock level not found: ${line.stockLevelId}`,
          );
        }
        if (level.qtyOnHand < line.quantity) {
          throw new BadRequestException(
            `Insufficient stock for ${level.sku} (have ${level.qtyOnHand}, need ${line.quantity})`,
          );
        }

        const unitPrice =
          line.unitPrice !== undefined
            ? money(line.unitPrice)
            : money(level.sellPrice);
        const lineGross = unitPrice.mul(line.quantity);
        const taxed = computeLineTax(taxProfile, { lineGross });

        await tx.stockLevel.update({
          where: { id: level.id },
          data: { qtyOnHand: { decrement: line.quantity } },
        });

        await tx.orderItem.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: line.quantity,
            unitPrice: unitPrice.toFixed(2),
            lineTotal: taxed.lineTotal.toFixed(2),
            taxAmount: taxed.taxAmount.toFixed(2),
            meta: {
              taxRate: taxProfile.rate,
              taxInclusive: taxProfile.inclusive,
            },
          },
        });
      }

      const lineSum = await tx.orderItem.aggregate({
        where: { orderId: created.id, tenantId: user.tenantId },
        _sum: { lineTotal: true },
      });
      const merchandise = Number(lineSum._sum.lineTotal ?? 0);
      this.assertDiscountAllowed(
        user,
        tenant.settings,
        dto.discountAmount,
        merchandise,
      );

      if (dto.discountAmount !== undefined && dto.discountAmount > 0) {
        const root =
          tenant.settings && typeof tenant.settings === 'object'
            ? (tenant.settings as Record<string, unknown>)
            : {};
        const pos =
          root.pos && typeof root.pos === 'object'
            ? (root.pos as Record<string, unknown>)
            : {};
        const cap =
          typeof pos.maxCashierDiscountPercent === 'number'
            ? pos.maxCashierDiscountPercent
            : 15;
        const pct = (dto.discountAmount / merchandise) * 100;
        const override =
          pct > cap + 1e-6 &&
          user.roles.some((r) => r === 'admin' || r === 'manager')
            ? {
                discountOverride: {
                  byUserId: user.userId,
                  percent: pct,
                  cap,
                },
              }
            : {};

        await tx.order.update({
          where: { id: created.id },
          data: {
            discountTotal: money(dto.discountAmount).toFixed(2),
            ...(Object.keys(override).length
              ? {
                  meta: {
                    ...(dto.note ? { note: dto.note } : {}),
                    taxSnapshot: {
                      rate: taxProfile.rate,
                      inclusive: taxProfile.inclusive,
                      taxMode: taxProfile.taxMode,
                      taxId: taxProfile.taxId,
                    },
                    ...override,
                  },
                }
              : {}),
          },
        });
      }

      await this.ordersService.recalculateTotals(
        tx,
        user.tenantId,
        created.id,
      );

      const afterLines = await tx.order.findFirstOrThrow({
        where: { id: created.id },
        select: { balanceDue: true, subtotal: true },
      });
      const due = money(afterLines.balanceDue);
      if (due.lte(0)) {
        throw new BadRequestException('Sale total must be greater than 0');
      }

      const paidSum = money(payTotal);
      if (paidSum.lt(due)) {
        throw new BadRequestException(
          `Payment ${paidSum.toFixed(2)} is less than balance due ${due.toFixed(2)}`,
        );
      }

      const payments = [];
      for (const p of dto.payments) {
        const status = IMMEDIATE_PAY.includes(p.method)
          ? PaymentStatus.succeeded
          : PaymentStatus.pending;
        const payment = await tx.payment.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            type: p.type ?? PaymentType.payment,
            method: p.method,
            amount: money(p.amount).toFixed(2),
            status,
            idempotencyKey: p.idempotencyKey,
            takenByUserId: user.userId,
          },
        });
        payments.push(payment);
      }

      await this.ordersService.recalculateTotals(
        tx,
        user.tenantId,
        created.id,
      );

      const final = await tx.order.findFirstOrThrow({
        where: { id: created.id },
        select: { balanceDue: true },
      });

      // Fully paid retail sale → fulfilled → closed
      if (money(final.balanceDue).lte(0)) {
        await tx.order.update({
          where: { id: created.id },
          data: { status: OrderStatus.fulfilled },
        });
        await tx.order.update({
          where: { id: created.id },
          data: { status: OrderStatus.closed },
        });
      } else {
        await tx.order.update({
          where: { id: created.id },
          data: { status: OrderStatus.confirmed },
        });
      }

      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'pos.sale.completed',
          aggregateType: 'order',
          aggregateId: created.id,
          payload: {
            orderId: created.id,
            orderNumber,
            payTotal,
          },
        },
      });

      return { orderId: created.id, payments };
    });

    const order = await this.loadOrder(user.tenantId, result.orderId);
    const receipt = await this.getReceipt(user, result.orderId);

    const cashPaid = dto.payments
      .filter((p) => p.method === PaymentMethod.cash)
      .reduce((s, p) => s + Number(p.amount), 0);
    const tendered =
      dto.cashTendered !== undefined ? Number(dto.cashTendered) : cashPaid;
    const change = Math.max(0, tendered - cashPaid);

    return {
      order,
      payments: result.payments,
      change: money(change).toFixed(2),
      cashTendered: money(tendered).toFixed(2),
      receipt,
      replayed: false,
    };
  }

  async checkout(user: AuthUser, dto: CheckoutDto) {
    const order = await this.prisma.order.findFirst({
      where: { id: dto.orderId, tenantId: user.tenantId },
      include: { items: true, rentalExt: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    this.assertReadyForCheckout(order);

    const payments = [];
    for (const paymentDto of dto.payments) {
      const payment = await this.paymentsService.create(user, {
        orderId: dto.orderId,
        method: paymentDto.method,
        amount: paymentDto.amount,
        type: paymentDto.type,
        idempotencyKey: paymentDto.idempotencyKey,
      });
      payments.push(payment);
    }

    const refreshed = await this.prisma.order.findFirstOrThrow({
      where: { id: order.id },
      select: { status: true, balanceDue: true, kind: true },
    });

    // Sale: close when fully paid
    if (
      refreshed.kind === OrderKind.sale &&
      money(refreshed.balanceDue).lte(0) &&
      refreshed.status !== OrderStatus.closed &&
      refreshed.status !== OrderStatus.cancelled
    ) {
      if (
        refreshed.status === OrderStatus.draft ||
        refreshed.status === OrderStatus.quoted
      ) {
        await this.prisma.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.confirmed },
        });
      }
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.fulfilled },
      });
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.closed },
      });
    } else if (dto.markReady && READY_FROM.includes(refreshed.status)) {
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.ready },
      });
    }

    const finalOrder = await this.loadOrder(user.tenantId, dto.orderId);
    return { order: finalOrder, payments };
  }

  async getReceipt(user: AuthUser, orderId: string) {
    const order = await this.loadOrder(user.tenantId, orderId);
    if (!order) throw new NotFoundException('Order not found');

    const succeededPayments = order.payments.filter(
      (p) => p.status === 'succeeded',
    );

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      kind: order.kind,
      store: {
        name: order.location.name,
        code: order.location.code,
        address: order.location.address,
      },
      location: order.location,
      customer: order.customer
        ? {
            fullName: order.customer.fullName,
            phone: order.customer.phone,
            email: order.customer.email,
          }
        : null,
      items: order.items.map((item) => ({
        id: item.id,
        itemType: item.itemKind,
        itemKind: item.itemKind,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxAmount: item.taxAmount,
        lineTotal: item.lineTotal,
        inventoryUnit: item.stockUnit
          ? {
              barcodeSku: item.stockUnit.barcodeSku,
              size: item.stockUnit.variantLabel,
            }
          : null,
        retailSku: item.stockLevel
          ? { sku: item.stockLevel.sku }
          : null,
        product: item.product
          ? { name: item.product.name, skuCode: item.product.skuCode }
          : null,
      })),
      totals: {
        subtotal: order.subtotal,
        taxTotal: order.taxTotal,
        depositTotal: order.depositTotal,
        balanceDue: order.balanceDue,
      },
      payments: succeededPayments.map((p) => ({
        id: p.id,
        type: p.type,
        method: p.method,
        amount: p.amount,
        createdAt: p.createdAt,
      })),
      printedAt: new Date(),
    };
  }

  /**
   * Park / hold cart — draft sale, stock NOT decremented.
   */
  async parkSale(user: AuthUser, dto: ParkSaleDto) {
    await this.assertSaleShop(user.tenantId);
    const loc = await this.prisma.location.findFirst({
      where: {
        id: dto.locationId,
        tenantId: user.tenantId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: {
          id: dto.customerId,
          tenantId: user.tenantId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');
    }

    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { currencyCode: true },
    });
    const orderCount = await this.prisma.order.count({
      where: { tenantId: user.tenantId },
    });
    const orderNumber = `ORD-${String(orderCount + 1).padStart(5, '0')}`;

    const orderId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
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
            label: dto.label?.trim() || null,
            note: dto.note?.trim() || null,
          },
        },
      });

      for (const line of dto.items) {
        const level = await tx.stockLevel.findFirst({
          where: {
            id: line.stockLevelId,
            tenantId: user.tenantId,
            locationId: dto.locationId,
          },
          include: { product: true },
        });
        if (!level) {
          throw new NotFoundException(
            `Stock level not found: ${line.stockLevelId}`,
          );
        }
        const unitPrice =
          line.unitPrice !== undefined
            ? money(line.unitPrice)
            : money(level.sellPrice);
        const lineTotal = unitPrice.mul(line.quantity);
        await tx.orderItem.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: line.quantity,
            unitPrice: unitPrice.toFixed(2),
            lineTotal: lineTotal.toFixed(2),
          },
        });
      }

      if (dto.discountAmount !== undefined && dto.discountAmount > 0) {
        await tx.order.update({
          where: { id: created.id },
          data: { discountTotal: money(dto.discountAmount).toFixed(2) },
        });
      }

      await this.paymentsService.recalculateBalance(
        tx,
        user.tenantId,
        created.id,
      );
      return created.id;
    });

    const loaded = await this.loadOrder(user.tenantId, orderId);
    if (!loaded) throw new NotFoundException('Parked sale not found');
    return this.mapParked(loaded);
  }

  async listParkedSales(user: AuthUser, locationId?: string) {
    await this.assertSaleShop(user.tenantId);
    const rows = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        status: OrderStatus.draft,
        ...(locationId ? { locationId } : {}),
        meta: { path: ['parked'], equals: true },
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        customer: { select: { id: true, fullName: true, phone: true } },
        items: {
          include: {
            stockLevel: { select: { id: true, sku: true, qtyOnHand: true } },
            product: { select: { id: true, name: true } },
          },
        },
      },
    });
    return { items: rows.map((o) => this.mapParked(o)) };
  }

  async resumeParkedSale(user: AuthUser, orderId: string) {
    await this.assertSaleShop(user.tenantId);
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        status: OrderStatus.draft,
      },
      include: {
        customer: { select: { id: true, fullName: true, phone: true } },
        items: {
          include: {
            stockLevel: {
              select: {
                id: true,
                sku: true,
                qtyOnHand: true,
                sellPrice: true,
              },
            },
            product: { select: { id: true, name: true, skuCode: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException('Parked sale not found');
    const meta = (order.meta ?? {}) as Record<string, unknown>;
    if (meta.parked !== true) {
      throw new BadRequestException('Order is not a parked sale');
    }

    return {
      ...this.mapParked(order),
      cart: order.items
        .filter((i) => i.stockLevelId)
        .map((i) => ({
          stockLevelId: i.stockLevelId!,
          sku: i.stockLevel?.sku ?? i.product?.skuCode ?? '',
          name: i.description ?? i.product?.name ?? 'Item',
          unitPrice: Number(i.unitPrice),
          qty: Number(i.quantity),
          maxQty: Number(i.stockLevel?.qtyOnHand ?? i.quantity),
        })),
      discountAmount: Number(order.discountTotal),
      customerId: order.customerId,
      locationId: order.locationId,
      note: typeof meta.note === 'string' ? meta.note : null,
    };
  }

  async discardParkedSale(user: AuthUser, orderId: string) {
    await this.assertSaleShop(user.tenantId);
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        status: OrderStatus.draft,
      },
    });
    if (!order) throw new NotFoundException('Parked sale not found');
    const meta = (order.meta ?? {}) as Record<string, unknown>;
    if (meta.parked !== true) {
      throw new BadRequestException('Order is not a parked sale');
    }
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.cancelled,
        meta: { ...meta, parked: false, discardedAt: new Date().toISOString() },
      },
    });
    return { id: orderId, status: 'cancelled' };
  }

  async openRegister(user: AuthUser, dto: OpenRegisterDto) {
    await this.assertSaleShop(user.tenantId);
    const loc = await this.prisma.location.findFirst({
      where: {
        id: dto.locationId,
        tenantId: user.tenantId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    const open = await this.prisma.registerSession.findFirst({
      where: {
        tenantId: user.tenantId,
        locationId: dto.locationId,
        closedAt: null,
      },
    });
    if (open) {
      throw new BadRequestException('Register already open at this location');
    }

    const session = await this.prisma.registerSession.create({
      data: {
        tenantId: user.tenantId,
        locationId: dto.locationId,
        openedById: user.userId,
        openingFloat: money(dto.openingFloat ?? 0).toFixed(2),
      },
    });
    return session;
  }

  async currentRegister(user: AuthUser, locationId?: string) {
    await this.assertSaleShop(user.tenantId);
    const locId = locationId ?? (await this.defaultLocationId(user.tenantId));
    if (!locId) throw new BadRequestException('No location configured');
    const session = await this.prisma.registerSession.findFirst({
      where: {
        tenantId: user.tenantId,
        locationId: locId,
        closedAt: null,
      },
      orderBy: { openedAt: 'desc' },
    });
    return { session, locationId: locId };
  }

  async closeRegister(
    user: AuthUser,
    sessionId: string,
    dto: CloseRegisterDto,
  ) {
    await this.assertSaleShop(user.tenantId);
    const session = await this.prisma.registerSession.findFirst({
      where: { id: sessionId, tenantId: user.tenantId, closedAt: null },
    });
    if (!session) throw new NotFoundException('Open register not found');

    const cashSales = await this.prisma.payment.aggregate({
      where: {
        tenantId: user.tenantId,
        method: PaymentMethod.cash,
        type: PaymentType.payment,
        status: PaymentStatus.succeeded,
        createdAt: { gte: session.openedAt },
        order: { locationId: session.locationId, kind: OrderKind.sale },
      },
      _sum: { amount: true },
    });
    const expected =
      Number(session.openingFloat) + Number(cashSales._sum.amount ?? 0);
    const counted = Number(dto.closingCash);
    const variance = counted - expected;

    return this.prisma.registerSession.update({
      where: { id: sessionId },
      data: {
        closingCash: money(counted).toFixed(2),
        closedAt: new Date(),
        meta: {
          ...((session.meta as object) ?? {}),
          expectedCash: expected,
          cashSales: Number(cashSales._sum.amount ?? 0),
          variance,
          note: dto.note?.trim() || null,
          closedById: user.userId,
        },
      },
    }).then((row) => ({
      ...row,
      zReport: {
        openedAt: session.openedAt,
        closedAt: row.closedAt,
        openingFloat: Number(session.openingFloat),
        cashSales: Number(cashSales._sum.amount ?? 0),
        expectedCash: expected,
        closingCash: counted,
        variance,
      },
    }));
  }

  /**
   * Qty return for closed sale — restock levels + cash/card refund payment.
   */
  async saleReturn(user: AuthUser, dto: SaleReturnDto) {
    await this.assertSaleShop(user.tenantId);
    const order = await this.prisma.order.findFirst({
      where: {
        id: dto.orderId,
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        status: OrderStatus.closed,
      },
      include: {
        items: true,
        payments: true,
      },
    });
    if (!order) throw new NotFoundException('Closed sale not found');

    const existingPay = await this.prisma.payment.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: user.tenantId,
          idempotencyKey: dto.idempotencyKey,
        },
      },
    });
    if (existingPay) {
      return {
        orderId: order.id,
        refundPaymentId: existingPay.id,
        replayed: true,
      };
    }

    let refundCalc = money(0);
    const lines: Array<{
      stockLevelId: string;
      quantity: number;
      unitPrice: Prisma.Decimal;
    }> = [];

    for (const ret of dto.items) {
      const sold = order.items.filter(
        (i) =>
          i.stockLevelId === ret.stockLevelId &&
          i.itemKind === OrderItemKind.product,
      );
      if (!sold.length) {
        throw new BadRequestException(
          `Item ${ret.stockLevelId} was not on this sale`,
        );
      }
      const soldQty = sold.reduce((s, i) => s + Number(i.quantity), 0);
      if (ret.quantity > soldQty) {
        throw new BadRequestException(
          `Cannot return ${ret.quantity} (sold ${soldQty})`,
        );
      }
      const unitPrice = money(sold[0].unitPrice);
      refundCalc = refundCalc.add(unitPrice.mul(ret.quantity));
      lines.push({
        stockLevelId: ret.stockLevelId,
        quantity: ret.quantity,
        unitPrice,
      });
    }

    const refundAmount =
      dto.amount !== undefined ? money(dto.amount) : refundCalc;
    if (refundAmount.lte(0)) {
      throw new BadRequestException('Refund amount must be > 0');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      for (const line of lines) {
        await tx.stockLevel.update({
          where: { id: line.stockLevelId },
          data: { qtyOnHand: { increment: line.quantity } },
        });
      }

      await tx.returnEvent.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          receivedById: user.userId,
          notes:
            dto.reason?.trim() ||
            `Sale return: ${lines.map((l) => `${l.quantity}×${l.stockLevelId.slice(0, 8)}`).join(', ')}`,
        },
      });

      const payment = await tx.payment.create({
        data: {
          tenantId: user.tenantId,
          orderId: order.id,
          type: PaymentType.refund,
          method: dto.refundMethod,
          amount: refundAmount.toFixed(2),
          status: PaymentStatus.succeeded,
          idempotencyKey: dto.idempotencyKey,
          takenByUserId: user.userId,
        },
      });

      await this.paymentsService.recalculateBalance(
        tx,
        user.tenantId,
        order.id,
      );

      return payment;
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      refundPaymentId: result.id,
      amount: result.amount,
      restocked: lines.map((l) => ({
        stockLevelId: l.stockLevelId,
        quantity: l.quantity,
      })),
    };
  }

  private mapParked(order: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    balanceDue: Prisma.Decimal | string | number;
    discountTotal: Prisma.Decimal | string | number;
    subtotal: Prisma.Decimal | string | number;
    locationId: string;
    customerId: string | null;
    meta: unknown;
    createdAt?: Date;
    updatedAt?: Date;
    customer?: {
      id: string;
      fullName: string;
      phone: string;
    } | null;
    items?: unknown[];
  }) {
    const meta = (order.meta ?? {}) as Record<string, unknown>;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      locationId: order.locationId,
      customerId: order.customerId,
      customerName: order.customer?.fullName ?? 'Walk-in',
      label: typeof meta.label === 'string' ? meta.label : null,
      note: typeof meta.note === 'string' ? meta.note : null,
      itemCount: Array.isArray(order.items) ? order.items.length : undefined,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      balanceDue: order.balanceDue,
      updatedAt: order.updatedAt,
      createdAt: order.createdAt,
    };
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

  private loadOrder(tenantId: string, orderId: string) {
    return this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      include: {
        customer: {
          select: { id: true, fullName: true, phone: true, email: true },
        },
        location: {
          select: { id: true, name: true, code: true, address: true },
        },
        items: {
          include: {
            stockUnit: {
              select: { id: true, barcodeSku: true, variantLabel: true },
            },
            stockLevel: { select: { id: true, sku: true } },
            product: { select: { id: true, name: true, skuCode: true } },
          },
        },
        fees: true,
        payments: { orderBy: { createdAt: 'desc' as const } },
        rentalExt: true,
      },
    });
  }

  private assertReadyForCheckout(order: {
    items: Array<{
      itemKind: OrderItemKind;
      stockUnitId: string | null;
    }>;
    rentalExt: {
      pickupDate: Date | null;
      returnDueDate: Date | null;
    } | null;
  }) {
    const hasRental = order.items.some(
      (i) => i.itemKind === OrderItemKind.stock_unit,
    );
    if (!hasRental || !order.rentalExt) return;

    if (!order.rentalExt.pickupDate || !order.rentalExt.returnDueDate) {
      throw new BadRequestException(
        'pickupDate and returnDueDate are required before checkout for rental orders',
      );
    }
    const missing = order.items.some(
      (i) => i.itemKind === OrderItemKind.stock_unit && !i.stockUnitId,
    );
    if (missing) {
      throw new BadRequestException(
        'Every rental stock unit line must have a stockUnitId',
      );
    }
  }
}
