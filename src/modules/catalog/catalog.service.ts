import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FulfillmentMode,
  PricingStrategy,
  Prisma,
  ProductKind,
  ProductStatus,
  StockLedgerType,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import {
  normalizeQty,
  validateSellQty,
} from '../../common/sell-units';
import {
  BARCODE_TYPE_CODE128,
  detectBarcodeType,
  nextInternalCode128Candidate,
  normalizeBarcode,
} from '../../common/barcode';
import { validateSku } from '../../common/sell-units';
import { categoryIdsWithDescendants } from '../../common/category-tree';
import { paginate, pageMeta } from '../../common/dto/pagination.dto';
import { seedZeroStockAtOtherLocations } from '../../common/stock-at-location';
import { resolveProductTaxRatePercent } from '../../common/tax-engine';
import { listSafeImageUrl } from '../../common/product-image';
import { StockMutationEngine } from '../inventory/stock-mutation.engine';
import { isRecipePurpose } from '../restaurant/restaurant-policy';
import { UnitPricingService } from './unit-pricing.service';
import type { AuthUser } from '../auth/types';
import {
  CreateBatchDto,
  CreateBrandDto,
  CreateCatalogProductDto,
  CreateCategoryDto,
  CreateSerialDto,
  CreateVariantDto,
  GenerateSkuDto,
  ListCatalogQueryDto,
  SetBundleLinesDto,
  UpdateBatchDto,
  UpdateBrandDto,
  UpdateCatalogProductDto,
  UpdateCategoryDto,
  UpdateVariantDto,
} from './dto/catalog.dto';
import { randomBytes } from 'crypto';
import { resolveProductPhoto, saveProductImage } from '../../common/product-image';

function dec(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return null;
  return new Prisma.Decimal(n);
}

/** Persist data-URL / remote http(s) photos; keep /v1/uploads paths. */
async function resolveImageRef(
  tenantId: string,
  raw?: string | null,
): Promise<string | null> {
  return resolveProductPhoto(tenantId, raw);
}

async function resolveImageList(
  tenantId: string,
  photos: string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const photo of photos.slice(0, 12)) {
    const saved = await resolveImageRef(tenantId, photo);
    if (saved && !out.includes(saved)) out.push(saved);
  }
  return out;
}

function kindPrefix(kind?: ProductKind | string) {
  switch (kind) {
    case ProductKind.service:
      return 'SVC';
    case ProductKind.digital:
      return 'DIG';
    case ProductKind.bundle:
      return 'BND';
    case ProductKind.rental:
      return 'RNT';
    default:
      return 'ITM';
  }
}

function namePrefix(name?: string) {
  const letters = (name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
  return letters || 'PROD';
}

function statusToActive(status: ProductStatus) {
  return status === ProductStatus.active;
}

function mapProduct(p: {
  id: string;
  name: string;
  shortName: string | null;
  skuCode: string;
  barcode: string | null;
  barcodeType?: string | null;
  qrCode: string | null;
  internalCode: string | null;
  kind: ProductKind;
  fulfillmentMode: FulfillmentMode;
  status: ProductStatus;
  shortDescription: string | null;
  description: string | null;
  photoUrl: string | null;
  taxCode: string | null;
  basePrice: Prisma.Decimal;
  costPrice: Prisma.Decimal | null;
  mrp: Prisma.Decimal | null;
  unitOfMeasure: string;
  trackQty: boolean;
  trackSerial: boolean;
  trackBatch: boolean;
  canSell: boolean;
  canPurchase: boolean;
  availableInPos: boolean;
  isActive: boolean;
  meta: unknown;
  categoryId: string | null;
  brandId: string | null;
  category?: { id: string; name: string; parentId: string | null } | null;
  brand?: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { variants?: number; batches?: number; bundleComponents?: number };
  stockLevels?: Array<{ qtyOnHand: Prisma.Decimal; sellUnit: string }>;
}) {
  const meta = (p.meta ?? {}) as Record<string, unknown>;
  const rawImages = Array.isArray(meta.images)
    ? (meta.images as string[]).filter(Boolean)
    : p.photoUrl
      ? [p.photoUrl]
      : [];
  const images = rawImages
    .map((u) => listSafeImageUrl(u))
    .filter((u): u is string => Boolean(u));
  const cover = listSafeImageUrl(p.photoUrl) ?? images[0] ?? null;
  const metaOut = { ...meta, images };
  const foodTypeRaw = String(meta.foodType ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const foodType =
    foodTypeRaw === 'veg' || foodTypeRaw === 'vegetarian'
      ? 'veg'
      : foodTypeRaw === 'non_veg' ||
          foodTypeRaw === 'nonveg' ||
          foodTypeRaw === 'non_vegetarian'
        ? 'non_veg'
        : foodTypeRaw === 'egg' || foodTypeRaw === 'eggetarian'
          ? 'egg'
          : null;
  return {
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    skuCode: p.skuCode,
    sku: p.skuCode,
    barcode: p.barcode,
    barcodeType: p.barcodeType ?? (p.barcode ? detectBarcodeType(p.barcode) : null),
    qrCode: p.qrCode,
    internalCode: p.internalCode,
    kind: p.kind,
    fulfillmentMode: p.fulfillmentMode,
    productType: p.kind,
    status: p.status,
    shortDescription: p.shortDescription,
    description: p.description,
    photoUrl: cover,
    images,
    taxCode: p.taxCode,
    basePrice: Number(p.basePrice),
    sellingPrice: Number(p.basePrice),
    costPrice: p.costPrice != null ? Number(p.costPrice) : null,
    mrp: p.mrp != null ? Number(p.mrp) : null,
    unitOfMeasure: p.unitOfMeasure,
    trackInventory: p.trackQty,
    trackSerial: p.trackSerial,
    trackBatch: p.trackBatch,
    canSell: p.canSell,
    canPurchase: p.canPurchase,
    availableInPos: p.availableInPos,
    isActive: p.isActive,
    categoryId: p.categoryId,
    brandId: p.brandId,
    category: p.category ?? null,
    brand: p.brand ?? null,
    foodType,
    meta: metaOut,
    counts: {
      variants: p._count?.variants ?? 0,
      batches: p._count?.batches ?? 0,
      bundleLines: p._count?.bundleComponents ?? 0,
    },
    stockOnHand: p.stockLevels?.length
      ? p.stockLevels.reduce((sum, s) => sum + Number(s.qtyOnHand), 0)
      : null,
    sellUnit: p.stockLevels?.[0]?.sellUnit ?? p.unitOfMeasure,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockMutationEngine,
    private readonly unitPricing: UnitPricingService,
  ) {}

  // ── Brands ──────────────────────────────────────────────────────────────

  listBrands(user: AuthUser, q?: string) {
    return this.prisma.brand.findMany({
      where: {
        tenantId: user.tenantId,
        ...(q
          ? { name: { contains: q.trim(), mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  async createBrand(user: AuthUser, dto: CreateBrandDto) {
    try {
      return await this.prisma.brand.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          imageUrl: dto.imageUrl?.trim() || null,
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Brand name already exists');
      throw e;
    }
  }

  async updateBrand(user: AuthUser, id: string, dto: UpdateBrandDto) {
    await this.requireBrand(user.tenantId, id);
    try {
      return await this.prisma.brand.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description?.trim() || null }
            : {}),
          ...(dto.imageUrl !== undefined
            ? { imageUrl: dto.imageUrl?.trim() || null }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Brand name already exists');
      throw e;
    }
  }

  /** Soft-delete = deactivate. Hard-delete only when unused by products. */
  async deleteBrand(user: AuthUser, id: string) {
    await this.requireBrand(user.tenantId, id);
    const used = await this.prisma.product.count({
      where: { tenantId: user.tenantId, brandId: id },
    });
    if (used > 0) {
      const row = await this.prisma.brand.update({
        where: { id },
        data: { isActive: false },
      });
      return { ok: true, deleted: false, softDeleted: true, brand: row };
    }
    await this.prisma.brand.delete({ where: { id } });
    return { ok: true, deleted: true, softDeleted: false };
  }

  // ── Categories ──────────────────────────────────────────────────────────

  listCategories(user: AuthUser) {
    return this.prisma.category.findMany({
      where: { tenantId: user.tenantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        parent: { select: { id: true, name: true } },
        _count: { select: { products: true, children: true } },
      },
    });
  }

  async createCategory(user: AuthUser, dto: CreateCategoryDto) {
    if (dto.parentId) {
      const parent = await this.prisma.category.findFirst({
        where: { id: dto.parentId, tenantId: user.tenantId },
      });
      if (!parent) throw new NotFoundException('Parent category not found');
    }
    try {
      return await this.prisma.category.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          parentId: dto.parentId ?? null,
          imageUrl: dto.imageUrl?.trim() || null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Category name already exists');
      throw e;
    }
  }

  async updateCategory(user: AuthUser, id: string, dto: UpdateCategoryDto) {
    await this.requireCategory(user.tenantId, id);
    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('Category cannot be its own parent');
      }
      const parent = await this.prisma.category.findFirst({
        where: { id: dto.parentId, tenantId: user.tenantId },
      });
      if (!parent) throw new NotFoundException('Parent category not found');
    }
    try {
      return await this.prisma.category.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description?.trim() || null }
            : {}),
          ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
          ...(dto.imageUrl !== undefined
            ? { imageUrl: dto.imageUrl?.trim() || null }
            : {}),
          ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Category name already exists');
      throw e;
    }
  }

  /** Soft-delete = deactivate. Hard-delete only when unused (no products/children). */
  async deleteCategory(user: AuthUser, id: string) {
    await this.requireCategory(user.tenantId, id);
    const [products, children] = await Promise.all([
      this.prisma.product.count({
        where: { tenantId: user.tenantId, categoryId: id },
      }),
      this.prisma.category.count({
        where: { tenantId: user.tenantId, parentId: id },
      }),
    ]);
    if (products > 0 || children > 0) {
      const row = await this.prisma.category.update({
        where: { id },
        data: { isActive: false },
      });
      return { ok: true, deleted: false, softDeleted: true, category: row };
    }
    await this.prisma.category.delete({ where: { id } });
    return { ok: true, deleted: true, softDeleted: false };
  }

  // ── SKU / barcode generation ────────────────────────────────────────────

  async generateSku(user: AuthUser, dto: GenerateSkuDto = {}) {
    const prefix = (
      dto.prefix?.trim().toUpperCase() ||
      `${kindPrefix(dto.kind)}${namePrefix(dto.name).slice(0, 3)}`
    )
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    for (let i = 0; i < 24; i++) {
      const tail = randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
      let candidate = `${prefix}${tail}`.slice(0, 18);
      if (candidate.length < 2) candidate = `IT${tail}`.slice(0, 18);
      const err = validateSku(candidate);
      if (err) continue;
      const exists = await this.prisma.product.findFirst({
        where: { tenantId: user.tenantId, skuCode: candidate },
        select: { id: true },
      });
      const vExists = await this.prisma.productVariant.findFirst({
        where: { tenantId: user.tenantId, skuCode: candidate },
        select: { id: true },
      });
      if (!exists && !vExists) return { sku: candidate, skuCode: candidate };
    }
    throw new BadRequestException('Could not generate a unique SKU — try again');
  }

  /**
   * Internal Code 128 payload (not GS1 EAN/UPC).
   * Unique per tenant across product + variant barcodes.
   */
  async generateBarcode(user: AuthUser) {
    for (let i = 0; i < 32; i++) {
      const candidate = nextInternalCode128Candidate();
      const taken = await this.barcodeTaken(user.tenantId, candidate);
      if (!taken) {
        return {
          barcode: candidate,
          barcodeType: BARCODE_TYPE_CODE128,
        };
      }
    }
    throw new BadRequestException(
      'Could not generate a unique barcode — try again',
    );
  }

  async checkBarcode(
    user: AuthUser,
    code: string,
    excludeProductId?: string,
  ) {
    const barcode = normalizeBarcode(code);
    if (!barcode) {
      return {
        available: false,
        barcode: '',
        barcodeType: BARCODE_TYPE_CODE128,
        reason: 'empty',
      };
    }
    if (barcode.length < 4 || barcode.length > 64) {
      return {
        available: false,
        barcode,
        barcodeType: detectBarcodeType(barcode),
        reason: 'length',
      };
    }
    const taken = await this.barcodeTaken(
      user.tenantId,
      barcode,
      excludeProductId,
    );
    return {
      available: !taken,
      barcode,
      barcodeType: detectBarcodeType(barcode),
      reason: taken ? 'duplicate' : null,
    };
  }

  private async barcodeTaken(
    tenantId: string,
    barcode: string,
    excludeProductId?: string,
  ) {
    const normalized = normalizeBarcode(barcode);
    const [p, v] = await Promise.all([
      this.prisma.product.findFirst({
        where: {
          tenantId,
          barcode: { equals: normalized, mode: 'insensitive' },
          ...(excludeProductId ? { id: { not: excludeProductId } } : {}),
        },
        select: { id: true },
      }),
      this.prisma.productVariant.findFirst({
        where: {
          tenantId,
          barcode: { equals: normalized, mode: 'insensitive' },
        },
        select: { id: true },
      }),
    ]);
    return Boolean(p || v);
  }

  // ── Products (catalog master) ───────────────────────────────────────────

  /** Prefer MAIN, else oldest active location — same branch Items list uses for SOH. */
  private async resolveDefaultLocationId(
    tenantId: string,
    preferredId?: string | null,
  ): Promise<string | null> {
    if (preferredId) {
      const hit = await this.prisma.location.findFirst({
        where: { id: preferredId, tenantId, isActive: true },
        select: { id: true },
      });
      if (hit) return hit.id;
    }
    const main = await this.prisma.location.findFirst({
      where: { tenantId, isActive: true, code: 'MAIN' },
      select: { id: true },
    });
    if (main) return main.id;
    const first = await this.prisma.location.findFirst({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return first?.id ?? null;
  }

  async listProducts(user: AuthUser, query: ListCatalogQueryDto) {
    const q = query.q?.trim();
    const { page, limit, skip } = paginate(query.page, query.limit ?? 25);
    const lowStock = query.lowStock === 'true' || query.lowStock === '1';
    const stockLocationId = await this.resolveDefaultLocationId(
      user.tenantId,
      query.locationId,
    );
    const categoryIds = query.categoryId
      ? await categoryIdsWithDescendants(
          this.prisma,
          user.tenantId,
          query.categoryId,
        )
      : null;
    const where: Prisma.ProductWhereInput = {
      tenantId: user.tenantId,
      ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      // UI "Inactive" = not selling: inactive + archived (soft-deleted)
      ...(query.status === ProductStatus.inactive
        ? {
            status: {
              in: [ProductStatus.inactive, ProductStatus.archived],
            },
          }
        : query.status
          ? { status: query.status }
          : {}),
      ...(query.availableInPos === 'true'
        ? { availableInPos: true }
        : query.availableInPos === 'false'
          ? { availableInPos: false }
          : {}),
      ...(lowStock
        ? {
            trackQty: true,
            stockLevels: {
              some: {
                ...(stockLocationId ? { locationId: stockLocationId } : {}),
                // Include zero — "low" means at/below default reorder (5)
                qtyOnHand: { lte: 5 },
              },
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { shortName: { contains: q, mode: 'insensitive' } },
              { skuCode: { contains: q, mode: 'insensitive' } },
              { barcode: { contains: q, mode: 'insensitive' } },
              { internalCode: { contains: q, mode: 'insensitive' } },
              { qrCode: { contains: q, mode: 'insensitive' } },
              { brand: { name: { contains: q, mode: 'insensitive' } } },
              { category: { name: { contains: q, mode: 'insensitive' } } },
              {
                variants: {
                  some: {
                    OR: [
                      { name: { contains: q, mode: 'insensitive' } },
                      { skuCode: { contains: q, mode: 'insensitive' } },
                      { barcode: { contains: q, mode: 'insensitive' } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { name: 'asc' }],
        skip,
        take: limit,
        include: {
          category: { select: { id: true, name: true, parentId: true } },
          brand: { select: { id: true, name: true } },
          _count: {
            select: { variants: true, batches: true, bundleComponents: true },
          },
          ...(stockLocationId
            ? {
                stockLevels: {
                  where: { locationId: stockLocationId },
                  select: { qtyOnHand: true, sellUnit: true },
                  take: 1,
                },
              }
            : {}),
        },
      }),
    ]);
    return { items: rows.map(mapProduct), meta: pageMeta(total, page, limit) };
  }

  async getProduct(user: AuthUser, id: string) {
    const p = await this.prisma.product.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            parentId: true,
            parent: { select: { id: true, name: true } },
          },
        },
        brand: { select: { id: true, name: true } },
        variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
        bundleComponents: {
          include: {
            componentProduct: {
              select: {
                id: true,
                name: true,
                skuCode: true,
                kind: true,
                costPrice: true,
                unitOfMeasure: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        batches: {
          orderBy: { expiresAt: 'asc' },
          include: {
            location: { select: { id: true, name: true } },
            variant: { select: { id: true, name: true } },
          },
        },
        stockLevels: {
          select: {
            id: true,
            locationId: true,
            qtyOnHand: true,
            sellPrice: true,
            sellUnit: true,
            reorderPoint: true,
            location: { select: { id: true, name: true } },
          },
        },
        stockUnits: {
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: {
            id: true,
            barcodeSku: true,
            variantLabel: true,
            status: true,
            locationId: true,
            productVariantId: true,
            meta: true,
            location: { select: { id: true, name: true } },
          },
        },
        _count: {
          select: { variants: true, batches: true, bundleComponents: true },
        },
      },
    });
    if (!p) throw new NotFoundException('Product not found');

    const base = mapProduct(p);
    const qrPayload = this.buildQrPayload(p);
    const catalogSerials = p.stockUnits.filter((u) => {
      const meta = (u.meta ?? {}) as Record<string, unknown>;
      return meta.catalogSerial === true || meta.catalogSerial === 'true';
    });
    return {
      ...base,
      category: p.category,
      variants: p.variants.map((v) => ({
        id: v.id,
        name: v.name,
        skuCode: v.skuCode,
        barcode: v.barcode,
        attributes: v.attributes,
        basePrice: v.basePrice != null ? Number(v.basePrice) : null,
        costPrice: v.costPrice != null ? Number(v.costPrice) : null,
        isActive: v.isActive,
        sortOrder: v.sortOrder,
      })),
      bundleLines: p.bundleComponents.map((l) => ({
        id: l.id,
        componentProductId: l.componentProductId,
        componentVariantId: l.componentVariantId,
        quantity: Number(l.quantity),
        consumeOnSale: l.consumeOnSale,
        purpose: l.purpose,
        unit: l.unit,
        wastagePercent: Number(l.wastagePercent ?? 0),
        stageId: l.stageId,
        stageKey: l.stageKey,
        component: l.componentProduct,
      })),
      batches: p.batches.map((b) => ({
        id: b.id,
        batchCode: b.batchCode,
        locationId: b.locationId,
        location: b.location,
        variantId: b.variantId,
        variant: b.variant,
        manufacturedAt: b.manufacturedAt,
        expiresAt: b.expiresAt,
        qtyOnHand: Number(b.qtyOnHand),
        notes: b.notes,
        isActive: b.isActive,
      })),
      serials: catalogSerials.map((u) => ({
        id: u.id,
        serial: u.barcodeSku,
        label: u.variantLabel,
        status: u.status,
        locationId: u.locationId,
        location: u.location,
        variantId: u.productVariantId,
      })),
      /** Location stock is inventory — read-only on catalog detail */
      inventoryByLocation: p.stockLevels.map((s) => ({
        stockLevelId: s.id,
        locationId: s.locationId,
        location: s.location,
        qtyOnHand: Number(s.qtyOnHand),
        sellPrice: Number(s.sellPrice),
        sellUnit: s.sellUnit,
        reorderPoint:
          s.reorderPoint != null ? Number(s.reorderPoint) : null,
      })),
      qr: qrPayload,
    };
  }

  async createProduct(user: AuthUser, dto: CreateCatalogProductDto) {
    const kind = dto.kind ?? ProductKind.physical;
    const status = dto.status ?? ProductStatus.active;
    let sku = dto.skuCode?.trim().toUpperCase();
    if (!sku) {
      sku = (await this.generateSku(user, { name: dto.name, kind })).sku;
    } else {
      const skuErr = validateSku(sku);
      if (skuErr) throw new BadRequestException(skuErr);
    }

    let barcode = dto.barcode?.trim()
      ? normalizeBarcode(dto.barcode)
      : null;
    let barcodeType =
      dto.barcodeType?.trim()?.toLowerCase() ||
      (barcode ? detectBarcodeType(barcode) : null);
    if (!barcode) {
      const gen = await this.generateBarcode(user);
      barcode = gen.barcode;
      barcodeType = gen.barcodeType;
    } else if (await this.barcodeTaken(user.tenantId, barcode)) {
      throw new BadRequestException('Barcode already exists');
    } else if (!barcodeType) {
      barcodeType = detectBarcodeType(barcode);
    }

    if (dto.categoryId) {
      await this.requireCategory(user.tenantId, dto.categoryId);
    }
    if (dto.brandId) {
      await this.requireBrand(user.tenantId, dto.brandId);
    }

    const isNonStock =
      kind === ProductKind.service ||
      kind === ProductKind.digital ||
      kind === ProductKind.bundle;
    const trackQty =
      dto.trackInventory !== undefined
        ? dto.trackInventory
        : !isNonStock;
    const trackSerial = Boolean(dto.trackSerial) && trackQty;
    const trackBatch = Boolean(dto.trackBatch) && trackQty;
    const canPurchase =
      dto.canPurchase !== undefined
        ? dto.canPurchase
        : kind !== ProductKind.service && kind !== ProductKind.digital;
    const canSell = dto.canSell !== false;
    const availableInPos =
      dto.availableInPos !== false && status === ProductStatus.active;

    const unit = (dto.unitOfMeasure || 'pcs').trim().slice(0, 16) || 'pcs';
    const price = Number(dto.basePrice ?? 0);

    let resolvedBaseUnitId = dto.baseUnitId;
    let resolvedPricingUnitId = dto.pricingUnitId;
    if (!resolvedBaseUnitId) {
      const linked = await this.unitPricing.resolveUnitIdBySymbol(
        user.tenantId,
        unit,
      );
      if (linked) {
        resolvedBaseUnitId = linked.id;
        if (!resolvedPricingUnitId) resolvedPricingUnitId = linked.id;
      }
    }

    const resolvedImages = await resolveImageList(user.tenantId, [
      ...(dto.photoUrl?.trim() ? [dto.photoUrl.trim()] : []),
      ...((dto.images ?? []).filter(Boolean) as string[]),
    ]);
    const photoUrl = resolvedImages[0] ?? null;
    const taxCode = dto.taxCode?.trim() || null;
    const extra =
      dto.extraFields && typeof dto.extraFields === 'object'
        ? { ...(dto.extraFields as Record<string, unknown>) }
        : {};
    const rateFromForm = resolveProductTaxRatePercent({
      taxCode,
      meta: extra,
    });
    const meta: Record<string, unknown> = {
      ...extra,
      ...(rateFromForm != null ? { taxRatePercent: rateFromForm } : {}),
      ...(resolvedImages.length ? { images: resolvedImages } : {}),
      sellUnit: unit,
      ...(dto.reorderPoint != null && Number.isFinite(Number(dto.reorderPoint))
        ? { reorderPoint: Number(dto.reorderPoint) }
        : {}),
    };

    const openingLocationId = trackQty
      ? await this.resolveDefaultLocationId(user.tenantId, dto.locationId)
      : null;

    try {
      const product = await this.prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            tenantId: user.tenantId,
            name: dto.name.trim(),
            shortName: dto.shortName?.trim() || null,
            skuCode: sku!,
            kind,
            status,
            isActive: statusToActive(status),
            categoryId: dto.categoryId ?? null,
            brandId: dto.brandId || null,
            barcode,
            barcodeType,
            qrCode: dto.qrCode?.trim() || null,
            internalCode: dto.internalCode?.trim() || null,
            shortDescription: dto.shortDescription?.trim() || null,
            description: dto.description?.trim() || null,
            photoUrl,
            taxCode,
            basePrice: price,
            costPrice: dec(dto.costPrice),
            mrp: dec(dto.mrp),
            unitOfMeasure: unit,
            ...(resolvedBaseUnitId ? { baseUnitId: resolvedBaseUnitId } : {}),
            ...(resolvedPricingUnitId
              ? { pricingUnitId: resolvedPricingUnitId }
              : {}),
            ...(dto.pricingStrategy
              ? {
                  pricingStrategy:
                    dto.pricingStrategy === 'fixed_tier'
                      ? PricingStrategy.fixed_tier
                      : PricingStrategy.converted,
                }
              : resolvedBaseUnitId
                ? { pricingStrategy: PricingStrategy.converted }
                : {}),
            ...(dto.pricePerPricingUnit != null
              ? { pricePerPricingUnit: dec(dto.pricePerPricingUnit) }
              : resolvedBaseUnitId || resolvedPricingUnitId
                ? { pricePerPricingUnit: dec(price) }
                : {}),
            trackQty,
            trackSerial,
            trackBatch,
            canSell,
            canPurchase,
            availableInPos,
            fulfillmentMode:
              kind === ProductKind.rental
                ? FulfillmentMode.rental
                : kind === ProductKind.service
                  ? FulfillmentMode.service
                  : FulfillmentMode.sale,
            meta: meta as Prisma.InputJsonValue,
            createdById: user.userId,
            updatedById: user.userId,
          },
        });

        if (trackQty) {
          const openingRaw =
            dto.openingQty != null ? Number(dto.openingQty) : 0;
          if (openingRaw < 0) {
            throw new BadRequestException('Opening quantity cannot be negative');
          }
          const qtyErr = validateSellQty(openingRaw, unit);
          if (qtyErr) throw new BadRequestException(qtyErr);
          // Serial-tracked items: Stock on Hand must match registered units.
          // Free-form opening without serials causes "serial is required" later —
          // start at 0; each Register serial / Stock In serial adds 1.
          const opening = trackSerial
            ? 0
            : normalizeQty(openingRaw, unit);
          const locationId = openingLocationId;
          if (!locationId) {
            throw new BadRequestException(
              'No store location configured — add a location before creating stocked items',
            );
          }
          const reorderPoint =
            dto.reorderPoint != null && Number.isFinite(Number(dto.reorderPoint))
              ? Number(dto.reorderPoint)
              : undefined;
          const level = await tx.stockLevel.create({
            data: {
              tenantId: user.tenantId,
              locationId,
              productId: created.id,
              sku: sku!,
              sellUnit: unit.slice(0, 8),
              qtyOnHand: opening > 0 ? opening : 0,
              sellPrice: price,
              ...(reorderPoint != null ? { reorderPoint } : {}),
            },
          });
          if (opening > 0) {
            await tx.stockLedgerEntry.create({
              data: {
                tenantId: user.tenantId,
                locationId,
                productId: created.id,
                stockLevelId: level.id,
                type: StockLedgerType.opening,
                qtyBefore: 0,
                qtyDelta: opening,
                qtyAfter: opening,
                reason: 'Opening stock',
                referenceType: 'product',
                referenceId: created.id,
                actorUserId: user.userId,
                meta: { sku: sku!, sellUnit: unit.slice(0, 8) },
              },
            });
          }
          await seedZeroStockAtOtherLocations(tx, {
            tenantId: user.tenantId,
            productId: created.id,
            sku: sku!,
            sellUnit: unit.slice(0, 8),
            sellPrice: price,
            exceptLocationId: locationId,
          });
        } else if (canSell && availableInPos) {
          // Services / non-tracked items still need a stock row so Counter can find them
          const locationId =
            dto.locationId ??
            (
              await tx.location.findFirst({
                where: { tenantId: user.tenantId, isActive: true },
                orderBy: { createdAt: 'asc' },
                select: { id: true },
              })
            )?.id;
          if (!locationId) {
            throw new BadRequestException(
              'No store location configured — add a location before creating POS items',
            );
          }
          await tx.stockLevel.create({
            data: {
              tenantId: user.tenantId,
              locationId,
              productId: created.id,
              sku: sku!,
              sellUnit: unit.slice(0, 8),
              qtyOnHand: 0,
              sellPrice: price,
            },
          });
          await seedZeroStockAtOtherLocations(tx, {
            tenantId: user.tenantId,
            productId: created.id,
            sku: sku!,
            sellUnit: unit.slice(0, 8),
            sellPrice: price,
            exceptLocationId: locationId,
          });
        }

        if (dto.productUnits?.length) {
          let defaults = 0;
          for (const row of dto.productUnits) {
            if (row.isDefaultSellingUnit) defaults += 1;
            const factor = Number(row.conversionToBase);
            if (!(factor > 0)) {
              throw new BadRequestException('conversion_to_base must be > 0');
            }
            await tx.productUnit.create({
              data: {
                tenantId: user.tenantId,
                productId: created.id,
                unitId: row.unitId,
                conversionToBase: factor,
                fixedPrice:
                  row.fixedPrice != null ? Number(row.fixedPrice) : null,
                isDefaultSellingUnit: Boolean(row.isDefaultSellingUnit),
                isPurchaseUnit: Boolean(row.isPurchaseUnit),
                createdById: user.userId,
              },
            });
          }
          if (defaults > 1) {
            throw new BadRequestException(
              'Only one default selling unit is allowed',
            );
          }
        }

        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            entityType: 'product',
            entityId: created.id,
            action: 'catalog.product.created',
            beforeAfter: {
              after: {
                name: created.name,
                sku: created.skuCode,
                kind: created.kind,
                status: created.status,
              },
            },
          },
        });

        return created;
      });
      return this.getProduct(user, product.id);
    } catch (e) {
      throwIfUnique(e, 'SKU or barcode already exists');
      if (
        e instanceof Error &&
        /product_units|base_unit_id|pricing_unit_id|pricing_strategy|P2021|P2022/i.test(
          e.message,
        )
      ) {
        throw new BadRequestException(
          'Unit pricing tables are missing on this database. Run: npx prisma migrate deploy (or db push), then retry. Simple items only need Unit of measure (pcs/kg) — leave advanced Unit & pricing empty.',
        );
      }
      throw e;
    }
  }

  async updateProduct(
    user: AuthUser,
    id: string,
    dto: UpdateCatalogProductDto,
  ) {
    const existing = await this.requireProduct(user.tenantId, id);
    if (dto.categoryId) {
      await this.requireCategory(user.tenantId, dto.categoryId);
    }
    if (dto.brandId) {
      await this.requireBrand(user.tenantId, dto.brandId);
    }
    if (dto.skuCode) {
      const skuErr = validateSku(dto.skuCode);
      if (skuErr) throw new BadRequestException(skuErr);
    }

    let nextBarcode: string | null | undefined;
    let nextBarcodeType: string | null | undefined;
    if (dto.barcode !== undefined) {
      nextBarcode = dto.barcode?.trim()
        ? normalizeBarcode(dto.barcode)
        : null;
      if (
        nextBarcode &&
        (await this.barcodeTaken(user.tenantId, nextBarcode, id))
      ) {
        throw new BadRequestException('Barcode already exists');
      }
      nextBarcodeType = nextBarcode
        ? dto.barcodeType?.trim()?.toLowerCase() ||
          detectBarcodeType(nextBarcode)
        : null;
    } else if (dto.barcodeType !== undefined) {
      nextBarcodeType = dto.barcodeType?.trim()?.toLowerCase() || null;
    }

    const prevMeta = (existing.meta ?? {}) as Record<string, unknown>;
    let nextMeta = { ...prevMeta };
    let nextPhotoUrl: string | null | undefined;
    if (dto.images) {
      const resolved = await resolveImageList(user.tenantId, [
        ...(dto.photoUrl?.trim() ? [dto.photoUrl.trim()] : []),
        ...dto.images.filter(Boolean),
      ]);
      nextMeta.images = resolved;
      if (dto.photoUrl !== undefined) {
        nextPhotoUrl = resolved[0] ?? null;
      } else if (!existing.photoUrl && resolved[0]) {
        nextPhotoUrl = resolved[0];
      }
    } else if (dto.photoUrl !== undefined) {
      nextPhotoUrl = await resolveImageRef(user.tenantId, dto.photoUrl);
      if (nextPhotoUrl) {
        const gallery = Array.isArray(nextMeta.images)
          ? (nextMeta.images as string[]).filter((u) => u !== nextPhotoUrl)
          : [];
        nextMeta.images = [nextPhotoUrl, ...gallery].slice(0, 12);
      } else {
        nextMeta.images = Array.isArray(nextMeta.images)
          ? (nextMeta.images as string[]).filter(Boolean)
          : [];
      }
    }
    if (dto.extraFields) {
      nextMeta = { ...nextMeta };
      for (const [k, v] of Object.entries(dto.extraFields)) {
        if (v === null || v === undefined || v === "") {
          delete nextMeta[k];
        } else {
          nextMeta[k] = v;
        }
      }
    }
    if (dto.reorderPoint !== undefined) {
      if (
        dto.reorderPoint != null &&
        Number.isFinite(Number(dto.reorderPoint))
      ) {
        nextMeta.reorderPoint = Number(dto.reorderPoint);
      } else {
        delete nextMeta.reorderPoint;
      }
    }
    if (dto.unitOfMeasure) {
      nextMeta.sellUnit = dto.unitOfMeasure;
    }
    const nextTaxCode =
      dto.taxCode !== undefined ? dto.taxCode?.trim() || null : existing.taxCode;
    const rateFromForm = resolveProductTaxRatePercent({
      taxCode: nextTaxCode,
      meta: nextMeta,
    });
    if (rateFromForm != null) {
      nextMeta.taxRatePercent = rateFromForm;
    } else if (dto.taxCode !== undefined || dto.extraFields) {
      delete nextMeta.taxRatePercent;
    }

    const status = dto.status ?? existing.status;
    try {
      await this.prisma.$transaction(async (tx) => {
        const updateData: Prisma.ProductUncheckedUpdateInput = {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.shortName !== undefined
            ? { shortName: dto.shortName?.trim() || null }
            : {}),
          ...(dto.skuCode !== undefined
            ? { skuCode: dto.skuCode.trim().toUpperCase() }
            : {}),
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(dto.status !== undefined
            ? {
                status: dto.status,
                isActive: statusToActive(dto.status),
                availableInPos:
                  dto.availableInPos !== undefined
                    ? dto.availableInPos
                    : dto.status === ProductStatus.active
                      ? existing.availableInPos
                      : false,
              }
            : {}),
          ...(dto.categoryId !== undefined
            ? { categoryId: dto.categoryId }
            : {}),
          ...(dto.brandId !== undefined ? { brandId: dto.brandId } : {}),
          ...(dto.barcode !== undefined
            ? {
                barcode: nextBarcode ?? null,
                barcodeType: nextBarcodeType ?? null,
              }
            : dto.barcodeType !== undefined
              ? { barcodeType: nextBarcodeType ?? null }
              : {}),
          ...(dto.qrCode !== undefined
            ? { qrCode: dto.qrCode?.trim() || null }
            : {}),
          ...(dto.internalCode !== undefined
            ? { internalCode: dto.internalCode?.trim() || null }
            : {}),
          ...(dto.shortDescription !== undefined
            ? { shortDescription: dto.shortDescription?.trim() || null }
            : {}),
          ...(dto.description !== undefined
            ? { description: dto.description?.trim() || null }
            : {}),
          ...(nextPhotoUrl !== undefined ? { photoUrl: nextPhotoUrl } : {}),
          ...(dto.taxCode !== undefined
            ? { taxCode: dto.taxCode?.trim() || null }
            : {}),
          ...(dto.basePrice !== undefined || dto.pricePerPricingUnit !== undefined
            ? (() => {
                const updatedPrice = dto.basePrice ?? dto.pricePerPricingUnit;
                const priceDec = updatedPrice != null ? dec(updatedPrice) : undefined;
                const mrpDec =
                  dto.mrp !== undefined
                    ? dec(dto.mrp ?? undefined)
                    : priceDec;
                return {
                  basePrice: priceDec,
                  pricePerPricingUnit: priceDec,
                  mrp: mrpDec,
                };
              })()
            : dto.mrp !== undefined
              ? { mrp: dec(dto.mrp ?? undefined) }
              : {}),
          ...(dto.unitOfMeasure !== undefined
            ? { unitOfMeasure: dto.unitOfMeasure.trim().slice(0, 16) }
            : {}),
          ...(dto.baseUnitId !== undefined
            ? { baseUnitId: dto.baseUnitId }
            : {}),
          ...(dto.pricingUnitId !== undefined
            ? { pricingUnitId: dto.pricingUnitId }
            : {}),
          ...(dto.pricingStrategy !== undefined
            ? {
                pricingStrategy:
                  dto.pricingStrategy === 'fixed_tier'
                    ? PricingStrategy.fixed_tier
                    : PricingStrategy.converted,
              }
            : {}),
          ...(dto.trackInventory !== undefined ||
          dto.trackSerial !== undefined ||
          dto.trackBatch !== undefined
            ? (() => {
                const trackQty =
                  dto.trackInventory !== undefined
                    ? dto.trackInventory
                    : existing.trackQty;
                const trackSerial =
                  Boolean(
                    dto.trackSerial !== undefined
                      ? dto.trackSerial
                      : existing.trackSerial,
                  ) && trackQty;
                const trackBatch =
                  Boolean(
                    dto.trackBatch !== undefined
                      ? dto.trackBatch
                      : existing.trackBatch,
                  ) && trackQty;
                return { trackQty, trackSerial, trackBatch };
              })()
            : {}),
          ...(dto.canSell !== undefined ? { canSell: dto.canSell } : {}),
          ...(dto.canPurchase !== undefined
            ? { canPurchase: dto.canPurchase }
            : {}),
          ...(dto.availableInPos !== undefined && dto.status === undefined
            ? { availableInPos: dto.availableInPos }
            : {}),
          meta: nextMeta as Prisma.InputJsonValue,
          updatedById: user.userId,
        };

        await tx.product.update({
          where: { id },
          data: updateData,
        });

        // Keep location stock in sync — Counter sells from stockLevel.sellPrice/unit
        const stockPatch: Prisma.StockLevelUpdateManyMutationInput = {};
        if (dto.unitOfMeasure !== undefined) {
          stockPatch.sellUnit = dto.unitOfMeasure.trim().slice(0, 8);
        }
        if (dto.basePrice !== undefined || dto.pricePerPricingUnit !== undefined) {
          const updatedPriceVal = dto.basePrice ?? dto.pricePerPricingUnit;
          if (updatedPriceVal != null) {
            stockPatch.sellPrice = new Prisma.Decimal(updatedPriceVal);
          }
        }
        if (dto.reorderPoint !== undefined) {
          stockPatch.reorderPoint =
            dto.reorderPoint != null &&
            Number.isFinite(Number(dto.reorderPoint))
              ? new Prisma.Decimal(Number(dto.reorderPoint))
              : null;
        }
        if (Object.keys(stockPatch).length) {
          await tx.stockLevel.updateMany({
            where: { tenantId: user.tenantId, productId: id },
            data: stockPatch,
          });
        }

        const nextTrackQty =
          dto.trackInventory !== undefined
            ? dto.trackInventory
            : existing.trackQty;
        if (nextTrackQty && !existing.trackQty) {
          const existingLevels = await tx.stockLevel.count({
            where: { tenantId: user.tenantId, productId: id },
          });
          if (existingLevels === 0) {
            const sku =
              (dto.skuCode?.trim().toUpperCase() || existing.skuCode || '')
                .slice(0, 18) || 'ITEM';
            const unit = (
              dto.unitOfMeasure?.trim() ||
              existing.unitOfMeasure ||
              'pcs'
            ).slice(0, 8);
            const price =
              dto.basePrice !== undefined
                ? Number(dto.basePrice)
                : Number(existing.basePrice);
            const locationId = await this.resolveDefaultLocationId(
              user.tenantId,
              null,
            );
            if (locationId) {
              await tx.stockLevel.create({
                data: {
                  tenantId: user.tenantId,
                  locationId,
                  productId: id,
                  sku,
                  sellUnit: unit,
                  qtyOnHand: 0,
                  sellPrice: price,
                  ...(dto.reorderPoint != null &&
                  Number.isFinite(Number(dto.reorderPoint))
                    ? { reorderPoint: Number(dto.reorderPoint) }
                    : {}),
                },
              });
              await seedZeroStockAtOtherLocations(tx, {
                tenantId: user.tenantId,
                productId: id,
                sku,
                sellUnit: unit,
                sellPrice: price,
                exceptLocationId: locationId,
              });
            }
          }
        }

        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            entityType: 'product',
            entityId: id,
            action: 'catalog.product.updated',
            beforeAfter: {
              before: {
                name: existing.name,
                basePrice: Number(existing.basePrice),
                status: existing.status,
                categoryId: existing.categoryId,
                brandId: existing.brandId,
              },
              after: {
                name: dto.name ?? existing.name,
                basePrice:
                  dto.basePrice !== undefined
                    ? dto.basePrice
                    : Number(existing.basePrice),
                status,
                categoryId:
                  dto.categoryId !== undefined
                    ? dto.categoryId
                    : existing.categoryId,
                brandId:
                  dto.brandId !== undefined ? dto.brandId : existing.brandId,
              },
            },
          },
        });
      });
      return this.getProduct(user, id);
    } catch (e) {
      throwIfUnique(e, 'SKU already exists');
      throw e;
    }
  }

  async setStatus(user: AuthUser, id: string, status: ProductStatus) {
    return this.updateProduct(user, id, { status });
  }

  async duplicateProduct(user: AuthUser, id: string) {
    const src = await this.getProduct(user, id);
    const sku = (await this.generateSku(user, { name: src.name, kind: src.kind }))
      .sku;
    return this.createProduct(user, {
      name: `${src.name} (copy)`,
      shortName: src.shortName ?? undefined,
      skuCode: sku,
      kind: src.kind,
      status: ProductStatus.draft,
      categoryId: src.categoryId ?? undefined,
      brandId: src.brandId ?? undefined,
      // do not copy barcode / qr / internal by default
      shortDescription: src.shortDescription ?? undefined,
      description: src.description ?? undefined,
      photoUrl: src.photoUrl ?? undefined,
      images: src.images,
      taxCode: src.taxCode ?? undefined,
      basePrice: src.basePrice,
      costPrice: src.costPrice ?? undefined,
      mrp: src.mrp ?? undefined,
      unitOfMeasure: src.unitOfMeasure,
      trackInventory: src.trackInventory,
      trackSerial: src.trackSerial,
      trackBatch: src.trackBatch,
      canSell: src.canSell,
      canPurchase: src.canPurchase,
      availableInPos: false,
      openingQty: 1,
    });
  }

  async deleteProduct(user: AuthUser, id: string) {
    await this.requireProduct(user.tenantId, id);

    const [orderUsed, subUsed, bundleUsed, units] = await Promise.all([
      this.prisma.orderItem.count({
        where: { tenantId: user.tenantId, productId: id },
      }),
      this.prisma.customerSubscription.count({
        where: { tenantId: user.tenantId, productId: id },
      }),
      this.prisma.productBundleLine.count({
        where: { tenantId: user.tenantId, componentProductId: id },
      }),
      this.prisma.stockUnit.count({
        where: { tenantId: user.tenantId, productId: id },
      }),
    ]);

    const levels = await this.prisma.stockLevel.findMany({
      where: { tenantId: user.tenantId, productId: id },
      select: { id: true },
    });
    const levelIds = levels.map((l) => l.id);

    let stockHistory = 0;
    if (levelIds.length) {
      const [ledger, poLines, grnLines, countLines, orderOnLevel] =
        await Promise.all([
          this.prisma.stockLedgerEntry.count({
            where: { tenantId: user.tenantId, productId: id },
          }),
          this.prisma.purchaseOrderLine.count({
            where: { tenantId: user.tenantId, stockLevelId: { in: levelIds } },
          }),
          this.prisma.goodsReceiptLine.count({
            where: { tenantId: user.tenantId, stockLevelId: { in: levelIds } },
          }),
          this.prisma.stockCountLine.count({
            where: { productId: id },
          }),
          this.prisma.orderItem.count({
            where: {
              tenantId: user.tenantId,
              stockLevelId: { in: levelIds },
            },
          }),
        ]);
      stockHistory = ledger + poLines + grnLines + countLines + orderOnLevel;
    }

    // Prefer archive when the item has sales / purchases / stock history
    if (
      orderUsed > 0 ||
      subUsed > 0 ||
      bundleUsed > 0 ||
      units > 0 ||
      stockHistory > 0
    ) {
      const row = await this.setStatus(user, id, ProductStatus.archived);
      return { ok: true, deleted: false, softDeleted: true, product: row };
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (levelIds.length) {
          await tx.stockLedgerEntry.deleteMany({
            where: { tenantId: user.tenantId, productId: id },
          });
          await tx.stockCountLine.deleteMany({
            where: { productId: id },
          });
          await tx.stockLevel.deleteMany({
            where: { tenantId: user.tenantId, productId: id },
          });
        }
        // Variants / batches cascade via schema
        await tx.product.delete({ where: { id } });
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            entityType: 'product',
            entityId: id,
            action: 'catalog.product.deleted',
          },
        });
      });
      return { ok: true, deleted: true, softDeleted: false };
    } catch {
      // Last resort: archive instead of 500 on unexpected FK
      const row = await this.setStatus(user, id, ProductStatus.archived);
      return { ok: true, deleted: false, softDeleted: true, product: row };
    }
  }

  async deleteAllProducts(user: AuthUser) {
    const products = await this.prisma.product.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true },
    });
    if (!products.length) {
      return { ok: true, deletedCount: 0, archivedCount: 0, total: 0 };
    }

    let deletedCount = 0;
    let archivedCount = 0;

    for (const p of products) {
      try {
        const res = await this.deleteProduct(user, p.id);
        if (res.deleted) {
          deletedCount++;
        } else {
          archivedCount++;
        }
      } catch {
        archivedCount++;
      }
    }

    await this.prisma.auditLog
      .create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'product',
          entityId: 'all',
          action: 'catalog.products.purge_all',
          beforeAfter: {
            total: products.length,
            deletedCount,
            archivedCount,
          } as Prisma.InputJsonValue,
        },
      })
      .catch(() => null);

    return {
      ok: true,
      deletedCount,
      archivedCount,
      total: products.length,
    };
  }

  qrForProduct(user: AuthUser, id: string) {
    return this.getProduct(user, id).then((p) => p.qr);
  }

  // ── Variants ────────────────────────────────────────────────────────────

  async createVariant(user: AuthUser, productId: string, dto: CreateVariantDto) {
    const product = await this.requireProduct(user.tenantId, productId);
    let sku = dto.skuCode?.trim().toUpperCase();
    if (!sku) {
      sku = (
        await this.generateSku(user, {
          name: `${product.name}-${dto.name}`,
          kind: product.kind,
        })
      ).sku;
    } else {
      const skuErr = validateSku(sku);
      if (skuErr) throw new BadRequestException(skuErr);
    }
    try {
      const v = await this.prisma.productVariant.create({
        data: {
          tenantId: user.tenantId,
          productId,
          name: dto.name.trim(),
          skuCode: sku,
          barcode: dto.barcode?.trim() || null,
          attributes: (dto.attributes ?? {}) as Prisma.InputJsonValue,
          basePrice: dec(dto.basePrice),
          costPrice: dec(dto.costPrice),
        },
      });
      await this.prisma.product.update({
        where: { id: productId },
        data: {
          meta: {
            ...((product.meta as object) ?? {}),
            itemStructure: 'variants',
          } as Prisma.InputJsonValue,
        },
      });
      const parentLevels = await this.prisma.stockLevel.findMany({
        where: {
          tenantId: user.tenantId,
          productId,
          variantKey: '',
        },
      });
      for (const pl of parentLevels) {
        await this.prisma.stockLevel.upsert({
          where: {
            tenantId_locationId_productId_variantKey: {
              tenantId: user.tenantId,
              locationId: pl.locationId,
              productId,
              variantKey: v.id,
            },
          },
          create: {
            tenantId: user.tenantId,
            locationId: pl.locationId,
            productId,
            variantId: v.id,
            variantKey: v.id,
            sku: sku.slice(0, 18),
            sellUnit: pl.sellUnit,
            sellPrice:
              dto.basePrice != null
                ? new Prisma.Decimal(dto.basePrice)
                : pl.sellPrice,
            qtyOnHand: 0,
          },
          update: {},
        });
      }
      return v;
    } catch (e) {
      throwIfUnique(e, 'Variant SKU already exists');
      throw e;
    }
  }

  async updateVariant(
    user: AuthUser,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ) {
    await this.requireVariant(user.tenantId, productId, variantId);
    return this.prisma.productVariant.update({
      where: { id: variantId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.barcode !== undefined
          ? { barcode: dto.barcode?.trim() || null }
          : {}),
        ...(dto.attributes !== undefined
          ? { attributes: dto.attributes as Prisma.InputJsonValue }
          : {}),
        ...(dto.basePrice !== undefined
          ? { basePrice: dec(dto.basePrice ?? undefined) }
          : {}),
        ...(dto.costPrice !== undefined
          ? { costPrice: dec(dto.costPrice ?? undefined) }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async deleteVariant(user: AuthUser, productId: string, variantId: string) {
    await this.requireVariant(user.tenantId, productId, variantId);
    await this.prisma.productVariant.delete({ where: { id: variantId } });
    return { ok: true };
  }

  // ── Bundles ─────────────────────────────────────────────────────────────

  async replaceBundleLines(
    user: AuthUser,
    productId: string,
    dto: SetBundleLinesDto,
  ) {
    const product = await this.requireProduct(user.tenantId, productId);
    for (const line of dto.lines) {
      if (line.componentProductId === productId) {
        throw new BadRequestException('Bundle cannot include itself');
      }
      await this.requireProduct(user.tenantId, line.componentProductId);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.productBundleLine.deleteMany({
        where: { tenantId: user.tenantId, bundleProductId: productId },
      });
      let hasRecipe = false;
      for (const l of dto.lines) {
        const purpose =
          l.purpose ??
          (product.kind === ProductKind.bundle ? 'bundle' : 'recipe');
        const consumeOnSale =
          l.consumeOnSale ?? product.kind !== ProductKind.bundle;
        if (consumeOnSale && isRecipePurpose(purpose)) hasRecipe = true;
        await tx.productBundleLine.create({
          data: {
            tenantId: user.tenantId,
            bundleProductId: productId,
            componentProductId: l.componentProductId,
            componentVariantId: l.componentVariantId ?? null,
            quantity: l.quantity ?? 1,
            consumeOnSale,
            purpose,
            unit: l.unit?.trim() || null,
            wastagePercent: l.wastagePercent ?? 0,
            stageId: l.stageId ?? null,
            stageKey: l.stageId ?? '',
          },
        });
      }
      if (hasRecipe && product.trackQty) {
        const meta =
          product.meta && typeof product.meta === 'object'
            ? (product.meta as Record<string, unknown>)
            : {};
        await tx.product.update({
          where: { id: productId },
          data: {
            trackQty: false,
            meta: { ...meta, recipeTracked: true } as Prisma.InputJsonValue,
          },
        });
      }
    });
    return this.getProduct(user, productId);
  }

  // ── Batches / expiry ────────────────────────────────────────────────────

  async createBatch(user: AuthUser, productId: string, dto: CreateBatchDto) {
    const product = await this.requireProduct(user.tenantId, productId);
    if (!product.trackBatch && !product.trackQty) {
      throw new BadRequestException(
        'Enable track batch / inventory on this product first',
      );
    }
    const loc = await this.prisma.location.findFirst({
      where: { id: dto.locationId, tenantId: user.tenantId },
    });
    if (!loc) throw new NotFoundException('Location not found');
    if (dto.variantId) {
      await this.requireVariant(user.tenantId, productId, dto.variantId);
    }
    try {
      return await this.prisma.productBatch.create({
        data: {
          tenantId: user.tenantId,
          productId,
          variantId: dto.variantId ?? null,
          locationId: dto.locationId,
          batchCode: dto.batchCode.trim(),
          manufacturedAt: dto.manufacturedAt
            ? new Date(dto.manufacturedAt)
            : null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          qtyOnHand: dto.qtyOnHand ?? 0,
          notes: dto.notes?.trim() || null,
        },
      });
    } catch (e) {
      throwIfUnique(e, 'Batch code already exists at this location');
      throw e;
    }
  }

  async updateBatch(
    user: AuthUser,
    productId: string,
    batchId: string,
    dto: UpdateBatchDto,
  ) {
    const batch = await this.prisma.productBatch.findFirst({
      where: { id: batchId, productId, tenantId: user.tenantId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return this.prisma.productBatch.update({
      where: { id: batchId },
      data: {
        ...(dto.manufacturedAt !== undefined
          ? {
              manufacturedAt: dto.manufacturedAt
                ? new Date(dto.manufacturedAt)
                : null,
            }
          : {}),
        ...(dto.expiresAt !== undefined
          ? {
              expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
            }
          : {}),
        ...(dto.qtyOnHand !== undefined ? { qtyOnHand: dto.qtyOnHand } : {}),
        ...(dto.notes !== undefined
          ? { notes: dto.notes?.trim() || null }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  async listExpiringBatches(user: AuthUser, withinDays = 30) {
    const until = new Date();
    until.setDate(until.getDate() + withinDays);
    const rows = await this.prisma.productBatch.findMany({
      where: {
        tenantId: user.tenantId,
        isActive: true,
        expiresAt: { not: null, lte: until },
      },
      orderBy: { expiresAt: 'asc' },
      include: {
        product: { select: { id: true, name: true, skuCode: true } },
        location: { select: { id: true, name: true } },
      },
      take: 200,
    });
    return {
      items: rows.map((b) => ({
        id: b.id,
        batchCode: b.batchCode,
        expiresAt: b.expiresAt,
        qtyOnHand: Number(b.qtyOnHand),
        product: b.product,
        location: b.location,
      })),
    };
  }

  // ── Serial tracking ─────────────────────────────────────────────────────

  async createSerial(user: AuthUser, productId: string, dto: CreateSerialDto) {
    let product = await this.requireProduct(user.tenantId, productId);
    if (!product.trackSerial || !product.trackQty) {
      // Persist flags so Register works after "Enable serial tracking"
      product = await this.prisma.product.update({
        where: { id: productId },
        data: { trackSerial: true, trackQty: true },
      });
    }
    let locationId = dto.locationId;
    if (!locationId) {
      locationId =
        (await this.resolveDefaultLocationId(user.tenantId, null)) ?? undefined;
    }
    if (!locationId) throw new BadRequestException('No location configured');
    if (dto.variantId) {
      await this.requireVariant(user.tenantId, productId, dto.variantId);
    }
    const serial = normalizeBarcode(dto.serial);
    if (serial.length < 2) {
      throw new BadRequestException(
        'Enter a serial number (at least 2 characters)',
      );
    }

    // Ensure a stock row exists at this location (serial register must move SOH too).
    let level = await this.prisma.stockLevel.findFirst({
      where: {
        tenantId: user.tenantId,
        productId,
        locationId,
        variantKey: '',
      },
    });
    if (!level) {
      level = await this.prisma.stockLevel.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          productId,
          sku: product.skuCode.slice(0, 18),
          sellUnit: (product.unitOfMeasure || 'pcs').slice(0, 8),
          qtyOnHand: 0,
          sellPrice: product.basePrice,
          variantKey: '',
        },
      });
      await seedZeroStockAtOtherLocations(this.prisma, {
        tenantId: user.tenantId,
        productId,
        sku: product.skuCode.slice(0, 18),
        sellUnit: (product.unitOfMeasure || 'pcs').slice(0, 8),
        sellPrice: Number(product.basePrice),
        exceptLocationId: locationId,
      });
    }

    const availableUnits = await this.prisma.stockUnit.count({
      where: {
        tenantId: user.tenantId,
        productId,
        locationId,
        status: 'available',
      },
    });
    const onHand = Number(level.qtyOnHand);
    // Opening qty without serials leaves "phantom" SOH — absorb until serials catch up.
    const absorbPhantom = availableUnits < onHand - 1e-9;

    try {
      if (absorbPhantom) {
        const created = await this.prisma.stockUnit.create({
          data: {
            tenantId: user.tenantId,
            locationId,
            productId,
            productVariantId: dto.variantId ?? null,
            barcodeSku: serial,
            variantLabel: dto.label?.trim() || null,
            meta: { catalogSerial: true } as Prisma.InputJsonValue,
          },
          include: {
            location: { select: { id: true, name: true } },
          },
        });
        return {
          id: created.id,
          serial: created.barcodeSku,
          label: created.variantLabel,
          status: created.status,
          locationId: created.locationId,
          location: created.location,
          stockAdjusted: false,
        };
      }

      await this.stock.mutate(this.prisma, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId,
        productId,
        qty: 1,
        type: StockLedgerType.stock_in,
        reason: dto.label?.trim()
          ? `Register serial (${dto.label.trim()})`
          : 'Register serial',
        referenceType: 'catalog_serial',
        referenceId: productId,
        serialNumber: serial,
      });

      const unit = await this.prisma.stockUnit.findFirst({
        where: {
          tenantId: user.tenantId,
          productId,
          barcodeSku: serial,
        },
        include: {
          location: { select: { id: true, name: true } },
        },
      });
      if (!unit) {
        throw new BadRequestException('Serial registered but unit was not found');
      }
      // Keep catalog-serial marker for the Serials tab filter
      const meta = (unit.meta ?? {}) as Record<string, unknown>;
      if (meta.catalogSerial !== true) {
        await this.prisma.stockUnit.update({
          where: { id: unit.id },
          data: {
            meta: {
              ...meta,
              catalogSerial: true,
              ...(dto.label?.trim() ? {} : {}),
            } as Prisma.InputJsonValue,
            ...(dto.label?.trim()
              ? { variantLabel: dto.label.trim() }
              : {}),
          },
        });
      } else if (dto.label?.trim()) {
        await this.prisma.stockUnit.update({
          where: { id: unit.id },
          data: { variantLabel: dto.label.trim() },
        });
      }

      return {
        id: unit.id,
        serial: unit.barcodeSku,
        label: dto.label?.trim() || unit.variantLabel,
        status: unit.status,
        locationId: unit.locationId,
        location: unit.location,
        stockAdjusted: true,
      };
    } catch (e) {
      throwIfUnique(e, 'Serial / barcode already exists');
      throw e;
    }
  }

  async listSerials(user: AuthUser, productId: string) {
    await this.requireProduct(user.tenantId, productId);
    const units = await this.prisma.stockUnit.findMany({
      where: {
        tenantId: user.tenantId,
        productId,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        location: { select: { id: true, name: true } },
        productVariant: { select: { id: true, name: true } },
      },
      take: 500,
    });
    return {
      items: units
        .filter((u) => {
          const meta = (u.meta ?? {}) as Record<string, unknown>;
          return meta.catalogSerial === true || meta.catalogSerial === 'true';
        })
        .map((u) => ({
          id: u.id,
          serial: u.barcodeSku,
          label: u.variantLabel,
          status: u.status,
          location: u.location,
          variant: u.productVariant,
        })),
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private buildQrPayload(p: {
    id: string;
    skuCode: string;
    barcode: string | null;
    qrCode: string | null;
    name: string;
    kind: ProductKind;
  }) {
    const payload =
      p.qrCode?.trim() ||
      JSON.stringify({
        t: 'upos',
        id: p.id,
        sku: p.skuCode,
        barcode: p.barcode,
        kind: p.kind,
      });
    /** Client can render QR from this payload (no binary stored in DB). */
    return {
      payload,
      display: p.qrCode || p.barcode || p.skuCode,
      chartUrl: `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(payload)}`,
    };
  }

  private async requireProduct(tenantId: string, id: string) {
    const p = await this.prisma.product.findFirst({
      where: { id, tenantId },
    });
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }

  private async requireBrand(tenantId: string, id: string) {
    const b = await this.prisma.brand.findFirst({ where: { id, tenantId } });
    if (!b) throw new NotFoundException('Brand not found');
    return b;
  }

  private async requireCategory(tenantId: string, id: string) {
    const c = await this.prisma.category.findFirst({
      where: { id, tenantId },
    });
    if (!c) throw new NotFoundException('Category not found');
    return c;
  }

  private async requireVariant(
    tenantId: string,
    productId: string,
    variantId: string,
  ) {
    const v = await this.prisma.productVariant.findFirst({
      where: { id: variantId, productId, tenantId },
    });
    if (!v) throw new NotFoundException('Variant not found');
    return v;
  }
}
