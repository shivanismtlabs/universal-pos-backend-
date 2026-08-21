import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockLedgerType } from '@prisma/client';
import { writeAudit } from '../../common/audit-write';
import { assertLocationAccess } from '../../common/location-access';
import { hasPermission } from '../../common/rbac';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import { StockMutationEngine } from '../inventory/stock-mutation.engine';
import {
  CompleteProductionStageDto,
  CreateModifierGroupDto,
  CreateModifierOptionDto,
  CreateRecipeStageDto,
  RecordWastageDto,
  UpsertRecipeDto,
} from './dto/restaurant.dto';
import {
  foodCostPercent,
  foodMargin,
  isRecipePurpose,
  normalizeWastageReason,
  recipeCostTotal,
} from './restaurant-policy';

@Injectable()
export class RestaurantKitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockMutationEngine,
  ) {}

  async listRecipes(user: AuthUser) {
    const products = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        bundleComponents: {
          some: { consumeOnSale: true, purpose: { in: ['recipe', 'production'] } },
        },
      },
      select: {
        id: true,
        name: true,
        skuCode: true,
        basePrice: true,
        trackQty: true,
        unitOfMeasure: true,
        meta: true,
        bundleComponents: {
          include: {
            componentProduct: {
              select: {
                id: true,
                name: true,
                skuCode: true,
                costPrice: true,
                unitOfMeasure: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        recipeStages: { orderBy: { sortOrder: 'asc' } },
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
    return products.map((p) => this.presentRecipe(p, false));
  }

  async getRecipe(user: AuthUser, productId: string, includeCost: boolean) {
    const p = await this.loadRecipeProduct(user.tenantId, productId);
    return this.presentRecipe(p, includeCost && this.canReadCost(user));
  }

  async upsertRecipe(user: AuthUser, productId: string, dto: UpsertRecipeDto) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId: user.tenantId },
    });
    if (!product) throw new NotFoundException('Item not found');
    for (const line of dto.lines) {
      if (line.componentProductId === productId) {
        throw new BadRequestException('Recipe cannot include itself');
      }
      const comp = await this.prisma.product.findFirst({
        where: { id: line.componentProductId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!comp) throw new NotFoundException('Ingredient item not found');
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
            consumeOnSale: true,
            purpose: 'recipe',
            unit: l.unit?.trim() || null,
            wastagePercent: l.wastagePercent ?? 0,
            stageId: l.stageId ?? null,
            stageKey: l.stageId ?? '',
          },
        });
      }
      if (dto.lines.length) {
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
    await writeAudit(this.prisma, {
      tenantId: user.tenantId,
      actorUserId: user.userId,
      entityType: 'Product',
      entityId: productId,
      action: 'recipe.upsert',
      after: { lines: dto.lines.length },
    });
    return this.getRecipe(user, productId, this.canReadCost(user));
  }

  async createStage(
    user: AuthUser,
    productId: string,
    dto: CreateRecipeStageDto,
  ) {
    await this.requireProduct(user.tenantId, productId);
    return this.prisma.recipeStage.create({
      data: {
        tenantId: user.tenantId,
        productId,
        name: dto.name.trim(),
        sortOrder: dto.sortOrder ?? 0,
        outputProductId: dto.outputProductId ?? null,
        outputQty: dto.outputQty ?? 1,
      },
    });
  }

  async completeStage(user: AuthUser, dto: CompleteProductionStageDto) {
    await assertLocationAccess(this.prisma, user, dto.locationId);
    const stage = await this.prisma.recipeStage.findFirst({
      where: {
        id: dto.stageId,
        tenantId: user.tenantId,
        productId: dto.productId,
      },
    });
    if (!stage) throw new NotFoundException('Recipe stage not found');
    await this.prisma.$transaction(async (tx) => {
      await this.stock.consumeForParent(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: dto.locationId,
        productId: dto.productId,
        parentQty: dto.qty,
        referenceType: 'production_stage',
        referenceId: stage.id,
        stageId: stage.id,
      });
      if (stage.outputProductId) {
        const out = await tx.product.findFirst({
          where: { id: stage.outputProductId, tenantId: user.tenantId },
        });
        if (!out) throw new NotFoundException('Stage output item not found');
        await this.stock.ensureLevel(tx, {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          productId: out.id,
          sku: out.skuCode,
          sellUnit: out.unitOfMeasure,
          sellPrice: out.basePrice,
        });
        const outQty = Number(stage.outputQty) * dto.qty;
        await this.stock.mutateInTx(tx, {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          locationId: dto.locationId,
          productId: stage.outputProductId,
          qty: outQty,
          type: StockLedgerType.production_in,
          reason: `Stage ${stage.name}`,
          referenceType: 'production_stage',
          referenceId: stage.id,
          skipComponentExplosion: true,
          allowNegative: true,
        });
      }
    });
    return { ok: true, stageId: stage.id, qty: dto.qty };
  }

  async foodCost(user: AuthUser, productId?: string) {
    if (!this.canReadCost(user)) {
      throw new ForbiddenException('Food cost requires cost / profit permission');
    }
    if (productId) {
      const p = await this.loadRecipeProduct(user.tenantId, productId);
      return this.presentRecipe(p, true);
    }
    const products = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        bundleComponents: {
          some: { consumeOnSale: true, purpose: { in: ['recipe', 'production'] } },
        },
      },
      include: {
        bundleComponents: {
          include: {
            componentProduct: {
              select: {
                id: true,
                name: true,
                skuCode: true,
                costPrice: true,
                unitOfMeasure: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        recipeStages: { orderBy: { sortOrder: 'asc' } },
      },
      orderBy: { name: 'asc' },
      take: 500,
    });
    return products.map((p) => this.presentRecipe(p, true));
  }

  async listModifierGroups(user: AuthUser) {
    return this.prisma.modifierGroup.findMany({
      where: { tenantId: user.tenantId },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createModifierGroup(user: AuthUser, dto: CreateModifierGroupDto) {
    return this.prisma.modifierGroup.create({
      data: {
        tenantId: user.tenantId,
        name: dto.name.trim(),
        minSelect: dto.minSelect ?? 0,
        maxSelect: dto.maxSelect ?? 1,
        required: dto.required ?? false,
      },
      include: { options: true },
    });
  }

  async addModifierOption(
    user: AuthUser,
    groupId: string,
    dto: CreateModifierOptionDto,
  ) {
    const group = await this.prisma.modifierGroup.findFirst({
      where: { id: groupId, tenantId: user.tenantId },
    });
    if (!group) throw new NotFoundException('Modifier group not found');
    return this.prisma.modifierOption.create({
      data: {
        tenantId: user.tenantId,
        groupId,
        name: dto.name.trim(),
        priceDelta: dto.priceDelta ?? 0,
        linkedProductId: dto.linkedProductId ?? null,
        consumeQty: dto.consumeQty ?? null,
      },
    });
  }

  async attachModifierGroup(
    user: AuthUser,
    productId: string,
    groupId: string,
  ) {
    await this.requireProduct(user.tenantId, productId);
    const group = await this.prisma.modifierGroup.findFirst({
      where: { id: groupId, tenantId: user.tenantId },
    });
    if (!group) throw new NotFoundException('Modifier group not found');
    await this.prisma.productModifierGroup.upsert({
      where: { productId_groupId: { productId, groupId } },
      create: { tenantId: user.tenantId, productId, groupId },
      update: {},
    });
    await this.syncProductModifierMeta(user.tenantId, productId);
    return this.productModifiers(user, productId);
  }

  async productModifiers(user: AuthUser, productId: string) {
    const links = await this.prisma.productModifierGroup.findMany({
      where: { tenantId: user.tenantId, productId },
      include: {
        group: { include: { options: { orderBy: { sortOrder: 'asc' } } } },
      },
      orderBy: { sortOrder: 'asc' },
    });
    return links.map((l) => l.group);
  }

  async recordWastage(user: AuthUser, dto: RecordWastageDto) {
    await assertLocationAccess(this.prisma, user, dto.locationId);
    const product = await this.requireProduct(user.tenantId, dto.productId);
    const reason = normalizeWastageReason(dto.reason);
    const qty = Number(dto.qty);
    const ledgerType =
      reason === 'damaged' ? StockLedgerType.damage : StockLedgerType.stock_out;
    const result = await this.prisma.$transaction(async (tx) => {
      const mut = await this.stock.mutateInTx(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        locationId: dto.locationId,
        productId: dto.productId,
        stockLevelId: dto.stockLevelId,
        qty: -qty,
        type: ledgerType,
        damageDelta: reason === 'damaged' ? qty : 0,
        reason: `${reason}${dto.notes ? `: ${dto.notes}` : ''}`,
        referenceType: 'wastage',
        inputUnit: dto.unit,
      });
      const event = await tx.wastageEvent.create({
        data: {
          tenantId: user.tenantId,
          locationId: dto.locationId,
          productId: dto.productId,
          stockLevelId: mut.stockLevelId,
          qty,
          unit: dto.unit ?? product.unitOfMeasure,
          reason,
          notes: dto.notes?.trim() || null,
          actorUserId: user.userId,
          ledgerEntryId: mut.ledgerId || null,
        },
      });
      await writeAudit(tx, {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'WastageEvent',
        entityId: event.id,
        action: 'wastage.record',
        after: { reason, qty, productId: dto.productId },
      });
      return event;
    });
    return result;
  }

  async listWastage(
    user: AuthUser,
    opts: { locationId?: string; take?: number },
  ) {
    if (opts.locationId) {
      await assertLocationAccess(this.prisma, user, opts.locationId);
    }
    const rows = await this.prisma.wastageEvent.findMany({
      where: {
        tenantId: user.tenantId,
        ...(opts.locationId ? { locationId: opts.locationId } : {}),
      },
      include: {
        location: { select: { id: true, name: true } },
        actor: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts.take ?? 100, 300),
    });
    const products = await this.prisma.product.findMany({
      where: {
        tenantId: user.tenantId,
        id: { in: [...new Set(rows.map((r) => r.productId))] },
      },
      select: { id: true, name: true, skuCode: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    return rows.map((r) => ({
      id: r.id,
      qty: Number(r.qty),
      unit: r.unit,
      reason: r.reason,
      notes: r.notes,
      createdAt: r.createdAt,
      location: r.location,
      actor: r.actor
        ? { id: r.actor.id, name: r.actor.fullName }
        : null,
      product: byId.get(r.productId) ?? { id: r.productId },
    }));
  }

  private canReadCost(user: AuthUser): boolean {
    const roles = user.roles ?? [];
    if (
      roles.includes('admin') ||
      roles.includes('manager') ||
      roles.includes('accountant')
    ) {
      return true;
    }
    return (
      hasPermission(user.permissions, 'catalog.cost.read') ||
      hasPermission(user.permissions, 'reports.profit.read') ||
      hasPermission(user.permissions, '*')
    );
  }

  private async requireProduct(tenantId: string, id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, tenantId } });
    if (!p) throw new NotFoundException('Item not found');
    return p;
  }

  private async loadRecipeProduct(tenantId: string, productId: string) {
    const p = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      include: {
        bundleComponents: {
          include: {
            componentProduct: {
              select: {
                id: true,
                name: true,
                skuCode: true,
                costPrice: true,
                unitOfMeasure: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
        recipeStages: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!p) throw new NotFoundException('Item not found');
    return p;
  }

  private presentRecipe(
    p: {
      id: string;
      name: string;
      skuCode: string;
      basePrice: Prisma.Decimal | number;
      trackQty?: boolean;
      unitOfMeasure?: string;
      meta?: unknown;
      bundleComponents: Array<{
        id: string;
        quantity: Prisma.Decimal | number;
        purpose: string;
        consumeOnSale: boolean;
        unit: string | null;
        wastagePercent: Prisma.Decimal | number;
        stageId: string | null;
        componentProduct: {
          id: string;
          name: string;
          skuCode: string;
          costPrice: Prisma.Decimal | number | null;
          unitOfMeasure: string;
        };
      }>;
      recipeStages?: Array<{
        id: string;
        name: string;
        sortOrder: number;
        outputProductId: string | null;
        outputQty: Prisma.Decimal | number;
      }>;
    },
    includeCost: boolean,
  ) {
    const lines = p.bundleComponents
      .filter((l) => l.consumeOnSale && isRecipePurpose(l.purpose))
      .map((l) => ({
        id: l.id,
        componentProductId: l.componentProduct.id,
        name: l.componentProduct.name,
        skuCode: l.componentProduct.skuCode,
        quantity: Number(l.quantity),
        unit: l.unit ?? l.componentProduct.unitOfMeasure,
        wastagePercent: Number(l.wastagePercent ?? 0),
        stageId: l.stageId,
        unitCost: includeCost
          ? Number(l.componentProduct.costPrice ?? 0)
          : undefined,
      }));
    const sell = Number(p.basePrice ?? 0);
    return {
      productId: p.id,
      name: p.name,
      skuCode: p.skuCode,
      basePrice: sell,
      trackQty: p.trackQty === true,
      stages: p.recipeStages ?? [],
      lines,
      ...(includeCost ? this.costBlock(lines, sell) : {}),
    };
  }

  private costBlock(
    lines: Array<{ quantity: number; unitCost?: number; wastagePercent?: number }>,
    sellPrice: number,
  ) {
    const recipeCost = recipeCostTotal(
      lines.map((l) => ({
        quantity: l.quantity,
        unitCost: l.unitCost ?? 0,
        wastagePercent: l.wastagePercent,
      })),
    );
    const pct = foodCostPercent(recipeCost, sellPrice);
    const margin = foodMargin(sellPrice, recipeCost);
    return {
      recipeCost,
      foodCostPercent: pct,
      marginAmount: margin.amount,
      marginPercent: margin.percent,
    };
  }

  private async syncProductModifierMeta(tenantId: string, productId: string) {
    const groups = await this.prisma.productModifierGroup.findMany({
      where: { tenantId, productId },
      include: {
        group: { include: { options: { orderBy: { sortOrder: 'asc' } } } },
      },
      orderBy: { sortOrder: 'asc' },
    });
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: { meta: true, kind: true },
    });
    if (!product) return;
    const meta =
      product.meta && typeof product.meta === 'object'
        ? (product.meta as Record<string, unknown>)
        : {};
    await this.prisma.product.update({
      where: { id: productId },
      data: {
        meta: {
          ...meta,
          modifierGroups: groups.map((g) => ({
            id: g.group.id,
            name: g.group.name,
            minSelect: g.group.minSelect,
            maxSelect: g.group.maxSelect,
            required: g.group.required,
            options: g.group.options.map((o) => ({
              id: o.id,
              name: o.name,
              priceDelta: Number(o.priceDelta),
              linkedProductId: o.linkedProductId,
              consumeQty: o.consumeQty != null ? Number(o.consumeQty) : null,
            })),
          })),
        } as Prisma.InputJsonValue,
      },
    });
  }
}
