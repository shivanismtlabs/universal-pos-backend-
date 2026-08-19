import {
  BadRequestException,
  ForbiddenException,
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
    ProductKind,
    ProductStatus,
    RegisterCashMovementKind,
    StockLedgerType,
} from '@prisma/client';
import {
  SALE_PRODUCT_FIELDS,
  getCommerceSchema,
  parseCommerceModes,
} from '../../common/commerce-schema';
import {
  normalizeQty,
  normalizeSellUnit,
  validateProductTitle,
  validateSellPrice,
  validateSellQty,
  validateSku,
} from '../../common/sell-units';
import { parseMeasureUnits } from '../../common/measure-units';
import { saveProductImage } from '../../common/product-image';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { nextInternalCode128Candidate } from '../../common/barcode';
import { resolveDefaultLocationId } from '../../common/location-access';
import { categoryIdsWithDescendants } from '../../common/category-tree';
import {
  seedZeroStockAtOtherLocations,
  seedZeroStockForNewLocation,
} from '../../common/stock-at-location';
import { LowStockAlertService } from '../notify/low-stock-alert.service';
import { StockMutationEngine } from '../inventory/stock-mutation.engine';

const MAX_PRODUCT_IMAGES = 8;

/** Items that belong on the billing counter (sale + service + rentable SKUs). */
const COUNTER_PRODUCT: Prisma.ProductWhereInput = {
  isActive: true,
  availableInPos: true,
  canSell: true,
  status: ProductStatus.active,
  kind: {
    in: [
      ProductKind.physical,
      ProductKind.service,
      ProductKind.digital,
      ProductKind.bundle,
      ProductKind.rental,
    ],
  },
};

function asMeta(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? { ...(meta as Record<string, unknown>) }
    : {};
}

function batchPickStrategy(meta: unknown): 'fefo' | 'fifo' | 'manual' {
  const s = String(asMeta(meta).batchPickStrategy ?? asMeta(meta).batchStrategy ?? 'fefo').toLowerCase();
  if (s === 'fifo' || s === 'manual') return s;
  return 'fefo';
}

function requiresManualBatch(trackBatch: boolean | undefined, meta: unknown): boolean {
  return trackBatch === true && batchPickStrategy(meta) === 'manual';
}

/** Gallery URLs from meta.images + cover photoUrl */
function productImageList(
  photoUrl: string | null | undefined,
  meta: unknown,
): string[] {
  const m = asMeta(meta);
  const fromMeta = Array.isArray(m.images)
    ? m.images.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : [];
  const urls: string[] = [];
  for (const u of fromMeta) {
    if (!urls.includes(u)) urls.push(u);
  }
  if (photoUrl?.trim() && !urls.includes(photoUrl.trim())) {
    urls.unshift(photoUrl.trim());
  }
  return urls;
}
import {
  buildTaxProfile,
  computeLineTax,
  resolveProductTaxRatePercent,
} from '../../common/tax-engine';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { AccountingPostingService } from '../accounting/posting.service';
import { EnterpriseApprovalsService } from '../enterprise/enterprise-approvals.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import {
  getPaymentMethodCapability,
  isInternalImmediate,
} from '../payments/payment-capabilities';
import { expectedCash, cashVariance } from '../payments/register-cash';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { NotifyService } from '../notify/notify.service';
import {
  AddSaleCategoryDto,
  AddSaleProductDto,
  AdjustSaleStockDto,
  CheckoutDto,
  CloseRegisterDto,
  ImportSaleProductsDto,
  OpenRegisterDto,
  ParkSaleDto,
  PrepareSaleCheckoutDto,
  RenameSaleCategoryDto,
  SaleCheckoutDto,
  UpdateSaleProductDto,
  UploadSaleImageDto,
} from './dto/pos.dto';

const READY_FROM: OrderStatus[] = [
  OrderStatus.confirmed,
  OrderStatus.in_progress,
];

function money(n: number | string | Prisma.Decimal) {
  return new Prisma.Decimal(n);
}

function posSettingsOf(settings: unknown): {
  customerRequired: boolean;
} {
  const root =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {};
  const pos =
    root.pos && typeof root.pos === 'object'
      ? (root.pos as Record<string, unknown>)
      : {};
  return {
    customerRequired: pos.customerRequired === true,
  };
}

@Injectable()
export class PosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
    private readonly ordersService: OrdersService,
    private readonly loyalty: LoyaltyService,
    private readonly notify: NotifyService,
    private readonly lowStock: LowStockAlertService,
    private readonly accounting: AccountingPostingService,
    private readonly approvals: EnterpriseApprovalsService,
    private readonly stock: StockMutationEngine,
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
    const locId = locationId ?? (await this.defaultLocationId(user.tenantId, user));
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
          ...COUNTER_PRODUCT,
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
    const name = dto.name.trim();
    let parentId: string | null = null;
    if (dto.parentId) {
      const parent = await this.prisma.category.findFirst({
        where: { id: dto.parentId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Parent category not found');
      parentId = parent.id;
    }
    try {
      return await this.prisma.category.create({
        data: {
          tenantId: user.tenantId,
          name,
          parentId,
        },
        select: { id: true, name: true, parentId: true },
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

    const titleErr = validateProductTitle(dto.title);
    if (titleErr) throw new BadRequestException(titleErr);
    const skuErr = validateSku(dto.sku);
    if (skuErr) throw new BadRequestException(skuErr);

    const sellUnit = normalizeSellUnit(dto.sellUnit);
    const units = await this.tenantUnits(user.tenantId);
    const price = Number(dto.price);
    const priceErr = validateSellPrice(price);
    if (priceErr) throw new BadRequestException(priceErr);

    const rawQty = Number(dto.qty);
    const qtyErr = validateSellQty(rawQty, sellUnit, units);
    if (qtyErr) throw new BadRequestException(qtyErr);
    const qty = normalizeQty(rawQty, sellUnit, units);

    const isServiceEarly = dto.itemType === 'service';
    const willTrack =
      isServiceEarly ? false : dto.trackInventory !== false;
    if (willTrack && qty < 1) {
      throw new BadRequestException(
        'Opening quantity must be at least 1 (not 0 or a fraction below 1)',
      );
    }

    const cat = await this.prisma.category.findFirst({
      where: { id: dto.categoryId, tenantId: user.tenantId },
      select: { id: true, name: true },
    });
    if (!cat) throw new NotFoundException('Category not found');

    let locationId = dto.locationId;
    if (!locationId) {
      locationId = (await this.defaultLocationId(user.tenantId, user)) ?? undefined;
    }
    if (!locationId) throw new BadRequestException('No location configured');

    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    const isService = dto.itemType === 'service';
    const trackInventory =
      isService ? false : dto.trackInventory !== false;
    const trackSerial = Boolean(dto.serialTracking) && !isService;

    let barcode = dto.barcode?.trim() || dto.upc?.trim() || null;
    let barcodeType: string | null = null;
    if (!barcode) {
      barcode = await this.allocateUniqueBarcode(user.tenantId);
      barcodeType = 'code128';
    } else {
      barcodeType = /^\d{13}$/.test(barcode)
        ? 'ean13'
        : /^\d{12}$/.test(barcode)
          ? 'upca'
          : 'code128';
    }

    try {
      let photoUrl: string | null = null;
      const rawImage = (dto.image ?? dto.photoUrl)?.trim();
      if (rawImage) {
        photoUrl = rawImage.startsWith('data:')
          ? await saveProductImage(user.tenantId, rawImage)
          : rawImage;
      }

      const product = await this.prisma.product.create({
        data: {
          tenantId: user.tenantId,
          categoryId: dto.categoryId,
          name: dto.title.trim(),
          skuCode: dto.sku.trim().toUpperCase(),
          description: dto.description?.trim(),
          photoUrl,
          kind: isService
            ? 'service'
            : dto.isComposite
              ? 'bundle'
              : 'physical',
          fulfillmentMode: FulfillmentMode.sale,
          trackQty: trackInventory,
          trackSerial,
          trackBatch: Boolean(dto.batchTracking) && !isService,
          basePrice: price,
          costPrice:
            dto.costPrice != null && Number.isFinite(dto.costPrice)
              ? Number(dto.costPrice)
              : null,
          barcode,
          barcodeType,
          taxCode:
            dto.taxPreference === 'non_taxable'
              ? null
              : dto.taxRatePercent != null &&
                  Number.isFinite(dto.taxRatePercent) &&
                  dto.taxRatePercent > 0
                ? `GST${Number(dto.taxRatePercent)}`
                : null,
          unitOfMeasure: sellUnit,
          canSell: true,
          canPurchase: !isService,
          availableInPos: true,
          status: 'active',
          isActive: true,
          meta: {
            sellUnit,
            itemType: isService ? 'service' : 'goods',
            itemStructure: dto.itemStructure === 'variants' ? 'variants' : 'single',
            ...(photoUrl ? { images: [photoUrl] } : {}),
            ...(dto.manufacturer?.trim()
              ? { manufacturer: dto.manufacturer.trim() }
              : {}),
            ...(dto.brand?.trim() ? { brand: dto.brand.trim() } : {}),
            ...(dto.barcode?.trim()
              ? { barcode: dto.barcode.trim() }
              : {}),
            ...(dto.upc?.trim()
              ? { upc: dto.upc.trim() }
              : dto.barcode?.trim()
                ? { upc: dto.barcode.trim() }
                : {}),
            ...(dto.ean?.trim() ? { ean: dto.ean.trim() } : {}),
            ...(dto.mpn?.trim() ? { mpn: dto.mpn.trim() } : {}),
            ...(dto.isbn?.trim() ? { isbn: dto.isbn.trim() } : {}),
            ...(dto.costPrice != null && Number.isFinite(dto.costPrice)
              ? { costPrice: Number(dto.costPrice) }
              : {}),
            ...(dto.reorderPoint != null && Number.isFinite(dto.reorderPoint)
              ? { reorderPoint: Number(dto.reorderPoint) }
              : {}),
            ...(dto.hsnOrSac?.trim()
              ? { hsnOrSac: dto.hsnOrSac.trim() }
              : {}),
            ...(dto.taxPreference
              ? { taxPreference: dto.taxPreference }
              : {}),
            ...(dto.taxRatePercent != null &&
            Number.isFinite(dto.taxRatePercent) &&
            dto.taxRatePercent > 0
              ? { taxRatePercent: Number(dto.taxRatePercent) }
              : {}),
            ...(dto.taxPreference === 'non_taxable'
              ? { taxRatePercent: 0 }
              : {}),
            ...(dto.openingStockValue != null &&
            Number.isFinite(dto.openingStockValue)
              ? { openingStockValue: Number(dto.openingStockValue) }
              : {}),
            ...(dto.returnable != null ? { returnable: dto.returnable } : {}),
            ...(dto.batchTracking
              ? { batchTracking: true }
              : {}),
            ...(dto.serialTracking
              ? { serialTracking: true }
              : {}),
            ...(dto.dimLength != null ||
            dto.dimWidth != null ||
            dto.dimHeight != null
              ? {
                  dimensions: {
                    length: dto.dimLength ?? null,
                    width: dto.dimWidth ?? null,
                    height: dto.dimHeight ?? null,
                    unit: dto.dimUnit?.trim() || 'cm',
                  },
                }
              : {}),
            ...(dto.weight != null && Number.isFinite(dto.weight)
              ? {
                  weight: Number(dto.weight),
                  weightUnit: dto.weightUnit?.trim() || 'kg',
                }
              : {}),
            ...(dto.isComposite ? { isComposite: true } : {}),
            ...(dto.multiUnitBaseQty != null &&
            Number.isFinite(dto.multiUnitBaseQty)
              ? {
                  multiUnit: {
                    baseQty: Number(dto.multiUnitBaseQty),
                    baseUnit: dto.multiUnitBaseUnit?.trim() || 'pcs',
                  },
                }
              : {}),
            ...(dto.loyaltyPoints != null &&
            Number.isFinite(dto.loyaltyPoints)
              ? { loyaltyPoints: Number(dto.loyaltyPoints) }
              : {}),
            ...(dto.perishable
              ? {
                  perishable: true,
                  ...(dto.expiryAutoDiscountDays != null
                    ? {
                        expiryAutoDiscountDays: Number(
                          dto.expiryAutoDiscountDays,
                        ),
                      }
                    : {}),
                  ...(dto.expiryAutoDiscountPercent != null
                    ? {
                        expiryAutoDiscountPercent: Number(
                          dto.expiryAutoDiscountPercent,
                        ),
                      }
                    : {}),
                }
              : {}),
            ...(dto.modifiers?.length
              ? {
                  modifiers: dto.modifiers
                    .map((m) => String(m).trim())
                    .filter(Boolean)
                    .slice(0, 40),
                }
              : {}),
            // BusinessConfig / ERD extra_fields
            ...(dto.extraFields && typeof dto.extraFields === 'object'
              ? Object.fromEntries(
                  Object.entries(dto.extraFields).filter(
                    ([, v]) => v !== '' && v != null,
                  ),
                )
              : {}),
          },
        },
      });
      const level = await this.prisma.stockLevel.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          productId: product.id,
          sku: dto.sku.trim().toUpperCase(),
          sellUnit,
          qtyOnHand: 0,
          sellPrice: price.toFixed(2),
        },
      });
      if (trackInventory && qty > 0) {
        await this.stock.mutate(this.prisma, {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          locationId,
          stockLevelId: level.id,
          qty,
          type: StockLedgerType.opening,
          reason: 'Opening stock',
          referenceType: 'product',
          referenceId: product.id,
          skipComponentExplosion: true,
        });
      }
      await seedZeroStockAtOtherLocations(this.prisma, {
        tenantId: user.tenantId,
        productId: product.id,
        sku: dto.sku.trim().toUpperCase(),
        sellUnit,
        sellPrice: price,
        exceptLocationId: locationId,
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
          sellUnit,
        },
        stockLevel: {
          id: level.id,
          sku: level.sku,
          sellPrice: level.sellPrice,
          qtyOnHand: Number(level.qtyOnHand),
          sellUnit: level.sellUnit,
        },
        /** Ready to sell on POS immediately */
        posItem: {
          id: level.id,
          sku: level.sku,
          name: product.name,
          sellPrice: level.sellPrice,
          qtyOnHand: Number(level.qtyOnHand),
          sellUnit: level.sellUnit,
          image: product.photoUrl,
          photoUrl: product.photoUrl,
          category: cat,
        },
      };
    } catch (error) {
      throwIfUnique(error, 'SKU already exists for this shop');
    }
  }

  /**
   * Bulk import sale items — Universal POS (any industry).
   * Creates missing categories by name when allowed.
   */
  async importSaleProducts(user: AuthUser, dto: ImportSaleProductsDto) {
    await this.assertSaleShop(user.tenantId);

    const rows = dto.items ?? [];
    if (!rows.length) {
      throw new BadRequestException('No items to import');
    }
    if (rows.length > 500) {
      throw new BadRequestException('Import at most 500 items at a time');
    }

    let locationId = dto.locationId;
    if (!locationId) {
      locationId = (await this.defaultLocationId(user.tenantId, user)) ?? undefined;
    }
    if (!locationId) throw new BadRequestException('No location configured');

    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    const createCats = dto.createCategories !== false;
    const categoryCache = new Map<string, { id: string; name: string }>();

    const resolveCategory = async (
      row: (typeof rows)[0],
      rowIndex: number,
    ): Promise<{ id: string; name: string }> => {
      if (row.categoryId) {
        const c = await this.prisma.category.findFirst({
          where: { id: row.categoryId, tenantId: user.tenantId },
          select: { id: true, name: true },
        });
        if (!c) {
          throw new BadRequestException(
            `Row ${rowIndex + 1}: category id not found`,
          );
        }
        return c;
      }
      const name = (row.categoryName ?? '').trim() || 'General';
      const key = name.toLowerCase();
      const cached = categoryCache.get(key);
      if (cached) return cached;

      let cat = await this.prisma.category.findFirst({
        where: {
          tenantId: user.tenantId,
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true, name: true },
      });
      if (!cat) {
        if (!createCats) {
          throw new BadRequestException(
            `Row ${rowIndex + 1}: category “${name}” not found`,
          );
        }
        cat = await this.prisma.category.create({
          data: { tenantId: user.tenantId, name },
          select: { id: true, name: true },
        });
      }
      categoryCache.set(key, cat);
      return cat;
    };

    if (dto.defaultCategoryId) {
      const def = await this.prisma.category.findFirst({
        where: { id: dto.defaultCategoryId, tenantId: user.tenantId },
        select: { id: true, name: true },
      });
      if (def) categoryCache.set('__default__', def);
    }

    const created: Array<{ sku: string; title: string; id: string }> = [];
    const errors: Array<{ row: number; sku?: string; message: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      try {
        let cat: { id: string; name: string };
        if (
          !row.categoryId &&
          !(row.categoryName ?? '').trim() &&
          categoryCache.has('__default__')
        ) {
          cat = categoryCache.get('__default__')!;
        } else {
          cat = await resolveCategory(row, i);
        }

        const res = await this.addSaleProduct(user, {
          title: row.title,
          description: row.description,
          categoryId: cat.id,
          sku: row.sku,
          sellUnit: row.sellUnit,
          price: row.price,
          qty: row.qty ?? 0,
          locationId,
          manufacturer: row.manufacturer,
          barcode: row.barcode,
          costPrice: row.costPrice,
          reorderPoint: row.reorderPoint,
          hsnOrSac: row.hsnOrSac,
          trackInventory: row.trackInventory,
        });
        created.push({
          sku: res.product.sku ?? row.sku,
          title: res.product.title,
          id: res.stockLevel.id,
        });
      } catch (e) {
        const message =
          e instanceof BadRequestException || e instanceof NotFoundException
            ? String(
                (e.getResponse() as { message?: string | string[] })?.message ??
                  e.message,
              )
            : e instanceof Error
              ? e.message
              : 'Import failed';
        errors.push({
          row: i + 1,
          sku: row.sku,
          message: Array.isArray(message) ? message.join(', ') : message,
        });
      }
    }

    return {
      mode: 'sale' as const,
      imported: created.length,
      failed: errors.length,
      created,
      errors,
    };
  }

  /** All sale products (incl. zero stock) — manage + sell */
  async listSaleProducts(
    user: AuthUser,
    opts: { locationId?: string; q?: string; categoryId?: string } = {},
  ) {
    await this.assertSaleShop(user.tenantId);
    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId, user));
    if (!locationId) throw new BadRequestException('No location configured');

    const q = opts.q?.trim();
    const categoryIds = opts.categoryId
      ? await categoryIdsWithDescendants(
          this.prisma,
          user.tenantId,
          opts.categoryId,
        )
      : null;
    const rows = await this.prisma.stockLevel.findMany({
      where: {
        tenantId: user.tenantId,
        locationId,
        product: {
          ...COUNTER_PRODUCT,
          ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { skuCode: { contains: q, mode: 'insensitive' } },
                  { barcode: { contains: q, mode: 'insensitive' } },
                  { internalCode: { contains: q, mode: 'insensitive' } },
                  { brand: { name: { contains: q, mode: 'insensitive' } } },
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
            barcode: true,
            description: true,
            photoUrl: true,
            meta: true,
            isActive: true,
            availableInPos: true,
            kind: true,
            status: true,
            basePrice: true,
            brand: { select: { id: true, name: true } },
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    return {
      locationId,
      fields: SALE_PRODUCT_FIELDS,
      items: rows
        .filter((r) => r.product.availableInPos !== false)
        .map((r) => {
        const images = productImageList(r.product.photoUrl, r.product.meta);
        const cover = images[0] ?? r.product.photoUrl ?? null;
        return {
        id: r.id,
        productId: r.productId,
        sku: r.sku,
        title: r.product.name,
        description: r.product.description,
          image: cover,
          photoUrl: cover,
          images,
        price: r.sellPrice,
          qty: Number(r.qtyOnHand),
          sellUnit: r.sellUnit,
        isActive: r.product.isActive,
          barcode: r.product.barcode,
          kind: r.product.kind,
          status: r.product.status,
          brand: r.product.brand,
        category: r.product.category,
        };
      }),
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

    if (dto.title !== undefined) {
      const titleErr = validateProductTitle(dto.title);
      if (titleErr) throw new BadRequestException(titleErr);
    }

    const sellUnit = normalizeSellUnit(dto.sellUnit ?? level.sellUnit);
    const units = await this.tenantUnits(user.tenantId);
    if (dto.price !== undefined) {
      const priceErr = validateSellPrice(Number(dto.price));
      if (priceErr) throw new BadRequestException(priceErr);
    }
    let nextQty: number | undefined;
    if (dto.qty !== undefined) {
      const qtyErr = validateSellQty(Number(dto.qty), sellUnit, units);
      if (qtyErr) throw new BadRequestException(qtyErr);
      nextQty = normalizeQty(Number(dto.qty), sellUnit, units);
    }

    if (dto.categoryId) {
      const cat = await this.prisma.category.findFirst({
        where: { id: dto.categoryId, tenantId: user.tenantId },
      });
      if (!cat) throw new NotFoundException('Category not found');
    }

    const prevMeta = (level.product.meta ?? {}) as Record<string, unknown>;

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
                photoUrl: (dto.image ?? dto.photoUrl)?.trim() || null,
              }
            : {}),
          ...(dto.price !== undefined
            ? { basePrice: Number(dto.price) }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.sellUnit !== undefined
            ? { meta: { ...prevMeta, sellUnit } }
            : {}),
        },
      });
      await tx.stockLevel.update({
        where: { id: level.id },
        data: {
          ...(dto.price !== undefined
            ? { sellPrice: Number(dto.price).toFixed(2) }
            : {}),
          ...(nextQty !== undefined ? { qtyOnHand: nextQty } : {}),
          ...(dto.sellUnit !== undefined ? { sellUnit } : {}),
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
      include: {
        product: { select: { id: true, name: true, skuCode: true } },
      },
    });
    if (!level) throw new NotFoundException('Product not found');

    const unit = normalizeSellUnit(level.sellUnit);
    const units = await this.tenantUnits(user.tenantId);
    const beforeQty = Number(level.qtyOnHand);
    const next = beforeQty + Number(dto.delta);
    const qtyErr = validateSellQty(next, unit, units);
    if (qtyErr) throw new BadRequestException(qtyErr);
    if (next < 0) {
      throw new BadRequestException(
        `Cannot reduce below 0 (have ${level.qtyOnHand} ${unit})`,
      );
    }
    const normalized = normalizeQty(next, unit, units);
    const delta = normalized - beforeQty;
    if (Math.abs(delta) < 1e-9) {
      return {
        id: level.id,
        sku: level.sku,
        qty: beforeQty,
        sellUnit: level.sellUnit,
        delta: 0,
        beforeQty,
        reason: dto.reason?.trim() || null,
      };
    }

    const mut = await this.stock.mutate(this.prisma, {
      tenantId: user.tenantId,
      actorUserId: user.userId,
      locationId: level.locationId,
      stockLevelId: level.id,
      qty: delta,
      type: StockLedgerType.adjustment,
      reason: dto.reason?.trim() || 'POS qty adjust',
      referenceType: 'stock_level',
      referenceId: level.id,
      skipComponentExplosion: true,
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'stock_level',
        entityId: level.id,
        action: 'inventory.qty_adjust',
        beforeAfter: {
          sku: level.sku,
          productName: level.product?.name ?? null,
          productSku: level.product?.skuCode ?? null,
          locationId: level.locationId,
          beforeQty,
          afterQty: mut.qtyAfter,
          delta,
          sellUnit: unit,
          reason: dto.reason?.trim() || null,
        },
      },
    });

    return {
      id: mut.stockLevelId,
      sku: level.sku,
      qty: mut.qtyAfter,
      sellUnit: level.sellUnit,
      delta,
      beforeQty,
      reason: dto.reason?.trim() || null,
    };
  }

  /**
   * Zoho-style inventory adjustments history (qty changes with reason).
   * Uses audit_logs action inventory.qty_adjust.
   */
  async listSaleStockAdjustments(user: AuthUser, limit = 80) {
    await this.assertSaleShop(user.tenantId);
    const take = Math.min(Math.max(limit || 80, 1), 200);
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId: user.tenantId,
        action: 'inventory.qty_adjust',
        entityType: 'stock_level',
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        actor: { select: { fullName: true, email: true } },
      },
    });

    return {
      items: rows.map((r) => {
        const b =
          (r.beforeAfter as {
            sku?: string;
            productName?: string | null;
            productSku?: string | null;
            locationId?: string;
            beforeQty?: number;
            afterQty?: number;
            delta?: number;
            sellUnit?: string;
            reason?: string | null;
          } | null) ?? {};
        return {
          id: r.id,
          createdAt: r.createdAt,
          stockLevelId: r.entityId,
          actorName: r.actor?.fullName ?? r.actor?.email ?? 'Staff',
          productName: b.productName ?? '—',
          sku: b.sku ?? b.productSku ?? '—',
          beforeQty: Number(b.beforeQty ?? 0),
          afterQty: Number(b.afterQty ?? 0),
          delta: Number(b.delta ?? 0),
          sellUnit: b.sellUnit ?? 'pcs',
          reason: b.reason ?? null,
          locationId: b.locationId ?? null,
        };
      }),
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
            meta: true,
            isActive: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!level) throw new NotFoundException('Product not found');
    const images = productImageList(
      level.product.photoUrl,
      level.product.meta,
    );
    const cover = images[0] ?? level.product.photoUrl ?? null;
    return {
      id: level.id,
      productId: level.productId,
      sku: level.sku,
      title: level.product.name,
      description: level.product.description,
      image: cover,
      photoUrl: cover,
      images,
      price: level.sellPrice,
      qty: Number(level.qtyOnHand),
      sellUnit: level.sellUnit,
      isActive: level.product.isActive,
      category: level.product.category,
    };
  }

  /** Append a product image (up to MAX_PRODUCT_IMAGES). Cover = first. */
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

    const existing = productImageList(
      level.product.photoUrl,
      level.product.meta,
    );
    if (existing.length >= MAX_PRODUCT_IMAGES) {
      throw new BadRequestException(
        `Maximum ${MAX_PRODUCT_IMAGES} images per product`,
      );
    }

    const photoUrl = await saveProductImage(user.tenantId, dto.imageBase64);
    // Newest upload becomes cover; keep prior gallery after it
    const images = [photoUrl, ...existing.filter((u) => u !== photoUrl)];
    const meta = asMeta(level.product.meta);
    await this.prisma.product.update({
      where: { id: level.productId },
      data: {
        photoUrl,
        meta: { ...meta, images } as Prisma.InputJsonValue,
      },
    });

    return this.getSaleProduct(user, stockLevelId);
  }

  /** Remove one gallery image by URL */
  async removeSaleProductImage(
    user: AuthUser,
    stockLevelId: string,
    imageUrl: string,
  ) {
    await this.assertSaleShop(user.tenantId);
    const url = imageUrl?.trim();
    if (!url) throw new BadRequestException('imageUrl is required');

    const level = await this.prisma.stockLevel.findFirst({
      where: { id: stockLevelId, tenantId: user.tenantId },
      include: { product: true },
    });
    if (!level) throw new NotFoundException('Product not found');
    if (level.product.fulfillmentMode !== FulfillmentMode.sale) {
      throw new BadRequestException('Not a sale product');
    }

    const images = productImageList(
      level.product.photoUrl,
      level.product.meta,
    ).filter((u) => u !== url);
    const meta = asMeta(level.product.meta);
    await this.prisma.product.update({
      where: { id: level.productId },
      data: {
        photoUrl: images[0] ?? null,
        meta: { ...meta, images } as Prisma.InputJsonValue,
      },
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
        parentId: true,
        // Match inventory list: only sale catalog (not rental/service items
        // that may share category names, e.g. seed formal jackets).
        _count: {
          select: {
            products: {
              where: {
                ...COUNTER_PRODUCT,
                stockLevels: { some: {} },
              },
            },
          },
        },
      },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      parentId: c.parentId,
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

  private async tenantUnits(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    return parseMeasureUnits(tenant?.settings);
  }

  private async assertCounterShop(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { settings: true },
    });
    const parsed = parseCommerceModes(tenant.settings);
    if (!parsed.setupComplete) {
      throw new BadRequestException('Shop commerce is not ready');
    }
    const ok = parsed.modes.some(
      (m) => m === 'sale' || m === 'service' || m === 'rental',
    );
    if (!ok) {
      throw new BadRequestException(
        'Counter is not enabled for this shop’s commerce modes',
      );
    }
  }

  /**
   * Cashiers are capped by configurable approval policy (default 5% cashier / 15% manager).
   * Over-limit creates an approval request — does not silently apply.
   */
  private async assertDiscountAllowed(
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

    const pct = (discountAmount / merchandiseSubtotal) * 100;
    const evaled = await this.approvals.evaluate(user, {
      type: 'discount',
      tenantId: user.tenantId,
      amount: discountAmount,
      percent: pct,
      entityType: 'order',
      reason: `Discount ${pct.toFixed(1)}%`,
    });
    if (evaled.needsApproval) {
      const req = await this.approvals.createRequest(user, {
        type: 'discount',
        tenantId: user.tenantId,
        amount: discountAmount,
        percent: pct,
        entityType: 'order',
        reason: evaled.reason,
        payload: { percent: pct, amount: discountAmount },
      });
      throw new ForbiddenException({
        message: evaled.reason ?? 'Discount requires approval',
        approvalRequestId: req.id,
        status: 'pending',
      });
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

    const isLead = user.roles.some((r) => r === 'admin' || r === 'manager');
    if (pct > cap + 1e-6 && !isLead && !evaled.allowed) {
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
      page?: number;
      lowStock?: boolean;
      maxQty?: number;
      /** Include out-of-stock SKUs (purchase orders / restock). */
      forPurchase?: boolean;
      categoryId?: string;
    },
  ) {
    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId, user));
    if (!locationId) throw new BadRequestException('No location configured');

    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, tenantId: user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException('Location not found');

    await seedZeroStockForNewLocation(this.prisma, {
      tenantId: user.tenantId,
      locationId,
    });

    const limitCap = opts.forPurchase ? 200 : 100;
    const limit = Math.min(Math.max(opts.limit ?? 40, 1), limitCap);
    const page = Math.max(opts.page ?? 1, 1);
    const skip = (page - 1) * limit;
    const q = opts.q?.trim();
    const threshold = Math.min(Math.max(opts.maxQty ?? 5, 1), 100);
    const categoryIds = opts.categoryId
      ? await categoryIdsWithDescendants(
          this.prisma,
          user.tenantId,
          opts.categoryId,
        )
      : null;

    const where: Prisma.StockLevelWhereInput = {
      tenantId: user.tenantId,
      locationId,
      variantKey: '',
      ...(opts.forPurchase
        ? {}
        : opts.lowStock
          ? { qtyOnHand: { gt: 0, lte: threshold } }
          : {}),
      AND: [
        {
          product: {
            ...COUNTER_PRODUCT,
            ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
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
                  {
                    product: {
                      barcode: { contains: q, mode: 'insensitive' as const },
                    },
                  },
                  {
                    product: {
                      internalCode: {
                        contains: q,
                        mode: 'insensitive' as const,
                      },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };

    const [total, items] = await Promise.all([
      this.prisma.stockLevel.count({ where }),
      this.prisma.stockLevel.findMany({
      where,
        skip,
      take: limit,
      orderBy: [{ product: { name: 'asc' } }, { sku: 'asc' }],
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
              barcode: true,
            description: true,
            photoUrl: true,
              taxCode: true,
              costPrice: true,
              meta: true,
              trackQty: true,
              trackSerial: true,
              trackBatch: true,
              kind: true,
            category: { select: { id: true, name: true } },
          },
        },
        location: { select: { id: true, name: true, code: true } },
      },
      }),
    ]);

    const productIds = items.map((r) => r.productId);
    const [variants, batches, variantLevels] = await Promise.all([
      productIds.length
        ? this.prisma.productVariant.findMany({
            where: {
              tenantId: user.tenantId,
              productId: { in: productIds },
              isActive: true,
            },
            select: {
              id: true,
              productId: true,
              name: true,
              skuCode: true,
              barcode: true,
              attributes: true,
            },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          })
        : Promise.resolve([]),
      productIds.length
        ? this.prisma.productBatch.findMany({
            where: {
              tenantId: user.tenantId,
              locationId,
              productId: { in: productIds },
              isActive: true,
              qtyOnHand: { gt: 0 },
            },
            select: {
              id: true,
              productId: true,
              batchCode: true,
              qtyOnHand: true,
              expiresAt: true,
            },
            orderBy: [{ expiresAt: 'asc' }, { batchCode: 'asc' }],
          })
        : Promise.resolve([]),
      productIds.length
        ? this.prisma.stockLevel.findMany({
            where: {
              tenantId: user.tenantId,
              locationId,
              productId: { in: productIds },
              variantKey: { not: '' },
            },
            select: {
              productId: true,
              qtyOnHand: true,
              qtyReserved: true,
            },
          })
        : Promise.resolve([]),
    ]);
    const variantsByProduct = new Map<string, typeof variants>();
    for (const v of variants) {
      const list = variantsByProduct.get(v.productId) ?? [];
      list.push(v);
      variantsByProduct.set(v.productId, list);
    }
    const batchesByProduct = new Map<string, typeof batches>();
    for (const b of batches) {
      const list = batchesByProduct.get(b.productId) ?? [];
      list.push(b);
      batchesByProduct.set(b.productId, list);
    }

    const variantQtyByProduct = new Map<string, number>();
    for (const vl of variantLevels) {
      variantQtyByProduct.set(
        vl.productId,
        (variantQtyByProduct.get(vl.productId) ?? 0) + Number(vl.qtyOnHand),
      );
    }

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return {
      locationId,
      lowStock: Boolean(opts.lowStock),
      maxQty: opts.lowStock ? threshold : undefined,
      page,
      limit,
      total,
      totalPages,
      items: items.map((row) => {
        const rowVariants = variantsByProduct.get(row.productId) ?? [];
        const qty =
          rowVariants.length > 0
            ? Number(variantQtyByProduct.get(row.productId) ?? 0)
            : Number(row.qtyOnHand);
        const images = productImageList(row.product.photoUrl, row.product.meta);
        const cover = images[0] ?? row.product.photoUrl ?? null;
        const taxRatePercent = resolveProductTaxRatePercent({
          taxCode: row.product.taxCode,
          meta: row.product.meta,
        });
        const costPrice =
          row.product.costPrice != null ? Number(row.product.costPrice) : null;
        const rowBatches = batchesByProduct.get(row.productId) ?? [];
        const meta =
          row.product.meta && typeof row.product.meta === 'object'
            ? (row.product.meta as Record<string, unknown>)
            : {};
        const itemStructure =
          typeof meta.itemStructure === 'string' ? meta.itemStructure : '';
        return {
        id: row.id,
          productId: row.productId,
        sku: row.sku,
        sellPrice: row.sellPrice,
          costPrice,
          qtyOnHand: qty,
          qtyReserved: Number(row.qtyReserved ?? 0),
          qtyAvailable: qty - Number(row.qtyReserved ?? 0),
          sellUnit: row.sellUnit,
          trackQty: row.product.trackQty !== false,
          lowStock: qty > 0 && qty <= threshold,
        name: row.product.name,
        productSku: row.product.skuCode,
          barcode: row.product.barcode,
        description: row.product.description,
          image: cover,
          photoUrl: cover,
          images,
          taxCode: row.product.taxCode,
          taxRatePercent,
        category: row.product.category,
          kind: row.product.kind,
          requiresVariant: itemStructure === 'variants' || rowVariants.length > 0,
          variantOptions: rowVariants.map((v) => ({
            id: v.id,
            skuCode: v.skuCode,
            barcode: v.barcode,
            label: v.name,
          })),
          requiresBatch: requiresManualBatch(row.product.trackBatch, row.product.meta),
          batchPickStrategy: batchPickStrategy(row.product.meta),
          batchTracked: row.product.trackBatch === true,
          batchOptions: rowBatches.map((b) => ({
            id: b.id,
            batchCode: b.batchCode,
            qtyOnHand: Number(b.qtyOnHand),
            expiresAt: b.expiresAt?.toISOString() ?? null,
          })),
          requiresSerial: row.product.trackSerial === true,
          location: row.location,
        };
      }),
    };
  }

  /** Exact SKU / barcode scan for sale POS (product barcode or shelf SKU) */
  async saleLookup(
    user: AuthUser,
    opts: { sku: string; locationId?: string },
  ) {
    const raw = opts.sku.trim();
    if (!raw) throw new BadRequestException('sku is required');
    const sku = raw.toUpperCase();

    const locationId =
      opts.locationId ?? (await this.defaultLocationId(user.tenantId, user));
    if (!locationId) throw new BadRequestException('No location configured');

    const productSale = COUNTER_PRODUCT;

    // Prefer exact matches like a live scanner expects (SKU, catalog barcode, product code)
    let row = await this.prisma.stockLevel.findFirst({
      where: {
        tenantId: user.tenantId,
        locationId,
        product: productSale,
        OR: [
          { sku: { equals: raw, mode: 'insensitive' } },
          { sku: { equals: sku, mode: 'insensitive' } },
          { product: { skuCode: { equals: raw, mode: 'insensitive' } } },
          { product: { skuCode: { equals: sku, mode: 'insensitive' } } },
          { product: { barcode: { equals: raw, mode: 'insensitive' } } },
          { product: { barcode: { equals: sku, mode: 'insensitive' } } },
          {
        product: {
              internalCode: { equals: raw, mode: 'insensitive' },
            },
          },
          {
            product: {
              variants: {
                some: {
                  OR: [
                    { barcode: { equals: raw, mode: 'insensitive' } },
                    { barcode: { equals: sku, mode: 'insensitive' } },
                    { skuCode: { equals: raw, mode: 'insensitive' } },
                    { skuCode: { equals: sku, mode: 'insensitive' } },
                  ],
                },
              },
            },
          },
        ],
      },
      orderBy: [{ variantKey: 'desc' }, { createdAt: 'asc' }],
      include: {
        product: {
          select: {
            id: true,
            name: true,
            skuCode: true,
            barcode: true,
            photoUrl: true,
            taxCode: true,
            meta: true,
            trackQty: true,
            trackSerial: true,
            trackBatch: true,
            category: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!row) {
      // Catalog item may exist without a stock row (older creates) — seed one for POS
      const orphan = await this.prisma.product.findFirst({
        where: {
          tenantId: user.tenantId,
          ...COUNTER_PRODUCT,
          OR: [
            { skuCode: { equals: raw, mode: 'insensitive' } },
            { skuCode: { equals: sku, mode: 'insensitive' } },
            { barcode: { equals: raw, mode: 'insensitive' } },
            { barcode: { equals: sku, mode: 'insensitive' } },
            { internalCode: { equals: raw, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          name: true,
          skuCode: true,
          barcode: true,
          photoUrl: true,
          taxCode: true,
          meta: true,
          trackQty: true,
          basePrice: true,
          unitOfMeasure: true,
          category: { select: { id: true, name: true } },
        },
      });
      if (orphan) {
        const existingLevel = await this.prisma.stockLevel.findFirst({
          where: {
            tenantId: user.tenantId,
            locationId,
            productId: orphan.id,
          },
        });
        if (!existingLevel) {
          await this.prisma.stockLevel.create({
            data: {
              tenantId: user.tenantId,
              locationId,
              productId: orphan.id,
              sku: orphan.skuCode,
              sellUnit: (orphan.unitOfMeasure || 'pcs').slice(0, 8),
              qtyOnHand: orphan.trackQty ? 0 : 0,
              sellPrice: orphan.basePrice ?? 0,
            },
          });
        }
        row = await this.prisma.stockLevel.findFirst({
          where: {
            tenantId: user.tenantId,
            locationId,
            productId: orphan.id,
          },
          include: {
            product: {
              select: {
                id: true,
                name: true,
                skuCode: true,
                barcode: true,
                photoUrl: true,
                taxCode: true,
                meta: true,
                trackQty: true,
                trackSerial: true,
                trackBatch: true,
                category: { select: { id: true, name: true } },
              },
            },
          },
        });
      }
    }

    if (!row) {
      throw new NotFoundException(`SKU / barcode not found: ${raw}`);
    }
    const onHand = Number(row.qtyOnHand);
    const tracks = row.product.trackQty !== false;
    if (tracks && onHand <= 0) {
      throw new BadRequestException(
        `Out of stock: ${row.product.barcode || row.sku}`,
      );
    }

    const images = productImageList(row.product.photoUrl, row.product.meta);
    const cover = images[0] ?? row.product.photoUrl ?? null;
    const taxRatePercent = resolveProductTaxRatePercent({
      taxCode: row.product.taxCode,
      meta: row.product.meta,
    });
    const [variants, batches] = await Promise.all([
      this.prisma.productVariant.findMany({
        where: {
          tenantId: user.tenantId,
          productId: row.product.id,
          isActive: true,
        },
        select: {
          id: true,
          name: true,
          skuCode: true,
          barcode: true,
          attributes: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.productBatch.findMany({
        where: {
          tenantId: user.tenantId,
          locationId,
          productId: row.product.id,
          isActive: true,
          qtyOnHand: { gt: 0 },
        },
        select: {
          id: true,
          batchCode: true,
          qtyOnHand: true,
          expiresAt: true,
        },
        orderBy: [{ expiresAt: 'asc' }, { batchCode: 'asc' }],
      }),
    ]);
    const meta =
      row.product.meta && typeof row.product.meta === 'object'
        ? (row.product.meta as Record<string, unknown>)
        : {};
    const itemStructure =
      typeof meta.itemStructure === 'string' ? meta.itemStructure : '';
    return {
      id: row.id,
      productId: row.product.id,
      sku: row.sku,
      name: row.product.name,
      sellPrice: row.sellPrice,
      qtyOnHand: onHand,
      qtyReserved: Number(row.qtyReserved ?? 0),
      qtyAvailable: onHand - Number(row.qtyReserved ?? 0),
      sellUnit: row.sellUnit,
      trackQty: tracks,
      productSku: row.product.skuCode,
      barcode: row.product.barcode,
      image: cover,
      photoUrl: cover,
      images,
      taxRatePercent,
      category: row.product.category,
      requiresVariant: itemStructure === 'variants' || variants.length > 0,
      variantOptions: variants.map((v) => ({
        id: v.id,
        skuCode: v.skuCode,
        barcode: v.barcode,
        label: v.name,
      })),
      requiresBatch: requiresManualBatch(row.product.trackBatch, row.product.meta),
      batchPickStrategy: batchPickStrategy(row.product.meta),
      batchTracked: row.product.trackBatch === true,
      batchOptions: batches.map((b) => ({
        id: b.id,
        batchCode: b.batchCode,
        qtyOnHand: Number(b.qtyOnHand),
        expiresAt: b.expiresAt?.toISOString() ?? null,
      })),
      requiresSerial: row.product.trackSerial === true,
    };
  }

  private async resolvePosSaleLine(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    locationId: string,
    line: {
      stockLevelId: string;
      quantity: number;
      variantId?: string;
      batchId?: string;
      serialNumber?: string;
    },
  ) {
    const level = await tx.stockLevel.findFirst({
      where: {
        id: line.stockLevelId,
        tenantId: user.tenantId,
        locationId,
      },
      include: { product: true },
    });
    if (!level) {
      throw new NotFoundException(`Stock level not found: ${line.stockLevelId}`);
    }
    const unit = normalizeSellUnit(level.sellUnit);
    const units = await this.tenantUnits(user.tenantId);
    const qty = Number(line.quantity);
    const qtyErr = validateSellQty(qty, unit, units);
    if (qtyErr) {
      throw new BadRequestException(`${level.sku}: ${qtyErr}`);
    }

    const itemMeta = asMeta(level.product.meta);
    const itemStructure =
      typeof itemMeta.itemStructure === 'string' ? itemMeta.itemStructure : '';
    const hasVariants = await tx.productVariant.count({
      where: {
        tenantId: user.tenantId,
        productId: level.productId,
        isActive: true,
      },
    });
    if ((itemStructure === 'variants' || hasVariants > 0) && !line.variantId) {
      throw new BadRequestException(`${level.sku}: variant is required`);
    }

    let sellLevel = level;
    if (line.variantId) {
      const variant = await tx.productVariant.findFirst({
        where: {
          id: line.variantId,
          tenantId: user.tenantId,
          productId: level.productId,
          isActive: true,
        },
        select: { id: true },
      });
      if (!variant) {
        throw new BadRequestException(`${level.sku}: invalid variant`);
      }
      const vLevel = await tx.stockLevel.findFirst({
        where: {
          tenantId: user.tenantId,
          locationId,
          productId: level.productId,
          variantKey: line.variantId,
        },
        include: { product: true },
      });
      if (vLevel) sellLevel = vLevel;
    }

    const tracks = sellLevel.product.trackQty !== false;
    const available =
      Number(sellLevel.qtyOnHand) - Number(sellLevel.qtyReserved);
    if (tracks && available + 1e-9 < qty) {
      throw new BadRequestException(
        `Insufficient stock for ${sellLevel.sku} (available ${available} ${unit}, need ${qty})`,
      );
    }

    if (
      requiresManualBatch(sellLevel.product.trackBatch, sellLevel.product.meta) &&
      !line.batchId
    ) {
      throw new BadRequestException(`${sellLevel.sku}: batch is required`);
    }
    if (sellLevel.product.trackBatch === true && line.batchId) {
      const batch = await tx.productBatch.findFirst({
        where: {
          id: line.batchId,
          tenantId: user.tenantId,
          locationId,
          productId: sellLevel.productId,
          isActive: true,
        },
        select: { id: true },
      });
      if (!batch) throw new BadRequestException(`${sellLevel.sku}: invalid batch`);
    }
    if (sellLevel.product.trackSerial === true && !line.serialNumber?.trim()) {
      throw new BadRequestException(`${sellLevel.sku}: serial is required`);
    }

    return { level: sellLevel, qty, tracks, unit };
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
    if (!dto.customerId && posSettingsOf(tenant.settings).customerRequired) {
      throw new BadRequestException('Customer is required for checkout');
    }
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
            ...(dto.meta && typeof dto.meta === 'object' && !Array.isArray(dto.meta)
              ? Object.fromEntries(
                  Object.entries(dto.meta).filter(
                    ([k, v]) =>
                      k !== 'taxSnapshot' &&
                      k !== 'awaitingStripePayment' &&
                      typeof k === 'string' &&
                      k.length <= 64 &&
                      v !== undefined,
                  ),
                )
              : {}),
          },
          ...(dto.discountAmount !== undefined && dto.discountAmount > 0
            ? { discountTotal: money(dto.discountAmount).toFixed(2) }
            : {}),
        },
      });

      for (const line of dto.items) {
        const { level, qty } = await this.resolvePosSaleLine(
          tx,
          user,
          dto.locationId,
          line,
        );

        const unitPrice =
          line.unitPrice !== undefined
            ? money(line.unitPrice)
            : money(level.sellPrice);
        const lineGross = unitPrice.mul(qty);
        const productRatePct = resolveProductTaxRatePercent({
          taxCode: level.product.taxCode,
          meta: level.product.meta,
        });
        const taxed = computeLineTax(taxProfile, {
          lineGross,
          ...(productRatePct != null
            ? { rate: productRatePct / 100 }
            : {}),
        });
        const lineMeta: Record<string, unknown> = {
          taxRate:
            productRatePct != null ? productRatePct / 100 : taxProfile.rate,
          taxInclusive: taxProfile.inclusive,
          taxCode: level.product.taxCode ?? null,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          ...(line.batchId ? { batchId: line.batchId } : {}),
          ...(line.serialNumber?.trim()
            ? { serialNumber: line.serialNumber.trim() }
            : {}),
        };

        await tx.orderItem.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: qty,
            unitPrice: unitPrice.toFixed(2),
            lineTotal: taxed.lineTotal.toFixed(2),
            taxAmount: taxed.taxAmount.toFixed(2),
            meta: lineMeta as Prisma.InputJsonValue,
          },
        });
      }

      const lineSum = await tx.orderItem.aggregate({
        where: { orderId: created.id, tenantId: user.tenantId },
        _sum: { lineTotal: true, taxAmount: true },
      });
      // Pre-discount ticket total (net + tax) — same base cashiers see on counter
      const merchandise =
        Number(lineSum._sum.lineTotal ?? 0) +
        Number(lineSum._sum.taxAmount ?? 0);
      await this.assertDiscountAllowed(
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

    if (dto.couponCode?.trim()) {
      try {
        const orderLoaded = await this.loadOrder(user.tenantId, orderId);
        const validated = await this.loyalty.validate(user, {
          code: dto.couponCode.trim(),
          orderSubtotal: Math.max(
            Number(orderLoaded?.subtotal ?? 0),
            Number(dto.discountAmount ?? 0) || 0,
          ),
        });
        await this.loyalty.recordRedemption(user, {
          couponId: validated.couponId,
          orderId,
          customerId: dto.customerId,
          amountOff:
            dto.discountAmount && dto.discountAmount > 0
              ? dto.discountAmount
              : validated.amountOff,
        });
        const prevMeta =
          ((orderLoaded?.meta as Record<string, unknown> | null) ?? {});
        await this.prisma.order.update({
          where: { id: orderId },
          data: {
            meta: {
              ...prevMeta,
              awaitingStripePayment: true,
              couponCode: dto.couponCode.trim(),
            },
          },
        });
      } catch {
        // Discount already applied; coupon meta best-effort
      }
    }

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
      include: { payments: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    const meta = (order.meta ?? {}) as Record<string, unknown>;
    if (!meta.awaitingStripePayment) {
      throw new BadRequestException('Order is not an unpaid Stripe sale');
    }
    if (order.status === OrderStatus.closed) {
      throw new BadRequestException('Order already closed');
    }

    const succeeded = order.payments.filter(
      (p) => p.status === PaymentStatus.succeeded,
    );
    const pendingExternal = order.payments.filter(
      (p) =>
        p.status === PaymentStatus.initiated ||
        p.status === PaymentStatus.pending ||
        p.status === PaymentStatus.processing,
    );

    if (succeeded.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const p of pendingExternal) {
          await tx.payment.update({
            where: { id: p.id },
            data: {
              status: PaymentStatus.cancelled,
              failureReason: p.failureReason ?? 'Checkout cancelled by cashier',
            },
          });
        }
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.confirmed,
            meta: {
              ...meta,
              awaitingStripePayment: false,
              cancelledStripe: true,
              partialAfterStripeCancel: true,
            },
          },
        });
        await this.ordersService.recalculateTotals(tx, user.tenantId, orderId);
      });
      return { id: orderId, status: OrderStatus.confirmed, cashKept: true };
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.cancelled,
        meta: { ...meta, awaitingStripePayment: false, cancelledStripe: true },
      },
    });
    for (const p of pendingExternal) {
      await this.prisma.payment.update({
        where: { id: p.id },
        data: {
          status: PaymentStatus.cancelled,
          failureReason: 'Prepared sale cancelled',
        },
      });
    }
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
          include: { product: { select: { trackQty: true } } },
        });
        if (!level) {
          throw new NotFoundException(`Stock level missing for line ${item.id}`);
        }
        if (level.product.trackQty !== false) {
          if (Number(level.qtyOnHand) < qty) {
            throw new BadRequestException(
              `Insufficient stock for ${level.sku} after payment (have ${level.qtyOnHand})`,
            );
          }
          const itemMeta =
            item.meta && typeof item.meta === 'object'
              ? (item.meta as Record<string, unknown>)
              : {};
          await this.stock.mutateInTx(tx, {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            locationId: order.locationId,
            stockLevelId: level.id,
            productId: level.productId,
            variantId:
              typeof itemMeta.variantId === 'string' ? itemMeta.variantId : undefined,
            batchId:
              typeof itemMeta.batchId === 'string' ? itemMeta.batchId : undefined,
            serialNumber:
              typeof itemMeta.serialNumber === 'string'
                ? itemMeta.serialNumber
                : undefined,
            qty: -qty,
            type: StockLedgerType.sale,
            referenceType: 'order',
            referenceId: orderId,
            idempotencyKey: `sale:${orderId}:${level.id}:${qty}`,
          });
        }
      }

      await this.ordersService.recalculateTotals(tx, user.tenantId, orderId);
      const final = await tx.order.findFirstOrThrow({
        where: { id: orderId },
        select: { balanceDue: true },
      });
      const stillDue = money(final.balanceDue).gt(0);

      // Partial Stripe pays: leave confirmed with balance; full pay → fulfilled/closed
      if (stillDue) {
        if (order.customerId) {
          await this.assertCustomerCreditLimit(
            tx,
            user.tenantId,
            order.customerId,
          );
        }
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: OrderStatus.confirmed,
            meta: {
              ...meta,
              awaitingStripePayment: false,
              partialStripe: true,
            },
          },
        });
      } else {
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
      }

      await tx.outboxEvent.create({
        data: {
          tenantId: user.tenantId,
          eventType: 'pos.sale.completed',
          aggregateType: 'order',
          aggregateId: orderId,
          payload: {
            orderId,
            via: 'stripe',
            partial: stillDue,
          },
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
    await this.assertCounterShop(user.tenantId);

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

    if (!dto.payments.length) {
      throw new BadRequestException('At least one payment is required');
    }

    const tenantForRules = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    if (!dto.customerId && posSettingsOf(tenantForRules.settings).customerRequired) {
      throw new BadRequestException('Customer is required for checkout');
    }

    const hasCreditRemainder =
      dto.allowPartial === true &&
      dto.payments.some((p) => p.method === PaymentMethod.collect_later);
    if (
      hasCreditRemainder &&
      !dto.customerId
    ) {
      throw new BadRequestException('Customer is required for a credit sale');
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
            ...(dto.meta && typeof dto.meta === 'object' && !Array.isArray(dto.meta)
              ? Object.fromEntries(
                  Object.entries(dto.meta).filter(
                    ([k, v]) =>
                      k !== 'taxSnapshot' &&
                      typeof k === 'string' &&
                      k.length <= 64 &&
                      v !== undefined,
                  ),
                )
              : {}),
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
        const { level, qty, tracks } = await this.resolvePosSaleLine(
          tx,
          user,
          dto.locationId,
          line,
        );

        const unitPrice =
          line.unitPrice !== undefined
            ? money(line.unitPrice)
            : money(level.sellPrice);
        const lineGross = unitPrice.mul(qty);
        const productRatePct = resolveProductTaxRatePercent({
          taxCode: level.product.taxCode,
          meta: level.product.meta,
        });
        const taxed = computeLineTax(taxProfile, {
          lineGross,
          ...(productRatePct != null
            ? { rate: productRatePct / 100 }
            : {}),
        });
        const lineMeta: Record<string, unknown> = {
          taxRate:
            productRatePct != null ? productRatePct / 100 : taxProfile.rate,
          taxInclusive: taxProfile.inclusive,
          taxCode: level.product.taxCode ?? null,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          ...(line.batchId ? { batchId: line.batchId } : {}),
          ...(line.serialNumber?.trim()
            ? { serialNumber: line.serialNumber.trim() }
            : {}),
        };

        if (tracks) {
          const mut = await this.stock.mutateInTx(tx, {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            locationId: dto.locationId,
            stockLevelId: level.id,
            productId: level.productId,
            variantId: line.variantId,
            batchId: line.batchId,
            serialNumber: line.serialNumber,
            qty: -qty,
            type: StockLedgerType.sale,
            referenceType: 'order',
            referenceId: created.id,
            idempotencyKey: `sale:${created.id}:${level.id}:${qty}:${line.variantId ?? ''}:${line.batchId ?? ''}:${line.serialNumber ?? ''}`,
          });
          if (mut.batchId) lineMeta.batchId = mut.batchId;
          if (mut.stockUnitId) lineMeta.stockUnitId = mut.stockUnitId;
        } else {
          await this.stock.consumeForParent(tx, {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            locationId: dto.locationId,
            productId: level.productId,
            parentQty: qty,
            referenceType: 'order',
            referenceId: created.id,
          });
        }

        await tx.orderItem.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: qty,
            unitPrice: unitPrice.toFixed(2),
            lineTotal: taxed.lineTotal.toFixed(2),
            taxAmount: taxed.taxAmount.toFixed(2),
            meta: lineMeta as Prisma.InputJsonValue,
          },
        });
      }

      const lineSum = await tx.orderItem.aggregate({
        where: { orderId: created.id, tenantId: user.tenantId },
        _sum: { lineTotal: true, taxAmount: true },
      });
      const merchandise =
        Number(lineSum._sum.lineTotal ?? 0) +
        Number(lineSum._sum.taxAmount ?? 0);
      await this.assertDiscountAllowed(
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
        select: { balanceDue: true, subtotal: true, discountTotal: true },
      });

      const loyaltySettings = this.loyalty.parseLoyaltySettings(tenant.settings);
      let loyaltyPointsRedeemed = 0;
      let loyaltyAmountOff = 0;
      if (
        dto.loyaltyPointsToRedeem &&
        dto.loyaltyPointsToRedeem > 0 &&
        dto.customerId
      ) {
        const redeemed = await this.loyalty.redeemPointsInTx(tx, {
          tenantId: user.tenantId,
          customerId: dto.customerId,
          points: dto.loyaltyPointsToRedeem,
          orderId: created.id,
          settings: loyaltySettings,
        });
        loyaltyPointsRedeemed = redeemed.points;
        loyaltyAmountOff = redeemed.amountOff;
        if (loyaltyAmountOff > 0) {
          const nextDiscount = money(afterLines.discountTotal).plus(
            loyaltyAmountOff,
          );
          await tx.order.update({
            where: { id: created.id },
            data: { discountTotal: nextDiscount.toFixed(2) },
          });
          await this.ordersService.recalculateTotals(
            tx,
            user.tenantId,
            created.id,
          );
        }
      }

      const dueRow = await tx.order.findFirstOrThrow({
        where: { id: created.id },
        select: { balanceDue: true },
      });
      const due = money(dueRow.balanceDue);
      if (due.lte(0)) {
        throw new BadRequestException('Sale total must be greater than 0');
      }

      // Do not force single-cash to full due — supports partial payments
      const paymentLines = dto.payments.map((p) => ({
        ...p,
        amount: Number(p.amount),
      }));
      const clientPayHint = paymentLines.reduce((s, p) => s + p.amount, 0);
      // Full-ticket cash: always collect server Due (includes exclusive tax).
      // Stops client tax/settings drift from recording a tax-free payment.
      if (
        dto.allowPartial !== true &&
        paymentLines.length === 1 &&
        paymentLines[0]!.method === PaymentMethod.cash
      ) {
        paymentLines[0]!.amount = Number(due.toFixed(2));
      }
      const paidSum = paymentLines.reduce((s, p) => s + p.amount, 0);
      if (paidSum <= 0) {
        throw new BadRequestException('Payment amount must be greater than 0');
      }

      const allowPartial = dto.allowPartial === true;
      if (money(paidSum).lt(due) && !allowPartial) {
        throw new BadRequestException(
          `Payment ${money(paidSum).toFixed(2)} is less than balance due ${due.toFixed(2)}. Enable partial payment or pay the full amount.`,
        );
      }

      // Cap each line so total paid does not exceed due (except cash change via tendered)
      if (money(paidSum).gt(due.add(0.009))) {
        const onlyCash =
          paymentLines.length === 1 &&
          paymentLines[0]!.method === PaymentMethod.cash;
        if (!onlyCash) {
          throw new BadRequestException(
            `Payment ${money(paidSum).toFixed(2)} exceeds balance due ${due.toFixed(2)}`,
          );
        }
        paymentLines[0]!.amount = Number(due.toFixed(2));
      } else if (money(paidSum).gt(due)) {
        // Tiny float over — clamp last line
        const excess = money(paidSum).minus(due);
        const last = paymentLines[paymentLines.length - 1]!;
        last.amount = Math.max(
          0.01,
          Number(money(last.amount).minus(excess).toFixed(2)),
        );
      }

      const settledPaid = paymentLines.reduce((s, p) => s + p.amount, 0);

      const cashPortion = paymentLines
        .filter((p) => p.method === PaymentMethod.cash)
        .reduce((s, p) => s + p.amount, 0);
      let cashTendered = dto.cashTendered;
      // Exact-charge: tendered matched the (possibly tax-free) client total — lift to Due
      if (
        cashTendered !== undefined &&
        cashPortion > 0 &&
        Number(cashTendered) + 1e-9 < cashPortion &&
        Math.abs(Number(cashTendered) - clientPayHint) < 0.021
      ) {
        cashTendered = cashPortion;
      }
      if (cashPortion > 0 && cashTendered !== undefined) {
        if (Number(cashTendered) + 1e-9 < cashPortion) {
          throw new BadRequestException(
            'Cash tendered is less than cash payment amount',
          );
        }
      }

      const payments = [];
      const openRegister =
        paymentLines.some((p) => p.method === PaymentMethod.cash)
          ? await tx.registerSession.findFirst({
              where: {
                tenantId: user.tenantId,
                locationId: dto.locationId,
                closedAt: null,
              },
              orderBy: { openedAt: 'desc' },
            })
          : null;
      if (
        paymentLines.some((p) => p.method === PaymentMethod.cash) &&
        !openRegister
      ) {
        throw new BadRequestException(
          'Open the register before recording a cash payment',
        );
      }

      for (const p of paymentLines) {
        const cap = getPaymentMethodCapability(p.method);
        if (
          cap.requiresProvider &&
          p.method !== PaymentMethod.bank_transfer
        ) {
          throw new BadRequestException(
            `${cap.displayName} requires provider confirmation — use the ${cap.displayName} checkout flow`,
          );
        }
        if (p.method === PaymentMethod.emi) {
          throw new BadRequestException(
            `${cap.displayName} provider is not configured`,
          );
        }

        const status = isInternalImmediate(p.method)
          ? PaymentStatus.succeeded
          : p.method === PaymentMethod.bank_transfer ||
              p.method === PaymentMethod.collect_later
            ? PaymentStatus.pending
          : PaymentStatus.pending;

        if (
          p.method === PaymentMethod.store_credit &&
          status === PaymentStatus.succeeded
        ) {
          if (!dto.customerId) {
            throw new BadRequestException(
              'Store credit pay needs a customer on the sale',
            );
          }
          const cust = await tx.customer.findFirst({
            where: { id: dto.customerId, tenantId: user.tenantId },
            select: { storeCreditBalance: true },
          });
          const bal = Number(cust?.storeCreditBalance ?? 0);
          if (bal + 1e-9 < p.amount) {
            throw new BadRequestException(
              `Insufficient store credit (have ${bal.toFixed(2)})`,
            );
          }
          const nextBal = Number(
            (bal - Number(money(p.amount).toFixed(2))).toFixed(2),
          );
          await tx.customer.update({
            where: { id: dto.customerId },
            data: {
              storeCreditBalance: nextBal.toFixed(2),
            },
          });
          await tx.storeCreditLedgerEntry.create({
            data: {
              tenantId: user.tenantId,
              customerId: dto.customerId,
              kind: 'debit',
              amount: money(p.amount).toFixed(2),
              balanceAfter: nextBal.toFixed(2),
              orderId: created.id,
              note: 'POS payment',
              actorUserId: user.userId,
            },
          });
        }

        if (
          p.method === PaymentMethod.gift_card &&
          status === PaymentStatus.succeeded
        ) {
          if (!p.giftCardCode?.trim()) {
            throw new BadRequestException(
              'giftCardCode is required for gift card payments',
            );
          }
          await this.loyalty.redeemGiftCardInTx(tx, {
            tenantId: user.tenantId,
            code: p.giftCardCode,
            amount: p.amount,
            orderId: created.id,
            userId: user.userId,
          });
        }

        if (p.method === PaymentMethod.bank_transfer) {
          if (
            !p.bankAccountName?.trim() ||
            !p.bankAccountNumber?.trim() ||
            !p.bankReference?.trim()
          ) {
            throw new BadRequestException(
              'Bank transfer needs account name, account number, and reference / UTR',
            );
          }
        }

        const payment = await tx.payment.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            locationId: dto.locationId,
            registerSessionId:
              p.method === PaymentMethod.cash ? openRegister?.id ?? null : null,
            type: p.type ?? PaymentType.payment,
            method: p.method,
            amount: money(p.amount).toFixed(2),
            status,
            provider: cap.provider === 'none' ? null : cap.provider,
            idempotencyKey: p.idempotencyKey,
            takenByUserId: user.userId,
            ...(p.giftCardCode
              ? {
                  gatewayRef: p.giftCardCode.trim().toUpperCase(),
                  gatewayPayload: {
                    giftCardCode: p.giftCardCode.trim().toUpperCase(),
                  },
                }
              : {}),
            ...(p.method === PaymentMethod.bank_transfer
              ? {
                  gatewayRef: p.bankReference?.trim() || null,
                  gatewayPayload: {
                    bankReference: p.bankReference?.trim() || null,
                    bankAccountName: p.bankAccountName?.trim() || null,
                    bankAccountNumber: p.bankAccountNumber?.trim() || null,
                    bankIfsc: p.bankIfsc?.trim() || null,
                    bankName: p.bankName?.trim() || null,
                  },
                }
              : {}),
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

      // Fully paid retail sale → fulfilled → closed; partial → confirmed with balance
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
        if (dto.customerId) {
          await this.assertCustomerCreditLimit(
            tx,
            user.tenantId,
            dto.customerId,
          );
        }
        const cur = await tx.order.findFirstOrThrow({
          where: { id: created.id },
          select: { meta: true },
        });
        const prevMeta =
          cur.meta && typeof cur.meta === 'object'
            ? (cur.meta as Record<string, unknown>)
            : {};
        await tx.order.update({
          where: { id: created.id },
          data: {
            status: OrderStatus.confirmed,
            meta: {
              ...prevMeta,
              partialPayment: true,
            },
          },
        });
      }

      let pointsEarned = 0;
      if (dto.customerId && settledPaid > 0) {
        const earned = await this.loyalty.earnPointsInTx(tx, {
          tenantId: user.tenantId,
          customerId: dto.customerId,
          paidAmount: settledPaid,
          orderId: created.id,
          settings: loyaltySettings,
        });
        pointsEarned = earned.points;
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
            payTotal: settledPaid,
            partial: money(final.balanceDue).gt(0),
            loyaltyPointsRedeemed,
            pointsEarned,
          },
        },
      });

      await this.accounting.postSale(tx, user, created.id);

      return {
        orderId: created.id,
        payments,
        paidSum: settledPaid,
        loyaltyPointsRedeemed,
        loyaltyAmountOff,
        pointsEarned,
        cashTendered:
          cashTendered !== undefined ? Number(cashTendered) : undefined,
      };
    });

    const order = await this.loadOrder(user.tenantId, result.orderId);

    const cashPaid = result.payments
      .filter((p) => p.method === PaymentMethod.cash)
      .reduce((s, p) => s + Number(p.amount), 0);
    const tendered =
      result.cashTendered !== undefined ? result.cashTendered : cashPaid;
    const change = Math.max(0, tendered - cashPaid);

    // Persist tendered/change so reprint / getReceipt can show them
    if (tendered > 0 || change > 0) {
      const meta = {
        ...((order?.meta as Record<string, unknown> | null) ?? {}),
        cashTendered: money(tendered).toFixed(2),
        change: money(change).toFixed(2),
      };
      await this.prisma.order.update({
        where: { id: result.orderId },
        data: { meta },
      });
    }

    if (dto.couponCode?.trim()) {
      try {
        const validated = await this.loyalty.validate(user, {
          code: dto.couponCode.trim(),
          orderSubtotal: Math.max(
            Number(order?.subtotal ?? 0),
            Number(dto.discountAmount ?? 0) || 0,
          ),
        });
        await this.loyalty.recordRedemption(user, {
          couponId: validated.couponId,
          orderId: result.orderId,
          customerId: dto.customerId,
          amountOff:
            dto.discountAmount && dto.discountAmount > 0
              ? dto.discountAmount
              : validated.amountOff,
        });
      } catch {
        // Discount already on order; redemption is best-effort
      }
    }

    const receipt = await this.getReceipt(user, result.orderId);

    let receiptNotifications: unknown[] = [];
    if (dto.sendReceipt && dto.customerId) {
      receiptNotifications = await this.notify.sendSaleReceipt(user, {
        customerId: dto.customerId,
        orderNumber: order?.orderNumber ?? '',
        total: money(
          Number(order?.subtotal ?? 0) +
            Number(order?.taxTotal ?? 0) -
            Number(order?.discountTotal ?? 0),
        ).toFixed(2),
        balanceDue: money(order?.balanceDue ?? 0).toFixed(2),
        storeName: undefined,
        channels: dto.sendReceiptChannels,
      });
    }

    // Low-stock alerts after successful sale stock decrement
    for (const line of dto.items ?? []) {
      if (!line.stockLevelId) continue;
      const lvl = await this.prisma.stockLevel.findFirst({
        where: { id: line.stockLevelId, tenantId: user.tenantId },
        select: { productId: true, locationId: true },
      });
      if (lvl) {
        void this.lowStock.evaluate({
          tenantId: user.tenantId,
          locationId: lvl.locationId,
          productId: lvl.productId,
        });
      }
    }

    return {
      order,
      payments: result.payments,
      change: money(change).toFixed(2),
      cashTendered: money(tendered).toFixed(2),
      receipt,
      replayed: false,
      partial: money(order?.balanceDue ?? 0).gt(0),
      balanceDue: money(order?.balanceDue ?? 0).toFixed(2),
      loyaltyPointsRedeemed: result.loyaltyPointsRedeemed,
      loyaltyAmountOff: result.loyaltyAmountOff,
      pointsEarned: result.pointsEarned,
      receiptNotifications,
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

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: {
        name: true,
        taxId: true,
        currencyCode: true,
        locale: true,
        branding: true,
        settings: true,
      },
    });

    const cashier = order.createdById
      ? await this.prisma.user.findFirst({
          where: { id: order.createdById, tenantId: user.tenantId },
          select: { fullName: true },
        })
      : null;

    const succeededPayments = order.payments.filter(
      (p) => p.status === 'succeeded',
    );

    const settings = (tenant?.settings ?? {}) as {
      tax?: { receiptFooter?: string };
    };
    const branding = (tenant?.branding ?? {}) as {
      productName?: string;
      tagline?: string;
    };
    const meta = (order.meta ?? {}) as Record<string, unknown>;

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      kind: order.kind,
      currencyCode: tenant?.currencyCode ?? order.currencyCode ?? 'INR',
      store: {
        name: order.location.name,
        code: order.location.code,
        address: order.location.address,
        shopName: tenant?.name ?? order.location.name,
        taxId: tenant?.taxId ?? null,
      },
      location: order.location,
      customer: order.customer
        ? {
            id: order.customer.id,
            fullName: order.customer.fullName,
            phone: order.customer.phone,
            email: order.customer.email,
          }
        : null,
      cashier: cashier?.fullName ?? null,
      branding: {
        productName: branding.productName ?? tenant?.name ?? 'Universal POS',
        tagline: branding.tagline ?? 'Point of sale',
      },
      receiptFooter:
        typeof settings.tax?.receiptFooter === 'string'
          ? settings.tax.receiptFooter
          : '',
      items: order.items.map((item) => {
        const itemMeta =
          item.meta && typeof item.meta === 'object'
            ? (item.meta as Record<string, unknown>)
            : {};
        return {
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
        tracking: {
          ...(typeof itemMeta.variantId === 'string'
            ? { variantId: itemMeta.variantId }
            : {}),
          ...(typeof itemMeta.batchId === 'string'
            ? { batchId: itemMeta.batchId }
            : {}),
          ...(typeof itemMeta.serialNumber === 'string'
            ? { serialNumber: itemMeta.serialNumber }
            : {}),
        },
      };
      }),
      fulfillment: {
        ...(typeof meta.orderType === 'string' ? { orderType: meta.orderType } : {}),
        ...(typeof meta.tableId === 'string' ? { resourceId: meta.tableId } : {}),
        ...(typeof meta.covers === 'number' ? { covers: meta.covers } : {}),
        ...(typeof meta.note === 'string' ? { note: meta.note } : {}),
      },
      rentalWindow: order.rentalExt
        ? {
            pickupDate: order.rentalExt.pickupDate,
            returnDueDate: order.rentalExt.returnDueDate,
            lifecycle: order.rentalExt.lifecycle,
          }
        : null,
      totals: {
        subtotal: order.subtotal,
        taxTotal: order.taxTotal,
        discountTotal: order.discountTotal,
        depositTotal: order.depositTotal,
        balanceDue: order.balanceDue,
      },
      payments: order.payments.map((p) => ({
        id: p.id,
        type: p.type,
        method: p.method,
        status: p.status,
        amount: p.amount,
        provider: p.provider,
        gatewayRef: p.gatewayRef,
        createdAt: p.createdAt,
      })),
      register: (() => {
        const sid = order.payments.find((p) => p.registerSessionId)
          ?.registerSessionId;
        return sid ? { sessionId: sid } : null;
      })(),
      amountPaid: succeededPayments
        .filter((p) => p.type === 'payment' || p.type === 'deposit')
        .reduce((s, p) => s + Number(p.amount), 0),
      remainingDue: order.balanceDue,
      cashTendered:
        typeof meta.cashTendered === 'string' ||
        typeof meta.cashTendered === 'number'
          ? meta.cashTendered
          : null,
      change:
        typeof meta.change === 'string' || typeof meta.change === 'number'
          ? meta.change
          : null,
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
                sellUnit: true,
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
          sellUnit: i.stockLevel?.sellUnit ?? 'pcs',
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
    const locId = locationId ?? (await this.defaultLocationId(user.tenantId, user));
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

    const paymentWhere = {
        tenantId: user.tenantId,
        method: PaymentMethod.cash,
        status: PaymentStatus.succeeded,
      OR: [
        { registerSessionId: session.id },
        {
          registerSessionId: null,
        createdAt: { gte: session.openedAt },
          order: { locationId: session.locationId },
        },
      ],
    };

    const [cashSales, cashRefunds, movements] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          ...paymentWhere,
          type: { in: [PaymentType.payment, PaymentType.deposit] },
      },
      _sum: { amount: true },
      }),
      this.prisma.payment.aggregate({
        where: {
          ...paymentWhere,
          type: { in: [PaymentType.refund, PaymentType.deposit_refund] },
        },
        _sum: { amount: true },
      }),
      this.prisma.registerCashMovement.groupBy({
        by: ['kind'],
        where: { tenantId: user.tenantId, registerSessionId: session.id },
        _sum: { amount: true },
      }),
    ]);

    const cashIn = Number(
      movements.find((m) => m.kind === RegisterCashMovementKind.cash_in)?._sum
        .amount ?? 0,
    );
    const cashDrops = Number(
      movements.find((m) => m.kind === RegisterCashMovementKind.cash_drop)?._sum
        .amount ?? 0,
    );
    const salesAmt = Number(cashSales._sum.amount ?? 0);
    const refundAmt = Number(cashRefunds._sum.amount ?? 0);
    const expected = expectedCash({
      openingFloat: Number(session.openingFloat),
      cashSales: salesAmt,
      cashIn,
      cashRefunds: refundAmt,
      cashDrops,
    });
    const counted = Number(dto.closingCash);
    const variance = cashVariance(counted, expected);

    return this.prisma.registerSession
      .update({
      where: { id: sessionId },
      data: {
        closingCash: money(counted).toFixed(2),
        closedAt: new Date(),
        meta: {
          ...((session.meta as object) ?? {}),
          expectedCash: expected,
            cashSales: salesAmt,
            cashRefunds: refundAmt,
            cashIn,
            cashDrops,
          variance,
          note: dto.note?.trim() || null,
          closedById: user.userId,
        },
      },
      })
      .then((row) => ({
      ...row,
      zReport: {
        openedAt: session.openedAt,
        closedAt: row.closedAt,
        openingFloat: Number(session.openingFloat),
          cashSales: salesAmt,
          cashRefunds: refundAmt,
          cashIn,
          cashDrops,
        expectedCash: expected,
        closingCash: counted,
        variance,
      },
    }));
  }

  async addRegisterCashMovement(
    user: AuthUser,
    sessionId: string,
    kind: RegisterCashMovementKind,
    amount: number,
    note?: string,
  ) {
    await this.assertSaleShop(user.tenantId);
    if (!(amount > 0)) {
      throw new BadRequestException('Amount must be greater than 0');
    }
    const session = await this.prisma.registerSession.findFirst({
      where: { id: sessionId, tenantId: user.tenantId, closedAt: null },
    });
    if (!session) throw new NotFoundException('Open register not found');
    return this.prisma.registerCashMovement.create({
      data: {
          tenantId: user.tenantId,
        registerSessionId: session.id,
        kind,
        amount: money(amount).toFixed(2),
        note: note?.trim() || null,
        createdById: user.userId,
      },
    });
  }

  /**
   * Block underpay when resulting open dues would exceed Customer.creditLimit.
   * null creditLimit = unlimited.
   */
  private async assertCustomerCreditLimit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    customerId: string,
  ) {
    const cust = await tx.customer.findFirst({
      where: { id: customerId, tenantId, deletedAt: null },
      select: { creditLimit: true, fullName: true },
    });
    if (!cust || cust.creditLimit == null) return;

    const limit = Number(cust.creditLimit);
    const dueAgg = await tx.order.aggregate({
      where: {
        tenantId,
        customerId,
        balanceDue: { gt: 0 },
      },
      _sum: { balanceDue: true },
    });
    const openDue = Number(dueAgg._sum.balanceDue ?? 0);
    if (openDue > limit + 1e-9) {
      throw new BadRequestException(
        `Credit limit ₹${limit.toFixed(2)} exceeded for ${cust.fullName} (open dues ₹${openDue.toFixed(2)}). Collect more payment or raise the limit.`,
      );
    }
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

  private async defaultLocationId(tenantId: string, user?: AuthUser) {
    if (user) {
      return resolveDefaultLocationId(this.prisma, user);
    }
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

  private async allocateUniqueBarcode(tenantId: string): Promise<string> {
    for (let i = 0; i < 32; i++) {
      const candidate = nextInternalCode128Candidate();
      const [p, v] = await Promise.all([
        this.prisma.product.findFirst({
          where: { tenantId, barcode: candidate },
          select: { id: true },
        }),
        this.prisma.productVariant.findFirst({
          where: { tenantId, barcode: candidate },
          select: { id: true },
        }),
      ]);
      if (!p && !v) return candidate;
    }
    throw new BadRequestException(
      'Could not generate a unique barcode — try again',
    );
  }
}
