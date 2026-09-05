import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
import {
  listSafeImageUrl,
  resolveProductPhoto,
  saveProductImage,
} from '../../common/product-image';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { nextInternalCode128Candidate, parseScaleBarcode } from '../../common/barcode';
import { resolveDefaultLocationId } from '../../common/location-access';
import { categoryIdsWithDescendants } from '../../common/category-tree';
import {
  seedZeroStockAtOtherLocations,
  seedZeroStockForNewLocation,
} from '../../common/stock-at-location';
import { LowStockAlertService } from '../notify/low-stock-alert.service';
import { StockMutationEngine } from '../inventory/stock-mutation.engine';
import { RestaurantService } from '../restaurant/restaurant.service';
import { BillingService } from '../billing/billing.service';

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
  resolveProductTaxInclusive,
  INDIAN_GST_STATES,
  extractGstStateCode,
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
import { UnitPricingService } from '../catalog/unit-pricing.service';
import type { LineCalcResult, CustomerContext } from '../catalog/pricing-engine';
import { d } from '../catalog/pricing-engine';
import {
  calcMeta,
  inventoryQtyOf,
  orderLineSnapshotFields,
} from './pos-qty';
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
  SaleQuoteDto,
  UpdateSaleProductDto,
  UploadSaleImageDto,
} from './dto/pos.dto';
import { ImportSaleProductsDto } from './dto/import-sale-products.dto';
import { resolveCashRoundOffAmount } from './payment-rounding';

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
  private readonly log = new Logger(PosService.name);

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
    private readonly restaurant: RestaurantService,
    private readonly billing: BillingService,
    private readonly unitPricing: UnitPricingService,
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
    const isRental = dto.itemType === 'rental';
    const trackInventory =
      isService || isRental ? false : dto.trackInventory !== false;
    const trackSerial = Boolean(dto.serialTracking) || isRental;

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
      const photoUrl = await resolveProductPhoto(
        user.tenantId,
        dto.image ?? dto.photoUrl,
      );

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
            : isRental
              ? 'rental'
              : dto.isComposite
                ? 'bundle'
                : 'physical',
          fulfillmentMode: isService
            ? FulfillmentMode.service
            : isRental
              ? FulfillmentMode.rental
              : FulfillmentMode.sale,
          trackQty: trackInventory,
          trackSerial,
          trackBatch: Boolean(dto.batchTracking) && !isService && !isRental,
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
            itemType: isService ? 'service' : isRental ? 'rental' : 'goods',
            itemStructure: dto.itemStructure === 'variants' ? 'variants' : 'single',
            ...(photoUrl ? { images: [photoUrl] } : {}),
            ...(isService &&
            dto.durationMinutes != null &&
            Number.isFinite(dto.durationMinutes) &&
            dto.durationMinutes > 0
              ? { durationMinutes: Math.round(Number(dto.durationMinutes)) }
              : {}),
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
      if (isRental) {
        const rentalUnitsCount = Math.max(1, Math.round(Number(dto.qty) || 1));
        for (let u = 0; u < rentalUnitsCount; u++) {
          const unitBarcode =
            u === 0
              ? (barcode || `${dto.sku.trim().toUpperCase()}-1`)
              : `${dto.sku.trim().toUpperCase()}-${u + 1}`;
          await this.prisma.stockUnit
            .create({
              data: {
                tenantId: user.tenantId,
                locationId,
                productId: product.id,
                barcodeSku: unitBarcode,
                variantLabel: 'Standard',
                condition: 'good',
                status: 'available',
                ownership: 'own',
                depositAmount: Number(dto.costPrice ?? 0).toFixed(2),
                meta: { rentalPrice: price },
              },
            })
            .catch(() => null);
        }
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
      const image = row.image ?? row.photoUrl;
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

        const isService = row.itemType === 'service';
        const isRental = row.itemType === 'rental';
        const res = await this.addSaleProduct(user, {
          title: row.title,
          description: row.description,
          categoryId: cat.id,
          sku: row.sku,
          sellUnit: isService
            ? row.sellUnit || 'service'
            : row.sellUnit,
          price: row.price,
          qty: isService ? 0 : row.qty ?? 0,
          locationId,
          manufacturer: row.manufacturer,
          barcode: row.barcode,
          costPrice: row.costPrice,
          reorderPoint: row.reorderPoint,
          hsnOrSac: row.hsnOrSac,
          itemType: isService ? 'service' : isRental ? 'rental' : 'goods',
          durationMinutes: row.durationMinutes,
          trackInventory: isService || isRental
            ? false
            : row.trackInventory === false && !(Number(row.qty) > 0)
              ? false
              : true,
          image,
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
        const text = Array.isArray(message) ? message.join(', ') : message;
        if (/SKU already exists/i.test(text) && image?.trim()) {
          const attached = await this.attachSaleProductImageBySku(
            user,
            locationId,
            row.sku,
            image,
          );
          if (attached) {
            created.push({
              sku: row.sku,
              title: row.title,
              id: attached,
            });
            continue;
          }
        }
        errors.push({
          row: i + 1,
          sku: row.sku,
          message: text,
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

  /** If SKU already exists, attach CSV image_url onto that item. */
  private async attachSaleProductImageBySku(
    user: AuthUser,
    locationId: string,
    sku: string,
    image: string,
  ): Promise<string | null> {
    const code = sku.trim().toUpperCase();
    const level = await this.prisma.stockLevel.findFirst({
      where: {
        tenantId: user.tenantId,
        locationId,
        sku: code,
        product: { fulfillmentMode: FulfillmentMode.sale },
      },
      include: { product: true },
    });
    if (!level) return null;
    const photoUrl = await resolveProductPhoto(user.tenantId, image);
    if (!photoUrl) return null;
    const existing = productImageList(
      level.product.photoUrl,
      level.product.meta,
    );
    const images = [photoUrl, ...existing.filter((u) => u !== photoUrl)].slice(
      0,
      MAX_PRODUCT_IMAGES,
    );
    const meta = asMeta(level.product.meta);
    await this.prisma.product.update({
      where: { id: level.productId },
      data: {
        photoUrl,
        meta: { ...meta, images } as Prisma.InputJsonValue,
      },
    });
    return level.id;
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
        const cover =
          listSafeImageUrl(
            productImageList(r.product.photoUrl, r.product.meta)[0] ??
              r.product.photoUrl,
          ) ?? null;
        return {
        id: r.id,
        productId: r.productId,
        sku: r.sku,
        title: r.product.name,
        description: r.product.description,
          image: cover,
          photoUrl: cover,
          images: cover ? [cover] : [],
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
      const levelPatch: Prisma.StockLevelUpdateInput = {
        ...(dto.price !== undefined
          ? { sellPrice: Number(dto.price).toFixed(2) }
          : {}),
        ...(dto.sellUnit !== undefined ? { sellUnit } : {}),
      };
      if (Object.keys(levelPatch).length) {
        await tx.stockLevel.update({
          where: { id: level.id },
          data: levelPatch,
        });
      }
      if (nextQty !== undefined) {
        const delta = nextQty - Number(level.qtyOnHand);
        if (Math.abs(delta) >= 1e-9) {
          await this.stock.mutateInTx(tx, {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            locationId: level.locationId,
            stockLevelId: level.id,
            qty: delta,
            type: StockLedgerType.adjustment,
            reason: 'Item qty update',
            referenceType: 'product',
            referenceId: level.productId,
            skipComponentExplosion: true,
          });
        }
      }
    });

    return this.getSaleProduct(user, stockLevelId);
  }

  async adjustSaleStock(
    user: AuthUser,
    stockLevelId: string,
    dto: AdjustSaleStockDto,
  ) {
    await this.assertSaleShop(user.tenantId);
    let level = await this.prisma.stockLevel.findFirst({
      where: { id: stockLevelId, tenantId: user.tenantId },
      include: {
        product: { select: { id: true, name: true, skuCode: true, trackSerial: true } },
      },
    });
    if (!level) {
      const locationId = await this.defaultLocationId(user.tenantId, user);
      level = await this.prisma.stockLevel.findFirst({
        where: {
          tenantId: user.tenantId,
          productId: stockLevelId,
          ...(locationId ? { locationId } : {}),
        },
        include: {
          product: { select: { id: true, name: true, skuCode: true, trackSerial: true } },
        },
        orderBy: { updatedAt: 'desc' },
      });
    }
    if (!level) throw new NotFoundException('Product not found');

    if (level.product.trackSerial === true && !dto.serialNumber?.trim()) {
      throw new BadRequestException('Serial number is required for this product');
    }

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
      serialNumber: dto.serialNumber?.trim() || undefined,
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

    void this.lowStock.evaluate({
      tenantId: user.tenantId,
      locationId: level.locationId,
      productId: level.productId,
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
  async listRecentSales(user: AuthUser, limit = 20, locationId?: string) {
    await this.assertSaleShop(user.tenantId);
    const take = Math.min(Math.max(limit, 1), 50);
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: user.tenantId,
        kind: OrderKind.sale,
        status: { in: [OrderStatus.closed, OrderStatus.fulfilled] },
        ...(locationId ? { locationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        subtotal: true,
        taxTotal: true,
        discountTotal: true,
        balanceDue: true,
        createdAt: true,
        customer: { select: { fullName: true, phone: true } },
        items: {
          take: 8,
          select: {
            description: true,
            product: { select: { name: true } },
          },
        },
        _count: { select: { items: true } },
      },
    });
    return {
      items: orders.map((o) => {
        const productNames = o.items.map(
          (i) => i.product?.name || i.description || 'Item',
        );
        const more = Math.max(0, o._count.items - productNames.length);
        return {
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        subtotal: o.subtotal,
        taxTotal: o.taxTotal,
        discountTotal: o.discountTotal,
        balanceDue: o.balanceDue,
        total: Math.max(
          0,
          Number(o.subtotal) + Number(o.taxTotal) - Number(o.discountTotal),
        ),
        createdAt: o.createdAt,
        customerName: o.customer?.fullName ?? 'Walk-in',
        itemCount: o._count.items,
        productNames,
        productSummary:
          productNames.join(', ') + (more > 0 ? ` +${more}` : ''),
      };
      }),
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

  /** Persist originalAmount / roundOffAmount / finalAmount on order meta. */
  private async persistPaymentRoundingMeta(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    input: {
      originalAmount: number;
      roundOffAmount: number;
      finalAmount: number;
    },
  ) {
    const order = await tx.order.findFirstOrThrow({
      where: { id: orderId, tenantId },
      select: { meta: true },
    });
    const prevMeta = asMeta(order.meta);
    const originalAmount = Number(input.originalAmount.toFixed(2));
    const roundOffAmount = Number(input.roundOffAmount.toFixed(2));
    const finalAmount = Number(input.finalAmount.toFixed(2));
    await tx.order.update({
      where: { id: orderId },
      data: {
        meta: {
          ...prevMeta,
          roundOff: roundOffAmount,
          roundOffAmount,
          originalAmount,
          finalAmount,
          exactTotal: originalAmount,
          roundedTotal: finalAmount,
        },
      },
    });
  }

  /**
   * Apply nearest-rupee half-up round-off so balanceDue matches collectable ₹.
   * Positive → Round off fee; negative → write-off into discountTotal (not cashier %).
   */
  private async applyCheckoutRoundOff(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
    roundOffAmount: number | undefined,
    exactBalanceDue: number,
  ) {
    const ro = Number(roundOffAmount ?? 0);
    const originalAmount = Number(exactBalanceDue);

    if (Number.isFinite(ro) && Math.abs(ro) >= 0.005) {
      if (Math.abs(ro) > 0.99) {
        throw new BadRequestException('Round off must be within ±0.99');
      }

      const order = await tx.order.findFirstOrThrow({
        where: { id: orderId, tenantId },
        select: { discountTotal: true },
      });

      if (ro > 0) {
        await tx.orderFee.create({
          data: {
            tenantId,
            orderId,
            feeCode: 'round_off',
            reason: 'Round off',
            amount: money(ro).toFixed(2),
          },
        });
      } else {
        const nextDisc = money(order.discountTotal).plus(Math.abs(ro));
        await tx.order.update({
          where: { id: orderId },
          data: { discountTotal: nextDisc.toFixed(2) },
        });
      }

      await this.ordersService.recalculateTotals(tx, tenantId, orderId);
    }

    const after = await tx.order.findFirstOrThrow({
      where: { id: orderId, tenantId },
      select: { balanceDue: true },
    });

    await this.persistPaymentRoundingMeta(tx, tenantId, orderId, {
      originalAmount,
      roundOffAmount: Math.abs(ro) >= 0.005 ? ro : 0,
      finalAmount: Number(after.balanceDue),
    });
  }

  /** Cash-only: auto-compute or validate round-off; digital/split → reject. */
  private resolveCashRoundOff(
    roundOffAmount: number | undefined,
    payments: Array<{ method: PaymentMethod }> | undefined,
    exactBalanceDue: number,
  ): number | undefined {
    try {
      return resolveCashRoundOffAmount(
        roundOffAmount,
        payments,
        exactBalanceDue,
      );
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Invalid round off',
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

    try {
      // Cap so opening the counter never dumps the full catalog into one INSERT
      // (that filled Postgres WAL and surfaced as 53100 disk-full).
      await seedZeroStockForNewLocation(this.prisma, {
        tenantId: user.tenantId,
        locationId,
        maxRows: 250,
      });
    } catch (err) {
      this.log.warn(
        `Could not backfill zero stock at location ${locationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

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
              baseUnitId: true,
              pricingUnitId: true,
              pricingStrategy: true,
              pricePerPricingUnit: true,
              baseUnit: {
                select: {
                  id: true,
                  symbol: true,
                  name: true,
                  unitGroupId: true,
                },
              },
              pricingUnit: { select: { id: true, symbol: true, name: true } },
              productUnits: {
                where: { effectiveTo: null },
                select: {
                  unitId: true,
                  conversionToBase: true,
                  fixedPrice: true,
                  isDefaultSellingUnit: true,
                  unit: { select: { id: true, symbol: true, name: true } },
                },
              },
            category: { select: { id: true, name: true } },
          },
        },
        location: { select: { id: true, name: true, code: true } },
      },
      }),
    ]);

    const productIds = items.map((r) => r.productId);
    const systemUnits = await this.prisma.unit.findMany({
      where: { isActive: true, tenantId: null },
      select: {
        id: true,
        symbol: true,
        name: true,
        unitGroupId: true,
      },
      orderBy: [{ isBaseUnit: 'desc' }, { symbol: 'asc' }],
    });
    const unitsByGroup = new Map<string, typeof systemUnits>();
    for (const u of systemUnits) {
      const list = unitsByGroup.get(u.unitGroupId) ?? [];
      list.push(u);
      unitsByGroup.set(u.unitGroupId, list);
    }
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
        const images = productImageList(row.product.photoUrl, row.product.meta)
          .map((u) => listSafeImageUrl(u))
          .filter((u): u is string => Boolean(u));
        const cover =
          listSafeImageUrl(images[0] ?? row.product.photoUrl) ?? null;
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
          images: cover ? [cover] : [],
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
          recipeTracked: meta.recipeTracked === true,
          pricingStrategy: row.product.pricingStrategy,
          pricePerPricingUnit:
            row.product.pricePerPricingUnit != null
              ? Number(row.product.pricePerPricingUnit)
              : null,
          baseUnitId: row.product.baseUnitId,
          pricingUnitId: row.product.pricingUnitId,
          baseUnit: row.product.baseUnit,
          pricingUnit: row.product.pricingUnit,
          productUnits: (row.product.productUnits ?? []).map((pu) => ({
            unitId: pu.unitId,
            symbol: pu.unit.symbol,
            name: pu.unit.name,
            conversionToBase: Number(pu.conversionToBase),
            fixedPrice:
              pu.fixedPrice != null ? Number(pu.fixedPrice) : null,
            isDefaultSellingUnit: pu.isDefaultSellingUnit,
          })),
          baseUnitSymbol: row.product.baseUnit?.symbol ?? row.sellUnit ?? null,
          pricingUnitSymbol: row.product.pricingUnit?.symbol ?? null,
          /** Counter entry units: explicitly configured product units + base/pricing unit */
          entryUnits: (() => {
            const map = new Map<
              string,
              {
                unitId: string;
                symbol: string;
                name: string;
                conversionToBase?: number;
                isDefaultSellingUnit?: boolean;
              }
            >();
            const baseRef = row.product.baseUnit;
            if (baseRef) {
              map.set(baseRef.id, {
                unitId: baseRef.id,
                symbol: baseRef.symbol,
                name: baseRef.name,
                conversionToBase: 1,
              });
            } else {
              const matchedUnit = systemUnits.find(
                (u) =>
                  u.symbol.toLowerCase() ===
                  (row.sellUnit ?? '').trim().toLowerCase(),
              );
              if (matchedUnit) {
                map.set(matchedUnit.id, {
                  unitId: matchedUnit.id,
                  symbol: matchedUnit.symbol,
                  name: matchedUnit.name,
                  conversionToBase: 1,
                });
              }
            }
            if (row.product.pricingUnit) {
              const pu = row.product.productUnits?.find(
                (p) => p.unitId === row.product.pricingUnitId,
              );
              map.set(row.product.pricingUnit.id, {
                unitId: row.product.pricingUnit.id,
                symbol: row.product.pricingUnit.symbol,
                name: row.product.pricingUnit.name,
                conversionToBase: pu ? Number(pu.conversionToBase) : undefined,
                isDefaultSellingUnit: pu?.isDefaultSellingUnit,
              });
            }
            for (const pu of row.product.productUnits ?? []) {
              map.set(pu.unitId, {
                unitId: pu.unitId,
                symbol: pu.unit.symbol,
                name: pu.unit.name,
                conversionToBase: Number(pu.conversionToBase),
                isDefaultSellingUnit: pu.isDefaultSellingUnit,
              });
            }
            return [...map.values()];
          })(),
          channelPrices: (() => {
            const nested =
              meta.channelPrices && typeof meta.channelPrices === 'object'
                ? (meta.channelPrices as Record<string, unknown>)
                : {};
            const num = (v: unknown) => {
              const n = Number(v);
              return Number.isFinite(n) && n > 0 ? n : undefined;
            };
            return {
              dine_in: num(nested.dine_in ?? meta.dineInPrice),
              takeaway: num(nested.takeaway ?? meta.takeawayPrice),
              delivery: num(nested.delivery ?? meta.deliveryPrice),
              online: num(nested.online ?? meta.onlinePrice),
            };
          })(),
          modifierGroups: Array.isArray(meta.modifierGroups)
            ? meta.modifierGroups
            : undefined,
          soldOut:
            meta.soldOut === true ||
            meta.soldOut === 'true' ||
            meta.soldOut === 'yes',
          foodType: (() => {
            const raw = String(meta.foodType ?? '')
              .trim()
              .toLowerCase()
              .replace(/[\s-]+/g, '_');
            if (raw === 'veg' || raw === 'vegetarian') return 'veg';
            if (
              raw === 'non_veg' ||
              raw === 'nonveg' ||
              raw === 'non_vegetarian'
            )
              return 'non_veg';
            if (raw === 'egg' || raw === 'eggetarian') return 'egg';
            return null;
          })(),
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
    const scale = parseScaleBarcode(raw);

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
            kind: true,
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
                kind: true,
                category: { select: { id: true, name: true } },
              },
            },
          },
        });
      }
    }

    if (!row) {
      const pu = await this.prisma.productUnit.findFirst({
        where: {
          tenantId: user.tenantId,
          effectiveTo: null,
          barcode: { equals: raw, mode: 'insensitive' },
        },
        include: { product: { select: { id: true } } },
      });
      if (pu) {
        row = await this.prisma.stockLevel.findFirst({
          where: {
            tenantId: user.tenantId,
            locationId,
            productId: pu.productId,
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
                kind: true,
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
      kind: row.product.kind,
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
      ...(scale
        ? {
            scanQty: Number(scale.quantity),
            scanUnitHint: scale.unitHint ?? null,
          }
        : {}),
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
      sellingUnitId?: string;
      sellingUnitSymbol?: string;
      unitPrice?: number;
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
    const qtyEntered = line.quantity;
    const qtyErr = validateSellQty(qtyEntered, unit, units);
    let calc: LineCalcResult | null = null;
    try {
      calc = await this.unitPricing.calculateLine(user, {
        productId: level.productId,
        enteredQty: qtyEntered,
        sellingUnitId: line.sellingUnitId,
        sellingUnitSymbol: line.sellingUnitSymbol ?? (line.sellingUnitId ? undefined : level.sellUnit),
        unitPriceOverride: line.unitPrice,
        inventorySign: -1,
      });
    } catch (e) {
      if (line.sellingUnitId || line.sellingUnitSymbol) {
        throw e;
      }
      if (qtyErr) {
        throw new BadRequestException(`${level.sku}: ${qtyErr}`);
      }
    }

    const inventoryQty = calc ? calc.baseQuantity : d(qtyEntered);

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
    const available = d(sellLevel.qtyOnHand).sub(d(sellLevel.qtyReserved ?? 0));
    if (tracks && (available.lte(0) || available.add('0.000000001').lt(inventoryQty))) {
      throw new BadRequestException(
        `Insufficient stock for ${sellLevel.sku} (${sellLevel.product.name}): available ${available.toFixed(2)} ${calc?.baseUnitSymbol ?? unit}, need ${inventoryQty.toFixed(2)} ${calc?.baseUnitSymbol ?? unit}`,
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

    return { level: sellLevel, qty: qtyEntered, tracks, calc, inventoryQty };
  }

  /**
   * Authoritative cart calculation preview (Flipkart product discounts, bill discounts, GST, round-off).
   * Frontend only displays results from backend authoritative calculation.
   */
  async quoteSale(user: AuthUser, dto: SaleQuoteDto) {
    await this.assertCounterShop(user.tenantId);

    const tenant = await this.prisma.tenant.findFirstOrThrow({
      where: { id: user.tenantId },
      select: { currencyCode: true, taxMode: true, taxId: true, settings: true },
    });
    const taxProfile = buildTaxProfile({
      taxMode: tenant.taxMode,
      taxId: tenant.taxId,
      settings: tenant.settings,
    });

    let customerCtx: CustomerContext | undefined;
    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId: user.tenantId, deletedAt: null },
        select: { id: true, meta: true },
      });
      if (customer) {
        const meta = (customer.meta as Record<string, unknown> | null) ?? {};
        customerCtx = {
          id: customer.id,
          tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
          tier: typeof meta.tier === 'string' ? meta.tier : undefined,
        };
      }
    }

    const calculatedLines: Array<{
      stockLevelId: string;
      sku: string;
      name: string;
      quantity: number;
      mrp: string;
      grossMrp: string;
      sellingPrice: string;
      productDiscountPerUnit: string;
      productDiscount: string;
      productDiscountPercent: number;
      productNet: string;
      hasProductDiscount: boolean;
      taxRatePercent: number;
      taxInclusive: boolean;
      taxCode: string | null;
      hsnOrSac: string | null;
      calc: LineCalcResult;
    }> = [];

    let grossMrpTotal = new Prisma.Decimal(0);
    let productDiscountTotal = new Prisma.Decimal(0);
    let productNetTotal = new Prisma.Decimal(0);

    for (const item of dto.items) {
      const level = await this.prisma.stockLevel.findFirst({
        where: { id: item.stockLevelId, tenantId: user.tenantId },
        include: { product: true },
      });
      if (!level) {
        throw new NotFoundException(`Stock level not found: ${item.stockLevelId}`);
      }

      const productRatePct = resolveProductTaxRatePercent({
        taxCode: level.product.taxCode,
        meta: level.product.meta,
      });
      const isProductInclusive = resolveProductTaxInclusive({
        meta: level.product.meta,
        storeDefault: taxProfile.inclusive,
      });

      const calc = await this.unitPricing.calculateLine(user, {
        productId: level.productId,
        enteredQty: item.quantity,
        sellingUnitId: item.sellingUnitId,
        sellingUnitSymbol: item.sellingUnitSymbol ?? (item.sellingUnitId ? undefined : level.sellUnit),
        unitPriceOverride: item.unitPrice,
        customer: customerCtx,
        inventorySign: -1,
      });

      grossMrpTotal = grossMrpTotal.add(calc.grossMrp);
      productDiscountTotal = productDiscountTotal.add(calc.productDiscount);
      productNetTotal = productNetTotal.add(calc.productNet);

      calculatedLines.push({
        stockLevelId: level.id,
        sku: level.sku,
        name: level.product.name,
        quantity: item.quantity,
        mrp: calc.mrp.toFixed(2),
        grossMrp: calc.grossMrp.toFixed(2),
        sellingPrice: calc.sellingPrice.toFixed(2),
        productDiscountPerUnit: calc.productDiscountPerUnit.toFixed(2),
        productDiscount: calc.productDiscount.toFixed(2),
        productDiscountPercent: calc.productDiscountPercent,
        productNet: calc.productNet.toFixed(2),
        hasProductDiscount: calc.hasProductDiscount,
        taxRatePercent: productRatePct != null ? productRatePct : Number((taxProfile.rate * 100).toFixed(2)),
        taxInclusive: isProductInclusive,
        taxCode: level.product.taxCode ?? null,
        hsnOrSac: ((level.product.meta as Record<string, unknown>)?.hsnOrSac as string) ?? level.product.taxCode ?? null,
        calc,
      });
    }

    // Evaluate coupon discount if code provided
    let couponDiscount = money(0);
    if (dto.couponCode?.trim()) {
      try {
        const c = await this.loyalty.validate(user, {
          code: dto.couponCode.trim(),
          orderSubtotal: Number(productNetTotal.toFixed(2)),
        });
        if (c?.amountOff) {
          couponDiscount = money(c.amountOff);
        }
      } catch {
        // invalid coupon ignored for quote preview
      }
    }

    // Evaluate loyalty discount if points provided
    let loyaltyDiscount = money(0);
    if (dto.loyaltyPointsToRedeem && dto.loyaltyPointsToRedeem > 0 && dto.customerId) {
      try {
        const loyaltySettings = await this.loyalty.getLoyaltySettings(user);
        if (loyaltySettings.enabled && loyaltySettings.currencyPerPoint > 0) {
          const val = dto.loyaltyPointsToRedeem * loyaltySettings.currencyPerPoint;
          loyaltyDiscount = money(val);
        }
      } catch {
        // invalid loyalty settings ignored for quote preview
      }
    }

    const cashierDiscount = money(dto.discountAmount ?? 0);
    const totalBillDiscount = Prisma.Decimal.min(
      cashierDiscount.add(couponDiscount).add(loyaltyDiscount),
      productNetTotal,
    );

    // Proportional bill discount allocation across lines before GST (Rule 8)
    let billDiscountLeft = totalBillDiscount;
    let taxableValueTotal = money(0);
    let taxTotal = money(0);
    const taxSlabMap = new Map<number, Prisma.Decimal>();

    const linesOutput = calculatedLines.map((line, idx) => {
      let lineBillDiscount = money(0);
      if (totalBillDiscount.gt(0) && productNetTotal.gt(0)) {
        if (idx === calculatedLines.length - 1) {
          lineBillDiscount = billDiscountLeft;
        } else {
          lineBillDiscount = totalBillDiscount
            .mul(line.calc.productNet)
            .div(productNetTotal)
            .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
          billDiscountLeft = billDiscountLeft.sub(lineBillDiscount);
        }
      }
      const lineTaxableGross = Prisma.Decimal.max(money(0), line.calc.productNet.sub(lineBillDiscount));
      const taxed = computeLineTax(taxProfile, {
        lineGross: lineTaxableGross,
        inclusive: line.taxInclusive,
        rate: line.taxRatePercent / 100,
      });

      taxableValueTotal = taxableValueTotal.add(taxed.lineTotal);
      taxTotal = taxTotal.add(taxed.taxAmount);

      const slabRate = line.taxRatePercent;
      taxSlabMap.set(slabRate, (taxSlabMap.get(slabRate) ?? money(0)).add(taxed.taxAmount));

      return {
        stockLevelId: line.stockLevelId,
        sku: line.sku,
        name: line.name,
        quantity: line.quantity,
        mrp: line.mrp,
        grossMrp: line.grossMrp,
        sellingPrice: line.sellingPrice,
        productDiscountPerUnit: line.productDiscountPerUnit,
        productDiscount: line.productDiscount,
        productDiscountPercent: line.productDiscountPercent,
        productNet: line.productNet,
        hasProductDiscount: line.hasProductDiscount,
        allocatedBillDiscount: lineBillDiscount.toFixed(2),
        taxRatePercent: line.taxRatePercent,
        taxInclusive: line.taxInclusive,
        taxCode: line.taxCode,
        hsnOrSac: line.hsnOrSac,
        taxableAmount: taxed.lineTotal.toFixed(2),
        taxAmount: taxed.taxAmount.toFixed(2),
        lineTotal: taxed.lineTotal.toFixed(2),
        finalAmount: line.taxInclusive
          ? lineTaxableGross.toFixed(2)
          : taxed.lineTotal.add(taxed.taxAmount).toFixed(2),
      };
    });

    const taxSlabs = [...taxSlabMap.entries()].map(([rate, taxDec]) => {
      const halfRate = Math.round((rate / 2) * 100) / 100;
      const cgstDec = taxDec.div(2).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const sgstDec = taxDec.sub(cgstDec);
      return {
        rate,
        tax: Number(taxDec.toFixed(2)),
        halfRate,
        cgst: Number(cgstDec.toFixed(2)),
        sgst: Number(sgstDec.toFixed(2)),
      };
    });

    const exactGrand = taxableValueTotal.add(taxTotal);
    const exactGrandNum = Number(exactGrand.toFixed(2));
    const isCash = dto.paymentMethod === 'cash';
    const roundedTotal = isCash ? Math.round(exactGrandNum) : exactGrandNum;
    const roundOff = Number((roundedTotal - exactGrandNum).toFixed(2));

    return {
      items: linesOutput,
      grossMrpTotal: grossMrpTotal.toFixed(2),
      productDiscountTotal: productDiscountTotal.toFixed(2),
      productNetTotal: productNetTotal.toFixed(2),
      billDiscountTotal: totalBillDiscount.toFixed(2),
      cashierDiscount: cashierDiscount.toFixed(2),
      couponDiscount: couponDiscount.toFixed(2),
      loyaltyDiscount: loyaltyDiscount.toFixed(2),
      taxableValue: taxableValueTotal.toFixed(2),
      taxTotal: taxTotal.toFixed(2),
      taxSlabs,
      roundOff: roundOff.toFixed(2),
      grandTotal: exactGrand.toFixed(2),
      amountDue: roundedTotal.toFixed(2),
      finalPayable: roundedTotal.toFixed(2),
    };
  }

  /**
   * Unpaid sale ticket for Stripe card/UPI.
   * Stock is NOT decremented until Stripe verify succeeds.
   */
  async prepareSaleCheckout(user: AuthUser, dto: PrepareSaleCheckoutDto) {
    await this.assertSaleShop(user.tenantId);

    if (
      dto.roundOffAmount !== undefined &&
      Math.abs(Number(dto.roundOffAmount)) >= 0.005
    ) {
      throw new BadRequestException(
        'Round off applies only to cash checkout — card/UPI/QR pay the exact amount',
      );
    }

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
        const { level, qty, calc, inventoryQty } = await this.resolvePosSaleLine(
          tx,
          user,
          dto.locationId,
          line,
        );

        const productRatePct = resolveProductTaxRatePercent({
          taxCode: level.product.taxCode,
          meta: level.product.meta,
        });
        const isProductInclusive = resolveProductTaxInclusive({
          meta: level.product.meta,
          storeDefault: taxProfile.inclusive,
        });
        const unitPrice = calc
          ? calc.sellingPrice
          : line.unitPrice !== undefined
            ? money(line.unitPrice)
            : money(level.sellPrice);
        const lineNet = calc
          ? calc.productNet
          : unitPrice.mul(qty);
        const taxed = computeLineTax(taxProfile, {
          lineGross: lineNet,
          inclusive: isProductInclusive,
          ...(productRatePct != null
            ? { rate: productRatePct / 100 }
            : {}),
        });
        const snap = calc ? orderLineSnapshotFields(calc) : null;
        const lineMeta: Record<string, unknown> = {
          taxRate:
            productRatePct != null ? productRatePct / 100 : taxProfile.rate,
          taxRatePercent:
            productRatePct != null
              ? productRatePct
              : Number((taxProfile.rate * 100).toFixed(2)),
          taxInclusive: isProductInclusive,
          taxCode: level.product.taxCode ?? null,
          hsnOrSac:
            (level.product.meta as Record<string, unknown>)?.hsnOrSac ??
            level.product.taxCode ??
            null,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          ...(line.batchId ? { batchId: line.batchId } : {}),
          ...(line.serialNumber?.trim()
            ? { serialNumber: line.serialNumber.trim() }
            : {}),
          ...(calc ? calcMeta(calc) : {}),
        };

        await tx.orderItem.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: snap?.quantity ?? qty,
            unitPrice: (snap?.unitPrice ?? unitPrice.toFixed(4)) as string,
            lineTotal: taxed.lineTotal.toFixed(2),
            taxAmount: taxed.taxAmount.toFixed(2),
            ...(snap
              ? {
                  orderedQuantity: snap.orderedQuantity,
                  orderedUnitId: snap.orderedUnitId,
                  orderedUnitSymbol: snap.orderedUnitSymbol,
                  baseQuantity: snap.baseQuantity,
                  baseUnitId: snap.baseUnitId,
                  baseUnitSymbol: snap.baseUnitSymbol,
                  conversionFactor: snap.conversionFactor,
                  priceSource: snap.priceSource,
                }
              : { baseQuantity: inventoryQty }),
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

      const merchAfterDisc = Math.max(
        0,
        merchandise - Number(dto.discountAmount ?? 0),
      );
      await this.restaurant.attachCounterDining(tx, {
        tenantId: user.tenantId,
        userId: user.userId,
        orderId: created.id,
        locationId: dto.locationId,
        meta: {
          ...(dto.meta && typeof dto.meta === 'object' ? dto.meta : {}),
          ...(dto.note ? { note: dto.note } : {}),
        },
        merchandiseAfterDiscount: merchAfterDisc,
      });

      await this.ordersService.recalculateTotals(
        tx,
        user.tenantId,
        created.id,
      );

      const preRound = await tx.order.findFirstOrThrow({
        where: { id: created.id },
        select: { balanceDue: true },
      });
      const exactDue = Number(preRound.balanceDue);
      await this.persistPaymentRoundingMeta(tx, user.tenantId, created.id, {
        originalAmount: exactDue,
        roundOffAmount: 0,
        finalAmount: exactDue,
      });

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
        const qty = inventoryQtyOf(item).toNumber();
        const level = await tx.stockLevel.findFirst({
          where: { id: item.stockLevelId, tenantId: user.tenantId },
          include: { product: { select: { trackQty: true } } },
        });
        if (!level) {
          throw new NotFoundException(`Stock level missing for line ${item.id}`);
        }
        if (level.product.trackQty !== false) {
          const recipe = await this.stock.hasRecipeExplosion(
            tx,
            user.tenantId,
            level.productId,
          );
          if (recipe) {
            await this.stock.consumeForParent(tx, {
              tenantId: user.tenantId,
              actorUserId: user.userId,
              locationId: order.locationId,
              productId: level.productId,
              parentQty: qty,
              referenceType: 'order',
              referenceId: orderId,
            });
          } else {
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
        } else {
          await this.stock.consumeForParent(tx, {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            locationId: order.locationId,
            productId: level.productId,
            parentQty: qty,
            referenceType: 'order',
            referenceId: orderId,
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

    await this.releaseDiningIfAny(user.tenantId, orderId, user.userId);
    try {
      await this.restaurant.ensureKotAfterSale(user, orderId);
    } catch {
      /* dining overlay optional */
    }

    const latestPay = await this.prisma.payment.findFirst({
      where: {
        tenantId: user.tenantId,
        orderId,
        status: PaymentStatus.succeeded,
        type: { in: [PaymentType.payment, PaymentType.deposit] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (latestPay) {
      await this.issueCheckoutInvoices(
        user,
        orderId,
        [latestPay],
        Number(latestPay.amount),
      );
    }

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
        const { level, qty, tracks, calc, inventoryQty } =
          await this.resolvePosSaleLine(
            tx,
            user,
            dto.locationId,
            line,
          );

        const productRatePct = resolveProductTaxRatePercent({
          taxCode: level.product.taxCode,
          meta: level.product.meta,
        });
        const isProductInclusive = resolveProductTaxInclusive({
          meta: level.product.meta,
          storeDefault: taxProfile.inclusive,
        });
        const unitPrice = calc
          ? calc.sellingPrice
          : line.unitPrice !== undefined
            ? money(line.unitPrice)
            : money(level.sellPrice);
        const lineNet = calc
          ? calc.productNet
          : unitPrice.mul(qty);
        const taxed = computeLineTax(taxProfile, {
          lineGross: lineNet,
          inclusive: isProductInclusive,
          ...(productRatePct != null
            ? { rate: productRatePct / 100 }
            : {}),
        });
        const snap = calc ? orderLineSnapshotFields(calc) : null;
        const inv = inventoryQty;
        const invKey = inv.toFixed();
        const lineMeta: Record<string, unknown> = {
          taxRate:
            productRatePct != null ? productRatePct / 100 : taxProfile.rate,
          taxRatePercent:
            productRatePct != null
              ? productRatePct
              : Number((taxProfile.rate * 100).toFixed(2)),
          taxInclusive: isProductInclusive,
          taxCode: level.product.taxCode ?? null,
          hsnOrSac:
            (level.product.meta as Record<string, unknown>)?.hsnOrSac ??
            level.product.taxCode ??
            null,
          ...(line.variantId ? { variantId: line.variantId } : {}),
          ...(line.batchId ? { batchId: line.batchId } : {}),
          ...(line.serialNumber?.trim()
            ? { serialNumber: line.serialNumber.trim() }
            : {}),
          ...(calc ? calcMeta(calc) : {}),
        };

        if (tracks) {
          const recipe = await this.stock.hasRecipeExplosion(
            tx,
            user.tenantId,
            level.productId,
          );
          if (recipe) {
            await this.stock.consumeForParent(tx, {
              tenantId: user.tenantId,
              actorUserId: user.userId,
              locationId: dto.locationId,
              productId: level.productId,
              parentQty: Number(invKey),
              referenceType: 'order',
              referenceId: created.id,
            });
          } else {
            const mut = await this.stock.mutateInTx(tx, {
              tenantId: user.tenantId,
              actorUserId: user.userId,
              locationId: dto.locationId,
              stockLevelId: level.id,
              productId: level.productId,
              variantId: line.variantId,
              batchId: line.batchId,
              serialNumber: line.serialNumber,
              qty: `-${invKey}`,
              type: StockLedgerType.sale,
              referenceType: 'order',
              referenceId: created.id,
              idempotencyKey: `sale:${created.id}:${level.id}:${invKey}:${line.variantId ?? ''}:${line.batchId ?? ''}:${line.serialNumber ?? ''}`,
            });
            if (mut.batchId) lineMeta.batchId = mut.batchId;
            if (mut.stockUnitId) lineMeta.stockUnitId = mut.stockUnitId;
          }
        } else {
          await this.stock.consumeForParent(tx, {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            locationId: dto.locationId,
            productId: level.productId,
            parentQty: Number(invKey),
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
            quantity: snap?.quantity ?? qty,
            unitPrice: (snap?.unitPrice ?? unitPrice.toFixed(4)) as string,
            lineTotal: taxed.lineTotal.toFixed(2),
            taxAmount: taxed.taxAmount.toFixed(2),
            ...(snap
              ? {
                  orderedQuantity: snap.orderedQuantity,
                  orderedUnitId: snap.orderedUnitId,
                  orderedUnitSymbol: snap.orderedUnitSymbol,
                  baseQuantity: snap.baseQuantity,
                  baseUnitId: snap.baseUnitId,
                  baseUnitSymbol: snap.baseUnitSymbol,
                  conversionFactor: snap.conversionFactor,
                  priceSource: snap.priceSource,
                }
              : { baseQuantity: inv }),
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

      const merchAfterDisc = Math.max(
        0,
        merchandise - Number(dto.discountAmount ?? 0),
      );
      await this.restaurant.attachCounterDining(tx, {
        tenantId: user.tenantId,
        userId: user.userId,
        orderId: created.id,
        locationId: dto.locationId,
        meta: {
          ...(dto.meta && typeof dto.meta === 'object' ? dto.meta : {}),
          ...(dto.note ? { note: dto.note } : {}),
        },
        merchandiseAfterDiscount: merchAfterDisc,
      });

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

      const preRoundRow = await tx.order.findFirstOrThrow({
        where: { id: created.id },
        select: { balanceDue: true },
      });
      const exactDue = Number(preRoundRow.balanceDue);

      const paymentLines = dto.payments.map((p) => ({
        ...p,
        amount: Number(p.amount),
      }));
      const cashRoundOff = this.resolveCashRoundOff(
        dto.roundOffAmount,
        paymentLines,
        exactDue,
      );

      await this.applyCheckoutRoundOff(
        tx,
        user.tenantId,
        created.id,
        cashRoundOff,
        exactDue,
      );

      const dueRow = await tx.order.findFirstOrThrow({
        where: { id: created.id },
        select: { balanceDue: true },
      });
      const due = money(dueRow.balanceDue);
      if (due.lte(0)) {
        throw new BadRequestException('Sale total must be greater than 0');
      }

      // Do not force single-cash to full due — supports partial payments
      const clientPayHint = paymentLines.reduce((s, p) => s + p.amount, 0);
      // Full-ticket cash: lift to server Due only when cashier is already
      // collecting ~the whole ticket (tax/settings drift). Never silently
      // convert a split/partial part into a full payment.
      if (
        dto.allowPartial !== true &&
        paymentLines.length === 1 &&
        paymentLines[0]!.method === PaymentMethod.cash
      ) {
        const sent = money(paymentLines[0]!.amount);
        if (sent.gte(due.sub(0.05))) {
          paymentLines[0]!.amount = Number(due.toFixed(2));
        }
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
      // Cash attaches to an open drawer; auto-open if the shift was never started.
      let openRegister =
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
        !openRegister &&
        paymentLines.some((p) => p.method === PaymentMethod.cash)
      ) {
        openRegister = await tx.registerSession.create({
          data: {
            tenantId: user.tenantId,
            locationId: dto.locationId,
            openedById: user.userId,
            openingFloat: '0.00',
          },
        });
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
          if (!p.emiTenureMonths || !p.emiProvider?.trim()) {
            throw new BadRequestException(
              'EMI needs tenure (months) and provider / bank name',
            );
          }
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
            ...(p.method === PaymentMethod.emi
              ? {
                  gatewayRef: p.emiReference?.trim() || null,
                  gatewayPayload: {
                    emiTenureMonths: p.emiTenureMonths,
                    emiProvider: p.emiProvider?.trim() || null,
                    emiReference: p.emiReference?.trim() || null,
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

    const partInvoice = await this.issueCheckoutInvoices(
      user,
      result.orderId,
      result.payments,
      result.paidSum,
    );

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

    await this.releaseDiningIfAny(user.tenantId, result.orderId, user.userId);
    try {
      await this.restaurant.ensureKotAfterSale(user, result.orderId);
    } catch {
      /* dining overlay optional */
    }

    return {
      order,
      payments: result.payments,
      change: money(change).toFixed(2),
      cashTendered: money(tendered).toFixed(2),
      receipt,
      invoice: partInvoice
        ? {
            id: partInvoice.id,
            invoiceNumber: partInvoice.invoiceNumber,
            grandTotal: Number(partInvoice.grandTotal),
            taxBreakdown: partInvoice.taxBreakdown,
          }
        : null,
      replayed: false,
      partial: money(order?.balanceDue ?? 0).gt(0),
      balanceDue: money(order?.balanceDue ?? 0).toFixed(2),
      loyaltyPointsRedeemed: result.loyaltyPointsRedeemed,
      loyaltyAmountOff: result.loyaltyAmountOff,
      pointsEarned: result.pointsEarned,
      receiptNotifications,
    };
  }

  /**
   * Split bill → one GST invoice per part. Full pay → single invoice if missing.
   */
  private async issueCheckoutInvoices(
    user: AuthUser,
    orderId: string,
    payments: Array<{ id: string; amount: Prisma.Decimal | string | number }>,
    paidSum: number,
  ) {
    try {
      const order = await this.prisma.order.findFirst({
        where: { id: orderId, tenantId: user.tenantId },
        select: {
          id: true,
          balanceDue: true,
          meta: true,
          invoices: {
            select: { id: true, taxBreakdown: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!order) return null;

      const meta =
        order.meta && typeof order.meta === 'object' && !Array.isArray(order.meta)
          ? (order.meta as Record<string, unknown>)
          : {};
      const splitRaw = meta.splitBill;
      const split =
        splitRaw && typeof splitRaw === 'object' && !Array.isArray(splitRaw)
          ? (splitRaw as {
              parts?: Array<{ label?: string; amount?: number }>;
            })
          : null;
      const parts = Array.isArray(split?.parts) ? split!.parts! : [];

      if (parts.length >= 2) {
        const used = new Set(
          order.invoices
            .map((inv) => {
              const b =
                inv.taxBreakdown && typeof inv.taxBreakdown === 'object'
                  ? (inv.taxBreakdown as Record<string, unknown>)
                  : {};
              return b.splitPartIndex != null
                ? Number(b.splitPartIndex)
                : null;
            })
            .filter((n): n is number => n != null && Number.isFinite(n)),
        );
        let nextIndex = 0;
        while (used.has(nextIndex) && nextIndex < parts.length) nextIndex += 1;
        if (nextIndex >= parts.length) return null;

        const part = parts[nextIndex]!;
        const partAmt = Math.round(
          (Number(part.amount) > 0 ? Number(part.amount) : 0) * 100,
        ) / 100;
        // Callers pass the payment(s) just recorded; use the last entry.
        const lastPay = payments[payments.length - 1];
        const lastPayAmt = Math.round(Number(lastPay?.amount ?? 0) * 100) / 100;
        const ticketSettled = Number(order.balanceDue) <= 0.009;
        // Do not mint a part invoice on mid-part partials — wait until
        // this payment covers the part (or the whole ticket is closed).
        if (
          !ticketSettled &&
          partAmt > 0.009 &&
          lastPayAmt + 0.009 < partAmt
        ) {
          return null;
        }
        const amount =
          partAmt > 0.009
            ? partAmt
            : Math.round(
                (lastPayAmt > 0 ? lastPayAmt : paidSum) * 100,
              ) / 100;
        return this.billing.issueSaleInvoice(user, orderId, {
          amount,
          splitPartIndex: nextIndex,
          splitPartLabel:
            typeof part.label === 'string' && part.label.trim()
              ? part.label.trim()
              : `Part ${nextIndex + 1}`,
          paymentId: lastPay?.id,
        });
      }

      // Non-split (or single part): one invoice when ticket is fully paid
      if (Number(order.balanceDue) <= 0.009) {
        return this.billing.issueSaleInvoice(user, orderId, {
          onlyIfMissing: true,
          paymentId: payments[payments.length - 1]?.id,
        });
      }
      return null;
    } catch {
      return null;
    }
  }

  private async releaseDiningIfAny(
    tenantId: string,
    orderId: string,
    actorUserId?: string,
  ) {
    try {
      await this.restaurant.onOrderFinalized({
        tenantId,
        orderId,
        actorUserId,
      });
    } catch {
      // Retail / rental / service checkout must not fail if dining overlay is absent
    }
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
    const locSettings =
      order.location.settings && typeof order.location.settings === 'object'
        ? (order.location.settings as Record<string, unknown>)
        : {};
    const locPhone =
      typeof locSettings.phone === 'string' ? locSettings.phone.trim() : null;
    const locEmail =
      typeof locSettings.email === 'string' ? locSettings.email.trim() : null;

    const storeGstin = tenant?.taxId?.trim() || null;
    const storeStateCode = extractGstStateCode(storeGstin) || '12';
    const storeState = INDIAN_GST_STATES[storeStateCode] || 'Arunachal Pradesh';

    const custMeta = (order.customer as unknown as { meta?: Record<string, unknown> })?.meta;
    const customerGstin =
      typeof custMeta?.gstin === 'string'
        ? custMeta.gstin.trim()
        : typeof meta.customerGstin === 'string'
          ? (meta.customerGstin as string).trim()
          : null;
    const customerStateCode =
      extractGstStateCode(customerGstin) ||
      (typeof meta.placeOfSupplyCode === 'string' ? (meta.placeOfSupplyCode as string) : null) ||
      storeStateCode;
    const placeOfSupply =
      INDIAN_GST_STATES[customerStateCode] ||
      (typeof meta.placeOfSupply === 'string' ? (meta.placeOfSupply as string) : storeState);

    const isInterState = Boolean(
      customerStateCode && storeStateCode && customerStateCode !== storeStateCode,
    );

    const slabMap = new Map<number, { taxable: number; tax: number }>();
    for (const item of order.items) {
      const itemMeta =
        item.meta && typeof item.meta === 'object'
          ? (item.meta as Record<string, unknown>)
          : {};
      const ratePct =
        typeof itemMeta.taxRatePercent === 'number'
          ? itemMeta.taxRatePercent
          : typeof itemMeta.taxRate === 'number'
            ? Number((itemMeta.taxRate * 100).toFixed(2))
            : 5;
      const t = Number(item.taxAmount);
      const l = Number(item.lineTotal);
      if (t > 0 || l > 0) {
        const cur = slabMap.get(ratePct) || { taxable: 0, tax: 0 };
        slabMap.set(ratePct, {
          taxable: cur.taxable + l,
          tax: cur.tax + t,
        });
      }
    }

    const slabs = Array.from(slabMap.entries()).map(([ratePercent, val]) => {
      const tax = Number(val.tax.toFixed(2));
      const taxable = Number(val.taxable.toFixed(2));
      const halfTax = Number((tax / 2).toFixed(2));
      const halfRate = Number((ratePercent / 2).toFixed(2));
      return {
        ratePercent,
        taxableAmount: taxable,
        cgstRate: isInterState ? 0 : halfRate,
        cgstAmount: isInterState ? 0 : halfTax,
        sgstRate: isInterState ? 0 : halfRate,
        sgstAmount: isInterState ? 0 : Number((tax - halfTax).toFixed(2)),
        igstRate: isInterState ? ratePercent : 0,
        igstAmount: isInterState ? tax : 0,
        totalTax: tax,
      };
    });

    const cgstTotal = slabs.reduce((s, x) => s + x.cgstAmount, 0);
    const sgstTotal = slabs.reduce((s, x) => s + x.sgstAmount, 0);
    const igstTotal = slabs.reduce((s, x) => s + x.igstAmount, 0);
    const totalGstTax = Number((cgstTotal + sgstTotal + igstTotal).toFixed(2));

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
        phone: locPhone,
        email: locEmail,
        shopName: tenant?.name ?? order.location.name,
        taxId: storeGstin,
        gstin: storeGstin,
        state: storeState,
        stateCode: storeStateCode,
      },
      location: order.location,
      customer: order.customer
        ? {
            id: order.customer.id,
            fullName: order.customer.fullName,
            phone: order.customer.phone,
            email: order.customer.email,
            gstin: customerGstin,
          }
        : null,
      gstInfo: {
        isInterState,
        supplierGstin: storeGstin,
        supplierState: storeState,
        supplierStateCode: storeStateCode,
        customerGstin,
        placeOfSupply,
        placeOfSupplyCode: customerStateCode,
        cgstTotal,
        sgstTotal,
        igstTotal,
        totalTax: totalGstTax,
        slabs,
      },
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
        const isInc = itemMeta.taxInclusive === true;
        const ratePct = (() => {
          if (typeof itemMeta.taxRate === 'number') {
            return Number((itemMeta.taxRate * 100).toFixed(4));
          }
          if (typeof itemMeta.taxRatePercent === 'number') {
            return itemMeta.taxRatePercent;
          }
          return null;
        })();
        return {
        id: item.id,
        itemType: item.itemKind,
        itemKind: item.itemKind,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxAmount: item.taxAmount,
        lineTotal: item.lineTotal,
        taxInclusive: isInc,
        taxCode:
          typeof itemMeta.taxCode === 'string'
            ? itemMeta.taxCode
            : (item.product?.taxCode ?? null),
        taxRatePercent: ratePct,
        hsnOrSac:
          typeof itemMeta.hsnOrSac === 'string'
            ? itemMeta.hsnOrSac
            : item.product?.taxCode ?? null,
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
        feesTotal: (order.fees ?? []).reduce(
          (s, f) => s + Number(f.amount),
          0,
        ),
      },
      fees: (order.fees ?? []).map((f) => ({
        feeCode: f.feeCode,
        reason: f.reason,
        amount: f.amount,
      })),
      paymentRounding: {
        originalAmount:
          typeof meta.originalAmount === 'number'
            ? meta.originalAmount
            : typeof meta.exactTotal === 'number'
              ? meta.exactTotal
              : Number(order.balanceDue),
        roundOffAmount:
          typeof meta.roundOffAmount === 'number'
            ? meta.roundOffAmount
            : typeof meta.roundOff === 'number'
              ? meta.roundOff
              : 0,
        finalAmount:
          typeof meta.finalAmount === 'number'
            ? meta.finalAmount
            : Number(order.balanceDue),
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
      invoices: (
        await this.prisma.invoice.findMany({
          where: { tenantId: user.tenantId, orderId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            invoiceNumber: true,
            grandTotal: true,
            cgst: true,
            sgst: true,
            igst: true,
            taxBreakdown: true,
            createdAt: true,
          },
        })
      ).map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        grandTotal: inv.grandTotal,
        cgst: inv.cgst,
        sgst: inv.sgst,
        igst: inv.igst,
        taxBreakdown: inv.taxBreakdown,
        createdAt: inv.createdAt,
      })),
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
        let snap: ReturnType<typeof orderLineSnapshotFields> | null = null;
        if (level.product.baseUnitId) {
          try {
            const calc = await this.unitPricing.calculateLine(user, {
              productId: level.productId,
              enteredQty: line.quantity,
              sellingUnitId: line.sellingUnitId,
              sellingUnitSymbol: line.sellingUnitId
                ? undefined
                : level.sellUnit,
              unitPriceOverride: line.unitPrice,
              inventorySign: -1,
            });
            snap = orderLineSnapshotFields(calc);
          } catch {
            /* preserve cart even if conversion isn't configured yet */
          }
        }
        await tx.orderItem.create({
          data: {
            tenantId: user.tenantId,
            orderId: created.id,
            itemKind: OrderItemKind.product,
            productId: level.productId,
            stockLevelId: level.id,
            description: level.product.name,
            quantity: snap?.quantity ?? line.quantity,
            unitPrice: snap?.unitPrice ?? unitPrice.toFixed(2),
            lineTotal: (snap ? snap.unitPrice : lineTotal.toFixed(2)) as string,
            ...(snap
              ? {
                  orderedQuantity: snap.orderedQuantity,
                  orderedUnitId: snap.orderedUnitId,
                  orderedUnitSymbol: snap.orderedUnitSymbol,
                  baseQuantity: snap.baseQuantity,
                  baseUnitId: snap.baseUnitId,
                  baseUnitSymbol: snap.baseUnitSymbol,
                  conversionFactor: snap.conversionFactor,
                  priceSource: snap.priceSource,
                  lineTotal: money(snap.unitPrice)
                    .mul(snap.orderedQuantity)
                    .toFixed(2),
                }
              : {}),
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
          sellUnit: i.orderedUnitSymbol ?? i.stockLevel?.sellUnit ?? 'pcs',
          sellingUnitId: i.orderedUnitId ?? undefined,
          baseQty: i.baseQuantity != null ? Number(i.baseQuantity) : undefined,
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
          select: {
            id: true,
            name: true,
            code: true,
            address: true,
            settings: true,
          },
        },
        items: {
          include: {
            stockUnit: {
              select: { id: true, barcodeSku: true, variantLabel: true },
            },
            stockLevel: { select: { id: true, sku: true } },
            product: {
              select: { id: true, name: true, skuCode: true, taxCode: true },
            },
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
