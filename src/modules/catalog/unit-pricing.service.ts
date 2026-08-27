import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PricingStrategy, Prisma } from '@prisma/client';
import type { TaxProfile } from '../../common/tax-engine';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  calculateLineAmount,
  d,
  serializeLineCalc,
  UnitPricingError,
  type ConversionEdge,
  type LineCalcResult,
  type LineDiscountInput,
  type ProductPricingRef,
  type ProductUnitRef,
  type UnitRef,
} from './pricing-engine';

const SYSTEM_GROUPS: Array<{ code: string; name: string }> = [
  { code: 'WEIGHT', name: 'Weight' },
  { code: 'VOLUME', name: 'Volume' },
  { code: 'LENGTH', name: 'Length' },
  { code: 'AREA', name: 'Area' },
  { code: 'COUNT', name: 'Count' },
  { code: 'TIME', name: 'Time' },
  { code: 'CUSTOM', name: 'Custom' },
];

/** symbol, name, groupCode, isBase, conversionToGroupBase */
const SYSTEM_UNITS: Array<[string, string, string, boolean, number]> = [
  ['g', 'Gram', 'WEIGHT', true, 1],
  ['kg', 'Kilogram', 'WEIGHT', false, 1000],
  ['mg', 'Milligram', 'WEIGHT', false, 0.001],
  ['t', 'Tonne', 'WEIGHT', false, 1_000_000],
  ['lb', 'Pound', 'WEIGHT', false, 453.59237],
  ['oz', 'Ounce', 'WEIGHT', false, 28.349523125],
  ['ml', 'Millilitre', 'VOLUME', true, 1],
  ['L', 'Litre', 'VOLUME', false, 1000],
  ['m3', 'Cubic metre', 'VOLUME', false, 1_000_000],
  ['mm', 'Millimetre', 'LENGTH', true, 1],
  ['cm', 'Centimetre', 'LENGTH', false, 10],
  ['m', 'Metre', 'LENGTH', false, 1000],
  ['in', 'Inch', 'LENGTH', false, 25.4],
  ['ft', 'Foot', 'LENGTH', false, 304.8],
  ['m2', 'Square metre', 'AREA', true, 1],
  ['cm2', 'Square centimetre', 'AREA', false, 0.0001],
  ['pcs', 'Piece', 'COUNT', true, 1],
  ['pair', 'Pair', 'COUNT', false, 2],
  ['dozen', 'Dozen', 'COUNT', false, 12],
  ['pack', 'Pack', 'COUNT', false, 1],
  ['box', 'Box', 'COUNT', false, 1],
  ['case', 'Case', 'COUNT', false, 1],
  ['bag', 'Bag', 'COUNT', false, 1],
  ['carton', 'Carton', 'COUNT', false, 1],
  ['set', 'Set', 'COUNT', false, 1],
  ['service', 'Service', 'COUNT', false, 1],
  ['min', 'Minute', 'TIME', true, 1],
  ['hour', 'Hour', 'TIME', false, 60],
  ['day', 'Day', 'TIME', false, 1440],
  ['week', 'Week', 'TIME', false, 10080],
  ['month', 'Month', 'TIME', false, 43200],
];

@Injectable()
export class UnitPricingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent seed of unit groups + system units */
  async ensureSystemUnits() {
    for (const g of SYSTEM_GROUPS) {
      await this.prisma.unitGroup.upsert({
        where: { code: g.code },
        create: { code: g.code, name: g.name },
        update: { name: g.name, isActive: true },
      });
    }
    const groups = await this.prisma.unitGroup.findMany();
    const byCode = new Map(groups.map((x) => [x.code, x.id]));
    for (const [symbol, name, groupCode, isBase, factor] of SYSTEM_UNITS) {
      const unitGroupId = byCode.get(groupCode);
      if (!unitGroupId) continue;
      const existing = await this.prisma.unit.findFirst({
        where: { unitGroupId, symbol },
      });
      if (existing) {
        await this.prisma.unit.update({
          where: { id: existing.id },
          data: {
            name,
            isBaseUnit: isBase,
            conversionToGroupBase: factor,
            isActive: true,
          },
        });
      } else {
        await this.prisma.unit.create({
          data: {
            unitGroupId,
            name,
            symbol,
            isBaseUnit: isBase,
            conversionToGroupBase: factor,
          },
        });
      }
    }
    return this.listUnitGroups();
  }

  listUnitGroups() {
    return this.prisma.unitGroup.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      include: {
        units: {
          where: { isActive: true, tenantId: null },
          orderBy: [{ isBaseUnit: 'desc' }, { symbol: 'asc' }],
        },
      },
    });
  }

  async listProductUnits(user: AuthUser, productId: string) {
    await this.assertProduct(user.tenantId, productId);
    return this.prisma.productUnit.findMany({
      where: {
        tenantId: user.tenantId,
        productId,
        effectiveTo: null,
      },
      include: { unit: { include: { unitGroup: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async upsertProductUnit(
    user: AuthUser,
    productId: string,
    body: {
      unitId: string;
      conversionToBase: number | string;
      fixedPrice?: number | string | null;
      isDefaultSellingUnit?: boolean;
      isPurchaseUnit?: boolean;
      quantityPrecision?: number | null;
      minQuantity?: number | string | null;
      quantityStep?: number | string | null;
      allowFraction?: boolean | null;
      barcode?: string | null;
    },
  ) {
    const product = await this.assertProduct(user.tenantId, productId);
    let factor: Prisma.Decimal;
    try {
      factor = d(body.conversionToBase);
    } catch {
      throw new BadRequestException('conversion_to_base must be > 0');
    }
    if (!factor.gt(0)) {
      throw new BadRequestException('conversion_to_base must be > 0');
    }
    if (
      product.pricingStrategy === PricingStrategy.fixed_tier &&
      body.fixedPrice == null
    ) {
      throw new BadRequestException(
        'fixed_price is required for FIXED_TIER selling units',
      );
    }
    const unit = await this.prisma.unit.findFirst({
      where: {
        id: body.unitId,
        isActive: true,
        OR: [{ tenantId: null }, { tenantId: user.tenantId }],
      },
    });
    if (!unit) throw new NotFoundException('Unit not found');

    const now = new Date();
    const current = await this.prisma.productUnit.findFirst({
      where: {
        productId,
        unitId: body.unitId,
        effectiveTo: null,
      },
    });

    const barcode = body.barcode?.trim() || null;
    if (barcode) {
      const clash = await this.prisma.productUnit.findFirst({
        where: {
          tenantId: user.tenantId,
          barcode,
          effectiveTo: null,
          NOT: { productId },
        },
      });
      if (clash) {
        throw new BadRequestException('Barcode already used on another item unit');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (body.isDefaultSellingUnit) {
        await tx.productUnit.updateMany({
          where: { productId, effectiveTo: null, isDefaultSellingUnit: true },
          data: { isDefaultSellingUnit: false },
        });
      }
      if (current) {
        const same =
          d(current.conversionToBase).eq(factor) &&
          String(current.fixedPrice ?? '') === String(body.fixedPrice ?? '') &&
          current.isDefaultSellingUnit === Boolean(body.isDefaultSellingUnit) &&
          current.isPurchaseUnit === Boolean(body.isPurchaseUnit) &&
          current.quantityPrecision === (body.quantityPrecision ?? current.quantityPrecision) &&
          current.allowFraction === (body.allowFraction ?? current.allowFraction) &&
          (current.barcode ?? null) === barcode;
        if (same) return current;

        await tx.productUnit.update({
          where: { id: current.id },
          data: { effectiveTo: now },
        });
        await tx.auditLog.create({
          data: {
            tenantId: user.tenantId,
            actorUserId: user.userId,
            entityType: 'product_unit',
            entityId: current.id,
            action: 'product_unit.closed',
            beforeAfter: {
              productId,
              unitId: body.unitId,
              oldConversion: current.conversionToBase.toString(),
              newConversion: factor.toString(),
            },
          },
        });
      }

      const created = await tx.productUnit.create({
        data: {
          tenantId: user.tenantId,
          productId,
          unitId: body.unitId,
          conversionToBase: factor,
          fixedPrice:
            body.fixedPrice != null && body.fixedPrice !== ''
              ? d(body.fixedPrice)
              : null,
          isDefaultSellingUnit: Boolean(body.isDefaultSellingUnit),
          isPurchaseUnit: Boolean(body.isPurchaseUnit),
          quantityPrecision: body.quantityPrecision ?? null,
          minQuantity: body.minQuantity != null ? d(body.minQuantity) : 0,
          quantityStep: body.quantityStep != null ? d(body.quantityStep) : null,
          allowFraction: body.allowFraction ?? null,
          barcode,
          effectiveFrom: now,
          createdById: user.userId,
        },
        include: { unit: true },
      });

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'product_unit',
          entityId: created.id,
          action: 'product_unit.opened',
          beforeAfter: {
            productId,
            unitId: body.unitId,
            conversionToBase: factor.toString(),
            fixedPrice: body.fixedPrice ?? null,
          },
        },
      });

      return created;
    });
  }

  async loadUnitsMap(tenantId: string): Promise<Map<string, UnitRef>> {
    const units = await this.prisma.unit.findMany({
      where: {
        isActive: true,
        OR: [{ tenantId: null }, { tenantId }],
      },
      include: { unitGroup: true },
    });
    const unitsById = new Map<string, UnitRef>();
    for (const u of units) {
      unitsById.set(u.id, {
        id: u.id,
        symbol: u.symbol,
        unitGroupId: u.unitGroupId,
        unitGroupCode: u.unitGroup.code,
        conversionToGroupBase: u.conversionToGroupBase,
        isActive: u.isActive,
      });
    }
    return unitsById;
  }

  resolveUnit(
    unitsById: Map<string, UnitRef>,
    unitId?: string | null,
    symbol?: string | null,
  ): UnitRef | undefined {
    if (unitId && unitsById.has(unitId)) return unitsById.get(unitId);
    const want = (symbol ?? '').trim().toLowerCase();
    if (!want) return undefined;
    for (const u of unitsById.values()) {
      if (u.symbol.toLowerCase() === want) return u;
    }
    return undefined;
  }

  private toProductRef(
    product: {
      id: string;
      baseUnitId: string | null;
      pricingUnitId: string | null;
      pricingStrategy: PricingStrategy;
      pricePerPricingUnit: Prisma.Decimal | null;
      basePrice: Prisma.Decimal;
      availableInPos: boolean;
      canSell: boolean;
      canPurchase: boolean;
      isActive: boolean;
      trackQty: boolean;
      productUnits: Array<{
        unitId: string;
        conversionToBase: Prisma.Decimal;
        fixedPrice: Prisma.Decimal | null;
        effectiveFrom: Date;
        effectiveTo: Date | null;
        quantityPrecision?: number | null;
        minQuantity?: Prisma.Decimal | null;
        quantityStep?: Prisma.Decimal | null;
        allowFraction?: boolean | null;
        barcode?: string | null;
        isDefaultSellingUnit?: boolean;
        isPurchaseUnit?: boolean;
      }>;
    },
    edges: ConversionEdge[],
  ): ProductPricingRef {
    if (!product.baseUnitId) {
      throw new BadRequestException(
        'Product has no base unit configured — set Unit & Pricing on the item',
      );
    }
    const productUnits: ProductUnitRef[] = product.productUnits.map((pu) => ({
      unitId: pu.unitId,
      conversionToBase: pu.conversionToBase,
      fixedPrice: pu.fixedPrice,
      effectiveFrom: pu.effectiveFrom,
      effectiveTo: pu.effectiveTo,
      quantityPrecision: pu.quantityPrecision,
      minQuantity: pu.minQuantity,
      quantityStep: pu.quantityStep,
      allowFraction: pu.allowFraction,
      barcode: pu.barcode,
      isDefaultSellingUnit: pu.isDefaultSellingUnit,
      isPurchaseUnit: pu.isPurchaseUnit,
    }));
    return {
      id: product.id,
      baseUnitId: product.baseUnitId,
      pricingUnitId: product.pricingUnitId,
      pricingStrategy:
        product.pricingStrategy === PricingStrategy.fixed_tier
          ? 'FIXED_TIER'
          : 'CONVERTED',
      pricePerPricingUnit:
        product.pricePerPricingUnit != null
          ? product.pricePerPricingUnit
          : product.pricingStrategy === PricingStrategy.converted
            ? product.basePrice
            : null,
      basePrice: product.basePrice,
      productUnits,
      conversionEdges: edges,
      availableInPos: product.availableInPos,
      canSell: product.canSell,
      canPurchase: product.canPurchase,
      isActive: product.isActive,
      trackQty: product.trackQty,
    };
  }

  async loadConversionEdges(
    tenantId: string,
    productId: string,
    unitsById: Map<string, UnitRef>,
  ): Promise<ConversionEdge[]> {
    const rows = await this.prisma.unitConversion.findMany({
      where: {
        tenantId,
        OR: [{ productId }, { productKey: '' }, { productId: null }],
      },
      orderBy: { productId: 'desc' },
    });
    const bySymbol = new Map<string, UnitRef>();
    for (const u of unitsById.values()) {
      bySymbol.set(u.symbol.toLowerCase(), u);
    }
    const edges: ConversionEdge[] = [];
    for (const row of rows) {
      const from = bySymbol.get(row.fromUnit.toLowerCase());
      const to = bySymbol.get(row.toUnit.toLowerCase());
      if (!from || !to) continue;
      edges.push({
        fromUnitId: from.id,
        toUnitId: to.id,
        factor: row.factor,
      });
    }
    return edges;
  }

  async calculateLine(
    user: AuthUser,
    body: {
      productId: string;
      enteredQty: number | string;
      sellingUnitId?: string | null;
      sellingUnitSymbol?: string | null;
      unitPriceOverride?: number | string | null;
      lineDiscount?: LineDiscountInput | null;
      taxProfile?: TaxProfile | null;
      taxRate?: number | null;
      inventorySign?: 1 | -1;
      at?: Date;
    },
  ): Promise<LineCalcResult> {
    const product = await this.prisma.product.findFirst({
      where: { id: body.productId, tenantId: user.tenantId },
      include: {
        productUnits: { where: { effectiveTo: null } },
        baseUnit: { include: { unitGroup: true } },
        pricingUnit: { include: { unitGroup: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isActive) {
      throw new BadRequestException('Product is not available');
    }

    const unitsById = await this.loadUnitsMap(user.tenantId);
    const sellingUnit = this.resolveUnit(
      unitsById,
      body.sellingUnitId,
      body.sellingUnitSymbol,
    );
    if (!sellingUnit) {
      throw new NotFoundException('Selling unit not found or not enabled');
    }

    const edges = await this.loadConversionEdges(
      user.tenantId,
      product.id,
      unitsById,
    );
    const ref = this.toProductRef(product, edges);

    try {
      return calculateLineAmount({
        product: ref,
        enteredQty: body.enteredQty,
        sellingUnit,
        unitsById,
        extraEdges: edges,
        unitPriceOverride: body.unitPriceOverride,
        lineDiscount: body.lineDiscount,
        taxProfile: body.taxProfile,
        taxRate: body.taxRate,
        inventorySign: body.inventorySign,
        at: body.at,
      });
    } catch (e) {
      if (e instanceof UnitPricingError) {
        throw new BadRequestException(e.message);
      }
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Pricing failed',
      );
    }
  }

  async quoteLine(
    user: AuthUser,
    body: { productId: string; enteredQty: number; sellingUnitId: string },
  ) {
    const line = await this.calculateLine(user, body);
    return serializeLineCalc(line);
  }

  /** Convert for GRN / stock — returns qty in product base unit */
  async convertToBase(
    user: AuthUser,
    productId: string,
    qty: number | string,
    fromUnitId: string,
  ) {
    const quote = await this.calculateLine(user, {
      productId,
      enteredQty: qty,
      sellingUnitId: fromUnitId,
      inventorySign: 1,
    });
    return {
      qtyBase: quote.qtyBase.toFixed(),
      conversionFactorUsed: quote.conversionFactorUsed.toFixed(),
      enteredUnitId: fromUnitId,
      enteredQty: d(qty).toFixed(),
    };
  }

  /**
   * Convert a qty+unit symbol into product base qty (recipes, GRN, transfers).
   * When the product has no unit master, returns the input qty unchanged.
   */
  async convertSymbolToBase(
    tenantId: string,
    productId: string,
    qty: number | string,
    fromSymbol?: string | null,
  ): Promise<Prisma.Decimal> {
    const entered = d(qty);
    if (!fromSymbol?.trim()) return entered;
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      include: { productUnits: { where: { effectiveTo: null } } },
    });
    if (!product?.baseUnitId) return entered;
    const unitsById = await this.loadUnitsMap(tenantId);
    const from = this.resolveUnit(unitsById, null, fromSymbol);
    const base = unitsById.get(product.baseUnitId);
    if (!from || !base) return entered;
    const edges = await this.loadConversionEdges(tenantId, productId, unitsById);
    const ref = this.toProductRef(product, edges);
    try {
      const line = calculateLineAmount({
        product: ref,
        enteredQty: entered.abs(),
        sellingUnit: from,
        unitsById,
        extraEdges: edges,
        inventorySign: 1,
        validate: false,
      });
      return entered.isNeg() ? line.baseQuantity.neg() : line.baseQuantity;
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'Unit conversion failed',
      );
    }
  }

  private async assertProduct(tenantId: string, productId: string) {
    const p = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
    });
    if (!p) throw new NotFoundException('Product not found');
    return p;
  }
}
