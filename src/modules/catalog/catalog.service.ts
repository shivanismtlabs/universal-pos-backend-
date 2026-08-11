import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FulfillmentMode,
  Prisma,
  ProductKind,
  ProductStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/database.module';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { validateSku } from '../../common/sell-units';
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

function dec(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return null;
  return new Prisma.Decimal(n);
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
  qrCode: string | null;
  internalCode: string | null;
  kind: ProductKind;
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
}) {
  const meta = (p.meta ?? {}) as Record<string, unknown>;
  const images = Array.isArray(meta.images)
    ? (meta.images as string[]).filter(Boolean)
    : p.photoUrl
      ? [p.photoUrl]
      : [];
  return {
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    skuCode: p.skuCode,
    sku: p.skuCode,
    barcode: p.barcode,
    qrCode: p.qrCode,
    internalCode: p.internalCode,
    kind: p.kind,
    productType: p.kind,
    status: p.status,
    shortDescription: p.shortDescription,
    description: p.description,
    photoUrl: p.photoUrl ?? images[0] ?? null,
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
    meta,
    counts: {
      variants: p._count?.variants ?? 0,
      batches: p._count?.batches ?? 0,
      bundleLines: p._count?.bundleComponents ?? 0,
    },
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

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

  // ── SKU generation ──────────────────────────────────────────────────────

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

  // ── Products (catalog master) ───────────────────────────────────────────

  async listProducts(user: AuthUser, query: ListCatalogQueryDto) {
    const q = query.q?.trim();
    const rows = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(query.brandId ? { brandId: query.brandId } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.availableInPos === 'true'
          ? { availableInPos: true }
          : query.availableInPos === 'false'
            ? { availableInPos: false }
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
      },
      orderBy: { name: 'asc' },
      include: {
        category: { select: { id: true, name: true, parentId: true } },
        brand: { select: { id: true, name: true } },
        _count: {
          select: { variants: true, batches: true, bundleComponents: true },
        },
      },
      take: 500,
    });
    return { items: rows.map(mapProduct) };
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
              select: { id: true, name: true, skuCode: true, kind: true },
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
            location: { select: { id: true, name: true } },
          },
        },
        stockUnits: {
          where: {
            meta: { path: ['catalogSerial'], equals: true },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: {
            id: true,
            barcodeSku: true,
            variantLabel: true,
            status: true,
            locationId: true,
            productVariantId: true,
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
      serials: p.stockUnits.map((u) => ({
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
    const images = (dto.images ?? []).filter(Boolean).slice(0, 12);
    const photoUrl = dto.photoUrl?.trim() || images[0] || null;
    const meta: Record<string, unknown> = {
      ...(dto.extraFields && typeof dto.extraFields === 'object'
        ? dto.extraFields
        : {}),
      ...(images.length ? { images } : {}),
      sellUnit: unit,
    };

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
            brandId: dto.brandId ?? null,
            barcode: dto.barcode?.trim() || null,
            qrCode: dto.qrCode?.trim() || null,
            internalCode: dto.internalCode?.trim() || null,
            shortDescription: dto.shortDescription?.trim() || null,
            description: dto.description?.trim() || null,
            photoUrl,
            taxCode: dto.taxCode?.trim() || null,
            basePrice: price,
            costPrice: dec(dto.costPrice),
            mrp: dec(dto.mrp),
            unitOfMeasure: unit,
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

        if (trackQty && (dto.openingQty == null || dto.openingQty >= 0)) {
          const locationId =
            dto.locationId ??
            (
              await tx.location.findFirst({
                where: { tenantId: user.tenantId, isActive: true },
                orderBy: { createdAt: 'asc' },
                select: { id: true },
              })
            )?.id;
          if (locationId) {
            await tx.stockLevel.create({
              data: {
                tenantId: user.tenantId,
                locationId,
                productId: created.id,
                sku: sku!,
                sellUnit: unit.slice(0, 8),
                qtyOnHand: dto.openingQty ?? 0,
                sellPrice: price,
              },
            });
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

    const prevMeta = (existing.meta ?? {}) as Record<string, unknown>;
    let nextMeta = { ...prevMeta };
    if (dto.images) {
      nextMeta.images = dto.images.filter(Boolean).slice(0, 12);
    }
    if (dto.extraFields) {
      nextMeta = { ...nextMeta, ...dto.extraFields };
    }
    if (dto.unitOfMeasure) {
      nextMeta.sellUnit = dto.unitOfMeasure;
    }

    const status = dto.status ?? existing.status;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.product.update({
          where: { id },
          data: {
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
              ? { barcode: dto.barcode?.trim() || null }
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
            ...(dto.photoUrl !== undefined
              ? { photoUrl: dto.photoUrl?.trim() || null }
              : {}),
            ...(dto.taxCode !== undefined
              ? { taxCode: dto.taxCode?.trim() || null }
              : {}),
            ...(dto.basePrice !== undefined
              ? { basePrice: dto.basePrice }
              : {}),
            ...(dto.costPrice !== undefined
              ? { costPrice: dec(dto.costPrice ?? undefined) }
              : {}),
            ...(dto.mrp !== undefined
              ? { mrp: dec(dto.mrp ?? undefined) }
              : {}),
            ...(dto.unitOfMeasure !== undefined
              ? { unitOfMeasure: dto.unitOfMeasure.trim().slice(0, 16) }
              : {}),
            ...(dto.trackInventory !== undefined
              ? { trackQty: dto.trackInventory }
              : {}),
            ...(dto.trackSerial !== undefined
              ? { trackSerial: dto.trackSerial }
              : {}),
            ...(dto.trackBatch !== undefined
              ? { trackBatch: dto.trackBatch }
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
          },
        });

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
      openingQty: 0,
    });
  }

  async deleteProduct(user: AuthUser, id: string) {
    await this.requireProduct(user.tenantId, id);
    const used = await this.prisma.orderItem.count({
      where: { tenantId: user.tenantId, productId: id },
    });
    if (used > 0) {
      return this.setStatus(user, id, ProductStatus.archived);
    }
    await this.prisma.product.delete({ where: { id } });
    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'product',
        entityId: id,
        action: 'catalog.product.deleted',
      },
    });
    return { ok: true, deleted: true };
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
    if (product.kind !== ProductKind.bundle) {
      throw new BadRequestException(
        'Only bundle product type can have components',
      );
    }
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
      for (const l of dto.lines) {
        await tx.productBundleLine.create({
          data: {
            tenantId: user.tenantId,
            bundleProductId: productId,
            componentProductId: l.componentProductId,
            componentVariantId: l.componentVariantId ?? null,
            quantity: l.quantity ?? 1,
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
    const product = await this.requireProduct(user.tenantId, productId);
    if (!product.trackSerial) {
      throw new BadRequestException(
        'Enable serial tracking on this product first',
      );
    }
    let locationId = dto.locationId;
    if (!locationId) {
      locationId = (
        await this.prisma.location.findFirst({
          where: { tenantId: user.tenantId, isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      )?.id;
    }
    if (!locationId) throw new BadRequestException('No location configured');
    if (dto.variantId) {
      await this.requireVariant(user.tenantId, productId, dto.variantId);
    }
    const serial = dto.serial.trim();
    try {
      return await this.prisma.stockUnit.create({
        data: {
          tenantId: user.tenantId,
          locationId,
          productId,
          productVariantId: dto.variantId ?? null,
          barcodeSku: serial,
          variantLabel: dto.label?.trim() || null,
          meta: { catalogSerial: true },
        },
      });
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
        meta: { path: ['catalogSerial'], equals: true },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        location: { select: { id: true, name: true } },
        productVariant: { select: { id: true, name: true } },
      },
    });
    return {
      items: units.map((u) => ({
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
