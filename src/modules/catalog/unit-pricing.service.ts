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
  countryCodeFromTenantSettings,
  countryUomProfile,
} from '../../common/country-uom-defaults';
import {
  calculateLineAmount,
  convertQuantity,
  d,
  serializeLineCalc,
  UnitPricingError,
  type ConversionEdge,
  type CustomerContext,
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
  ['gal', 'Gallon (US)', 'VOLUME', false, 3785.411784],
  ['fl oz', 'Fluid ounce (US)', 'VOLUME', false, 29.5735295625],
  ['pt', 'Pint (US)', 'VOLUME', false, 473.176473],
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
    unitsById?: Map<string, UnitRef>,
  ): ProductPricingRef {
    let baseUnitId = product.baseUnitId;
    if (!baseUnitId && unitsById) {
      const match = this.resolveUnit(unitsById, null, (product as any).sellUnit ?? 'pcs')
        ?? this.resolveUnit(unitsById, null, 'pcs');
      if (match) baseUnitId = match.id;
    }
    if (!baseUnitId) {
      throw new BadRequestException(
        'Product has no base unit configured — set Unit & Pricing on the item',
      );
    }
    const productUnits: ProductUnitRef[] = (product.productUnits ?? []).map((pu) => ({
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
      baseUnitId,
      pricingUnitId: product.pricingUnitId ?? baseUnitId,
      pricingStrategy:
        product.pricingStrategy === PricingStrategy.fixed_tier
          ? 'FIXED_TIER'
          : 'CONVERTED',
      pricePerPricingUnit:
        product.pricePerPricingUnit != null
          ? product.pricePerPricingUnit
          : product.basePrice != null
            ? product.basePrice
            : null,
      basePrice: product.basePrice,
      mrp: (product as any).mrp != null ? d((product as any).mrp) : null,
      meta: (product as any).meta ?? null,
      productDiscount:
        (product as any).productDiscount ??
        (product as any).meta?.productDiscount ??
        (product as any).meta?.discountRule ??
        null,
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
        factor: d(row.factor),
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
      customer?: CustomerContext | null;
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
    const ref = this.toProductRef(product, edges, unitsById);

    try {
      return calculateLineAmount({
        product: ref,
        enteredQty: body.enteredQty,
        sellingUnit,
        unitsById,
        extraEdges: edges,
        unitPriceOverride: body.unitPriceOverride,
        lineDiscount: body.lineDiscount,
        customer: body.customer,
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
    body: {
      productId: string;
      enteredQty: number;
      sellingUnitId?: string;
      sellingUnitSymbol?: string;
      customer?: CustomerContext;
    },
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

  /** Country → suggested units (config-driven, not if/else in POS). */
  async getCountryDefaults(countryCode?: string | null) {
    await this.ensureSystemUnits();
    const profile = countryUomProfile(countryCode);
    const units = await this.prisma.unit.findMany({
      where: {
        tenantId: null,
        isActive: true,
        symbol: { in: profile.suggestedSymbols },
      },
      include: { unitGroup: true },
      orderBy: [{ unitGroup: { name: 'asc' } }, { symbol: 'asc' }],
    });
    const bySymbol = new Map(units.map((u) => [u.symbol.toLowerCase(), u]));
    const suggested = profile.suggestedSymbols
      .map((sym) => bySymbol.get(sym.toLowerCase()))
      .filter((u): u is NonNullable<typeof u> => u != null);
    return {
      countryCode: profile.countryCode,
      label: profile.label,
      measureSystem: profile.measureSystem,
      suggestedSymbols: profile.suggestedSymbols,
      suggestedUnits: suggested.map((u) => ({
        id: u.id,
        symbol: u.symbol,
        name: u.name,
        category: u.unitGroup.code,
        isBaseUnit: u.isBaseUnit,
      })),
    };
  }

  /** Tenant-scoped unit list (system + custom). Does not replace legacy settings.units. */
  async listTenantUnits(tenantId: string) {
    await this.ensureSystemUnits();
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const disabled = this.disabledUnitSymbols(tenant?.settings);
    const units = await this.prisma.unit.findMany({
      where: {
        isActive: true,
        OR: [{ tenantId: null }, { tenantId }],
      },
      include: { unitGroup: true },
      orderBy: [{ unitGroup: { code: 'asc' } }, { symbol: 'asc' }],
    });
    return units
      .filter((u) => !disabled.has(u.symbol.toLowerCase()))
      .map((u) => ({
        id: u.id,
        symbol: u.symbol,
        name: u.name,
        category: u.unitGroup.code,
        categoryName: u.unitGroup.name,
        isBaseUnit: u.isBaseUnit,
        conversionToGroupBase: u.conversionToGroupBase.toString(),
        isSystem: u.tenantId == null,
        measureSystem:
          u.unitGroup.code === 'WEIGHT' || u.unitGroup.code === 'VOLUME'
            ? ['lb', 'oz', 'gal', 'fl oz', 'pt', 'in', 'ft'].includes(u.symbol)
              ? 'imperial'
              : 'metric'
            : 'neutral',
      }));
  }

  private disabledUnitSymbols(settings: unknown): Set<string> {
    if (!settings || typeof settings !== 'object') return new Set();
    const uom = (settings as Record<string, unknown>).uom;
    if (!uom || typeof uom !== 'object') return new Set();
    const raw = (uom as Record<string, unknown>).disabledSymbols;
    if (!Array.isArray(raw)) return new Set();
    return new Set(
      raw
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean),
    );
  }

  async setTenantUnitEnabled(
    user: AuthUser,
    symbol: string,
    enabled: boolean,
  ) {
    const sym = symbol.trim();
    if (!sym) throw new BadRequestException('symbol is required');
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');
    const root =
      tenant.settings && typeof tenant.settings === 'object'
        ? { ...(tenant.settings as Record<string, unknown>) }
        : {};
    const uomRoot =
      root.uom && typeof root.uom === 'object'
        ? { ...(root.uom as Record<string, unknown>) }
        : {};
    const disabled = new Set(this.disabledUnitSymbols(tenant.settings));
    const key = sym.toLowerCase();
    if (enabled) disabled.delete(key);
    else disabled.add(key);
    if (!enabled && key === 'pcs') {
      throw new BadRequestException('Piece (pcs) must stay enabled');
    }
    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: {
        settings: {
          ...root,
          uom: {
            ...uomRoot,
            disabledSymbols: [...disabled],
          },
        } as Prisma.InputJsonValue,
      },
    });
    return { symbol: sym, enabled };
  }

  async createCustomUnit(
    user: AuthUser,
    body: {
      symbol: string;
      name: string;
      unitGroupCode: string;
      conversionToGroupBase: number | string;
      isBaseUnit?: boolean;
    },
  ) {
    await this.ensureSystemUnits();
    const symbol = body.symbol.trim().slice(0, 16);
    const name = body.name.trim().slice(0, 50);
    if (!symbol || !name) {
      throw new BadRequestException('symbol and name are required');
    }
    const group = await this.prisma.unitGroup.findFirst({
      where: { code: body.unitGroupCode.trim().toUpperCase(), isActive: true },
    });
    if (!group) throw new NotFoundException('Unit category not found');
    let factor: Prisma.Decimal;
    try {
      factor = d(body.conversionToGroupBase);
    } catch {
      throw new BadRequestException('conversionToGroupBase must be > 0');
    }
    if (!factor.gt(0)) {
      throw new BadRequestException('conversionToGroupBase must be > 0');
    }
    const clash = await this.prisma.unit.findFirst({
      where: {
        unitGroupId: group.id,
        symbol: { equals: symbol, mode: 'insensitive' },
        OR: [{ tenantId: null }, { tenantId: user.tenantId }],
      },
    });
    if (clash) {
      throw new BadRequestException(`Unit "${symbol}" already exists`);
    }
    return this.prisma.unit.create({
      data: {
        unitGroupId: group.id,
        tenantId: user.tenantId,
        name,
        symbol,
        isBaseUnit: Boolean(body.isBaseUnit),
        conversionToGroupBase: factor,
      },
      include: { unitGroup: true },
    });
  }

  async updateCustomUnit(
    user: AuthUser,
    unitId: string,
    body: { name?: string; isActive?: boolean },
  ) {
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, tenantId: user.tenantId },
    });
    if (!unit) throw new NotFoundException('Custom unit not found');
    return this.prisma.unit.update({
      where: { id: unitId },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim().slice(0, 50) } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      include: { unitGroup: true },
    });
  }

  /** Resolve system/custom unit id from symbol — for safe new-product linking only. */
  async resolveUnitIdBySymbol(
    tenantId: string,
    symbol?: string | null,
  ): Promise<{ id: string; symbol: string } | null> {
    const sym = (symbol ?? '').trim();
    if (!sym) return null;
    await this.ensureSystemUnits();
    const unit = await this.prisma.unit.findFirst({
      where: {
        isActive: true,
        symbol: { equals: sym, mode: 'insensitive' },
        OR: [{ tenantId: null }, { tenantId }],
      },
      select: { id: true, symbol: true },
    });
    return unit;
  }

  async validateConversion(
    user: AuthUser,
    body: {
      fromUnitId: string;
      toUnitId: string;
      productId?: string;
      quantity?: number | string;
    },
  ) {
    const unitsById = await this.loadUnitsMap(user.tenantId);
    const fromUnit = unitsById.get(body.fromUnitId);
    const toUnit = unitsById.get(body.toUnitId);
    if (!fromUnit || !toUnit) {
      throw new NotFoundException('Unit not found');
    }
    let product: ProductPricingRef | undefined;
    if (body.productId) {
      const row = await this.prisma.product.findFirst({
        where: { id: body.productId, tenantId: user.tenantId },
        include: { productUnits: { where: { effectiveTo: null } } },
      });
      if (!row?.baseUnitId) {
        throw new BadRequestException(
          'Product has no base unit — configure Unit & Pricing on the item first',
        );
      }
      const edges = await this.loadConversionEdges(
        user.tenantId,
        row.id,
        unitsById,
      );
      product = this.toProductRef(row, edges);
    }
    const qty = body.quantity != null ? d(body.quantity) : d(1);
    try {
      const converted = convertQuantity({
        quantity: qty,
        fromUnit,
        toUnit,
        product,
        unitsById,
        extraEdges: product?.conversionEdges,
      });
      return {
        valid: true,
        fromUnitId: fromUnit.id,
        toUnitId: toUnit.id,
        enteredQty: qty.toFixed(),
        convertedQty: converted.toFixed(),
      };
    } catch (e) {
      if (e instanceof UnitPricingError) {
        return { valid: false, message: e.message, code: e.code };
      }
      throw e;
    }
  }

  /**
   * Purchase receive → inventory base qty.
   * Legacy-safe: returns input qty unchanged unless product.baseUnitId is set
   * AND an explicit isPurchaseUnit differs from base.
   */
  async convertPurchaseQtyToBase(
    tenantId: string,
    productId: string,
    qty: number | string,
  ): Promise<{ baseQty: Prisma.Decimal; usedConversion: boolean }> {
    const entered = d(qty);
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      include: {
        productUnits: {
          where: { effectiveTo: null },
          include: { unit: true },
        },
      },
    });
    if (!product?.baseUnitId) {
      return { baseQty: entered, usedConversion: false };
    }
    const purchasePu = product.productUnits.find((pu) => pu.isPurchaseUnit);
    if (!purchasePu || purchasePu.unitId === product.baseUnitId) {
      return { baseQty: entered, usedConversion: false };
    }
    const unitsById = await this.loadUnitsMap(tenantId);
    const fromUnit = unitsById.get(purchasePu.unitId);
    if (!fromUnit) {
      return { baseQty: entered, usedConversion: false };
    }
    const edges = await this.loadConversionEdges(tenantId, productId, unitsById);
    const ref = this.toProductRef(product, edges);
    try {
      const line = calculateLineAmount({
        product: ref,
        enteredQty: entered.abs(),
        sellingUnit: fromUnit,
        unitsById,
        extraEdges: edges,
        inventorySign: 1,
        validate: false,
      });
      return {
        baseQty: entered.isNeg() ? line.baseQuantity.neg() : line.baseQuantity,
        usedConversion: true,
      };
    } catch {
      return { baseQty: entered, usedConversion: false };
    }
  }

  /** Suggested units for tenant country (onboarding hint — never forces units). */
  async suggestForTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const code = countryCodeFromTenantSettings(tenant?.settings);
    return this.getCountryDefaults(code);
  }
}
