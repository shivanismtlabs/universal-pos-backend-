import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleStatus, FulfillmentMode, Prisma } from '@prisma/client';
import {
  COMMERCE_SCHEMAS,
  RENTAL_LIFECYCLE_STATES,
  RENTAL_PRODUCT_FIELDS,
  SALE_PRODUCT_FIELDS,
  isCommerceMode,
  moduleStackForMode,
  parseCommerceModes,
  type CommerceMode,
} from '../../common/commerce-schema';
import {
  businessConfigCatalog,
  configFromDbRow,
  formSchemaFromConfig,
  getBusinessConfig,
  isBusinessTypeId,
  metaFieldsFor,
  registryToDbPayload,
  resolveBusinessConfig,
} from '../../common/business-config';
import { PLATFORM_MODULES } from '../../common/platform-catalog';
import { ensurePlatformCatalog } from '../../common/provision-tenant';
import { throwIfUnique } from '../../common/prisma/prisma-errors';
import { PrismaService } from '../../database/database.module';
import type { AuthUser } from '../auth/types';
import {
  CreateCatalogItemDto,
  SetBusinessConfigDto,
  SetCommerceModesDto,
  SetFeatureFlagDto,
} from './dto/apps.dto';

@Injectable()
export class AppsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Platform catalog (all installable apps) */
  async listCatalog() {
    await ensurePlatformCatalog(this.prisma);
    return this.prisma.module.findMany({
      orderBy: [{ isCore: 'desc' }, { code: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        description: true,
        dependsOn: true,
        permissions: true,
        isCore: true,
        navSchema: true,
      },
    });
  }

  async listTenantModules(user: AuthUser) {
    await ensurePlatformCatalog(this.prisma);
    const [catalog, installed] = await Promise.all([
      this.prisma.module.findMany({ orderBy: { code: 'asc' } }),
      this.prisma.tenantModule.findMany({
        where: { tenantId: user.tenantId },
        include: { module: true },
      }),
    ]);

    const byCode = new Map(
      installed.map((tm) => [tm.module.code, tm] as const),
    );

    return catalog.map((mod) => {
      const tm = byCode.get(mod.code);
      return {
        code: mod.code,
        name: mod.name,
        description: mod.description,
        dependsOn: mod.dependsOn,
        isCore: mod.isCore,
        navSchema: mod.navSchema,
        status: tm?.status ?? 'available',
        config: tm?.config ?? {},
        enabledAt: tm?.enabledAt ?? null,
      };
    });
  }

  async enable(user: AuthUser, code: string, config?: Record<string, unknown>) {
    await ensurePlatformCatalog(this.prisma);
    const mod = await this.prisma.module.findUnique({ where: { code } });
    if (!mod) throw new NotFoundException(`Module ${code} not found`);

    await this.assertPlanAllows(user.tenantId, code);

    const toEnable = await this.resolveDependencyClosure(code);
    const enabled: string[] = [];

    await this.prisma.$transaction(async (tx) => {
      for (const depCode of toEnable) {
        await this.assertPlanAllows(user.tenantId, depCode, tx);
        const dep = await tx.module.findUniqueOrThrow({
          where: { code: depCode },
        });
        await tx.tenantModule.upsert({
          where: {
            tenantId_moduleId: {
              tenantId: user.tenantId,
              moduleId: dep.id,
            },
          },
          create: {
            tenantId: user.tenantId,
            moduleId: dep.id,
            status: ModuleStatus.enabled,
            enabledAt: new Date(),
            config:
              depCode === code && config
                ? (config as Prisma.InputJsonValue)
                : {},
          },
          update: {
            status: ModuleStatus.enabled,
            enabledAt: new Date(),
            ...(depCode === code && config
              ? { config: config as Prisma.InputJsonValue }
              : {}),
          },
        });
        enabled.push(depCode);
      }

      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          actorUserId: user.userId,
          entityType: 'tenant_module',
          action: 'module.enabled',
          beforeAfter: { code, enabled },
        },
      });
    });

    return {
      enabled,
      modules: await this.listTenantModules(user),
    };
  }

  async disable(user: AuthUser, code: string) {
    const mod = await this.prisma.module.findUnique({ where: { code } });
    if (!mod) throw new NotFoundException(`Module ${code} not found`);
    if (mod.isCore) {
      throw new BadRequestException(`Core module ${code} cannot be disabled`);
    }

    const dependents = await this.findEnabledDependents(user.tenantId, code);
    if (dependents.length) {
      throw new BadRequestException(
        `Cannot disable ${code}; required by: ${dependents.join(', ')}`,
      );
    }

    const tm = await this.prisma.tenantModule.findUnique({
      where: {
        tenantId_moduleId: { tenantId: user.tenantId, moduleId: mod.id },
      },
    });
    if (!tm || tm.status !== ModuleStatus.enabled) {
      throw new BadRequestException(`Module ${code} is not enabled`);
    }

    await this.prisma.tenantModule.update({
      where: { id: tm.id },
      data: { status: ModuleStatus.disabled },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'tenant_module',
        action: 'module.disabled',
        beforeAfter: { code },
      },
    });

    return { disabled: code, modules: await this.listTenantModules(user) };
  }

  async listFeatureFlags(user: AuthUser) {
    return this.prisma.featureFlag.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { key: 'asc' },
    });
  }

  async setFeatureFlag(user: AuthUser, dto: SetFeatureFlagDto) {
    const key = dto.key.trim();
    const row = await this.prisma.featureFlag.upsert({
      where: {
        tenantId_key: { tenantId: user.tenantId, key },
      },
      create: {
        tenantId: user.tenantId,
        key,
        enabled: dto.enabled,
      },
      update: { enabled: dto.enabled },
    });

    await this.prisma.auditLog.create({
      data: {
        tenantId: user.tenantId,
        actorUserId: user.userId,
        entityType: 'feature_flag',
        entityId: row.id,
        action: 'feature_flag.set',
        beforeAfter: { key, enabled: dto.enabled },
      },
    });

    return row;
  }

  /**
   * Bootstrap for FE: tenant + orgs + locations + modules + flags + flattened nav
   */
  async bootstrap(user: AuthUser) {
    const [tenant, organizations, locations, modules, flags, planSub] =
      await Promise.all([
        this.prisma.tenant.findUniqueOrThrow({
          where: { id: user.tenantId },
          select: {
            id: true,
            name: true,
            slug: true,
            taxId: true,
            taxMode: true,
            currencyCode: true,
            locale: true,
            timezone: true,
            status: true,
            branding: true,
            settings: true,
          },
        }),
        this.prisma.organization.findMany({
          where: { tenantId: user.tenantId },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.location.findMany({
          where: { tenantId: user.tenantId },
          orderBy: { createdAt: 'asc' },
        }),
        this.listTenantModules(user),
        this.listFeatureFlags(user),
        this.prisma.tenantSubscription.findFirst({
          where: { tenantId: user.tenantId, status: 'active' },
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

    const limits = (planSub?.plan.limits ?? {}) as Record<string, unknown>;
    const features = (planSub?.plan.features ?? {}) as Record<string, unknown>;

    // Read-only: never sync/enable modules on bootstrap (that was the login lag).
    const commerceParsed = parseCommerceModes(tenant.settings);
    const commerceModes = commerceParsed.modes;
    const enabled = modules.filter((m) => m.status === 'enabled');
    const navAfter = enabled.flatMap((m) => {
      const schema = m.navSchema;
      if (!Array.isArray(schema)) return [];
      return schema.map((item) => {
        const row = item as Record<string, unknown>;
        return { ...row, module: m.code };
      });
    });

    // Lightweight mode catalog for onboarding UI (not full field schemas)
    const modeCatalog = Object.values(COMMERCE_SCHEMAS).map((s) => ({
      mode: s.mode,
      label: s.label,
      description: s.description,
    }));

    const businessConfig = await this.resolveTenantBusinessConfig(
      user.tenantId,
      tenant.settings,
    );

    return {
      tenant: { ...tenant, gstin: tenant.taxId },
      plan: planSub
        ? {
            code: planSub.plan.code,
            name: planSub.plan.name,
            limits,
            features,
            seatsUsed: planSub.seatsUsed,
            locationsUsed: planSub.locationsUsed,
          }
        : null,
      organizations,
      locations,
      modules,
      featureFlags: flags,
      nav: navAfter,
      capabilities: {
        offlinePos: flags.find((f) => f.key === 'offline_pos')?.enabled ?? false,
        whatsapp: flags.find((f) => f.key === 'whatsapp')?.enabled ?? false,
        loyalty: flags.find((f) => f.key === 'loyalty')?.enabled ?? false,
      },
      commerce: {
        setupComplete: commerceParsed.setupComplete,
        modes: commerceModes,
        registeredModes: Object.keys(COMMERCE_SCHEMAS),
        modeCatalog,
        rentalLifecycle: [...RENTAL_LIFECYCLE_STATES],
      },
      /**
       * Vertical profile — drives meta fields / billing style / screens.
       * New vertical = registry entry only (see business-config.ts).
       */
      business: {
        type: businessConfig.id,
        config: businessConfig,
        formSchema: formSchemaFromConfig(businessConfig),
        catalog: businessConfigCatalog(),
        coreEntities: [
          'item',
          'order',
          'payment',
          'customer',
          'inventory',
        ] as const,
        itemMetaFields: metaFieldsFor(businessConfig, 'item'),
        orderMetaFields: metaFieldsFor(businessConfig, 'order'),
        customerMetaFields: metaFieldsFor(businessConfig, 'customer'),
        /**
         * ERD map (Universal POS tables):
         * BUSINESS = tenants · BUSINESS_CONFIG = business_configs
         * ITEM = products · ORDERS = orders · ITEM/ORDER extra_fields = *.meta
         */
        erd: {
          business: 'tenants',
          businessConfig: 'business_configs',
          item: 'products',
          itemExtraFields: 'products.meta',
          order: 'orders',
          orderExtraFields: 'orders.meta',
          orderItem: 'order_items',
          payment: 'payments',
          customer: 'customers',
        },
      },
    };
  }

  /** DB row first (per-tenant JSON), else registry from settings.businessType */
  private async resolveTenantBusinessConfig(
    tenantId: string,
    settings: unknown,
  ) {
    try {
      const row = await this.prisma.businessConfig.findUnique({
        where: { tenantId },
      });
      if (row) {
        return configFromDbRow({
          businessType: row.businessType,
          itemFields: row.itemFields,
          orderFields: row.orderFields,
          uiFlow: row.uiFlow,
          billing: row.billing,
        });
      }
    } catch {
      // Table missing pre-migrate — fall back to in-code registry
    }
    return resolveBusinessConfig(settings);
  }

  listBusinessConfigs() {
    return {
      catalog: businessConfigCatalog(),
      configs: Object.fromEntries(
        businessConfigCatalog().map((c) => [
          c.id,
          getBusinessConfig(c.id),
        ]),
      ),
      coreEntities: ['item', 'order', 'payment', 'customer', 'inventory'],
      erd: {
        business: 'tenants',
        businessConfig: 'business_configs',
        itemExtraFields: 'products.meta',
        orderExtraFields: 'orders.meta',
      },
      note: 'Add a new business type only in BUSINESS_CONFIG_REGISTRY (+ optional business_configs row) — no core forks',
    };
  }

  /**
   * Setup: pick vertical profile. Optionally apply default commerce modes.
   * Upserts business_configs (ERD BUSINESS_CONFIG) with item/order field JSON.
   */
  async setBusinessConfig(user: AuthUser, dto: SetBusinessConfigDto) {
    if (!isBusinessTypeId(dto.businessType)) {
      throw new BadRequestException(
        'Unknown business type. Use GET /commerce/business-configs for catalog.',
      );
    }
    const profile = getBusinessConfig(dto.businessType);
    const payload = registryToDbPayload(profile);
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: user.tenantId },
    });
    const prev = (tenant.settings ?? {}) as Record<string, unknown>;
    const applyModes = dto.applyDefaultModes !== false;
    let modes = parseCommerceModes(prev).modes;

    if (applyModes || !modes.length) {
      modes = profile.defaultCommerceModes.filter(isCommerceMode);
      if (!modes.length) modes = ['sale'];
    }

    const settings = {
      ...prev,
      businessType: profile.id,
      businessConfigId: profile.id,
      commerceModes: modes,
      commerceSetupAt: new Date().toISOString(),
      businessConfigSetAt: new Date().toISOString(),
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id: user.tenantId },
        data: { settings: settings as Prisma.InputJsonValue },
      });
      await tx.businessConfig.upsert({
        where: { tenantId: user.tenantId },
        create: {
          tenantId: user.tenantId,
          businessType: payload.businessType,
          itemFields: payload.itemFields as Prisma.InputJsonValue,
          orderFields: payload.orderFields as Prisma.InputJsonValue,
          uiFlow: payload.uiFlow as Prisma.InputJsonValue,
          billing: payload.billing as Prisma.InputJsonValue,
        },
        update: {
          businessType: payload.businessType,
          itemFields: payload.itemFields as Prisma.InputJsonValue,
          orderFields: payload.orderFields as Prisma.InputJsonValue,
          uiFlow: payload.uiFlow as Prisma.InputJsonValue,
          billing: payload.billing as Prisma.InputJsonValue,
        },
      });
    });

    for (const mode of modes) {
      await this.syncCommerceModules(user, mode);
    }

    const resolved = await this.resolveTenantBusinessConfig(
      user.tenantId,
      settings,
    );
    return {
      businessType: resolved.id,
      config: resolved,
      formSchema: formSchemaFromConfig(resolved),
      commerceModes: modes,
      modules: await this.listTenantModules(user),
    };
  }

  /** Dynamic form schema for config-driven UI (no hardcoded vertical forms) */
  async businessFormSchema(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    const config = await this.resolveTenantBusinessConfig(
      user.tenantId,
      tenant.settings,
    );
    return formSchemaFromConfig(config);
  }

  commerceSchema() {
    return {
      registeredModes: Object.keys(COMMERCE_SCHEMAS),
      schemas: COMMERCE_SCHEMAS,
      rentalLifecycle: [...RENTAL_LIFECYCLE_STATES],
    };
  }

  /**
   * Onboarding / settings: persist enabled commerce modes from the registry.
   */
  async setCommerceModes(user: AuthUser, dto: SetCommerceModesDto) {
    const selected = (
      dto.modes?.length ? dto.modes : dto.mode ? [dto.mode] : []
    ).filter(isCommerceMode);
    if (!selected.length) {
      throw new BadRequestException(
        'Select at least one commerce mode (sale, rental, service, subscription, …)',
      );
    }
    const modes = [...new Set(selected)];

    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: user.tenantId },
    });
    const branding = (tenant.branding ?? {}) as Record<string, unknown>;
    const prev = (tenant.settings ?? {}) as Record<string, unknown>;
    const brandingUpdate =
      dto.shopTitle || dto.tagline
        ? {
            ...branding,
            ...(dto.shopTitle
              ? { productName: dto.shopTitle.trim() }
              : {}),
            ...(dto.tagline !== undefined
              ? {
                  tagline: dto.tagline.trim() || 'Universal POS',
                }
              : {}),
          }
        : undefined;

    const settings = {
      ...prev,
      commerceModes: modes,
      commerceSetupAt: new Date().toISOString(),
    };

    await this.prisma.tenant.update({
      where: { id: user.tenantId },
      data: {
        settings: settings as Prisma.InputJsonValue,
        ...(brandingUpdate
          ? { branding: brandingUpdate as Prisma.InputJsonValue }
          : {}),
        ...(dto.shopTitle ? { name: dto.shopTitle.trim() } : {}),
      },
    });

    for (const mode of modes) {
      await this.syncCommerceModules(user, mode);
    }

    return {
      setupComplete: true,
      modes,
      primary: modes[0],
      schemas: Object.fromEntries(
        modes.map((m) => [m, COMMERCE_SCHEMAS[m]]),
      ),
      registeredModes: Object.keys(COMMERCE_SCHEMAS),
      rentalLifecycle: [...RENTAL_LIFECYCLE_STATES],
      modules: await this.listTenantModules(user),
    };
  }

  /**
   * Admin adds product with universal catalog keys (any business).
   */
  async createCatalogItem(user: AuthUser, dto: CreateCatalogItemDto) {
    const parsed = parseCommerceModes(
      (
        await this.prisma.tenant.findUniqueOrThrow({
          where: { id: user.tenantId },
          select: { settings: true },
        })
      ).settings,
    );
    if (!parsed.setupComplete || !parsed.modes.length) {
      throw new BadRequestException(
        'Shop commerce is not ready — reload and try again',
      );
    }
    if (!parsed.modes.includes(dto.mode)) {
      throw new BadRequestException(
        `This shop does not allow ${dto.mode} catalog items`,
      );
    }

    await this.assertCategory(user.tenantId, dto.categoryId);

    let locationId = dto.locationId;
    if (!locationId) {
      const loc = await this.prisma.location.findFirst({
        where: { tenantId: user.tenantId, isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!loc) throw new BadRequestException('No location configured');
      locationId = loc.id;
    } else {
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, tenantId: user.tenantId, isActive: true },
      });
      if (!loc) throw new NotFoundException('Location not found');
    }

    if (dto.mode === 'sale') {
      if (dto.price === undefined || dto.qty === undefined) {
        throw new BadRequestException('Sale requires price and qty');
      }
      try {
        const product = await this.prisma.product.create({
          data: {
            tenantId: user.tenantId,
            categoryId: dto.categoryId,
            name: dto.title.trim(),
            skuCode: dto.sku.trim().toUpperCase(),
            description: dto.description?.trim(),
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
          mode: 'sale',
          product: {
            id: product.id,
            title: product.name,
            sku: product.skuCode,
            description: product.description,
          },
          stockLevel: {
            id: level.id,
            qtyOnHand: Number(level.qtyOnHand),
            sellPrice: level.sellPrice,
          },
        };
      } catch (error) {
        throwIfUnique(error, 'SKU already exists for this shop');
      }
    }

    if (dto.mode === 'rental') {
      if (dto.rentalPrice === undefined || !dto.barcode?.trim()) {
        throw new BadRequestException('Rental requires rentalPrice and barcode');
      }
      try {
        const product = await this.prisma.product.create({
          data: {
            tenantId: user.tenantId,
            categoryId: dto.categoryId,
            name: dto.title.trim(),
            skuCode: dto.sku.trim().toUpperCase(),
            description: dto.description?.trim(),
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
            variantLabel: (dto.variant ?? dto.size)?.trim() || null,
            condition: 'good',
            status: 'available',
            ownership: 'own',
            depositAmount: Number(dto.deposit ?? 0).toFixed(2),
            meta: { rentalPrice: Number(dto.rentalPrice) },
          },
        });
        return {
          mode: 'rental',
          product: {
            id: product.id,
            title: product.name,
            sku: product.skuCode,
            description: product.description,
          },
          stockUnit: {
            id: unit.id,
            barcodeSku: unit.barcodeSku,
            size: unit.variantLabel,
            status: unit.status,
          },
        };
      } catch (error) {
        throwIfUnique(error, 'SKU or barcode already exists for this shop');
      }
    }

    // service | subscription — catalog row only (checkout handlers land in CommerceEngine)
    if (dto.mode === 'service' || dto.mode === 'subscription') {
      if (dto.price === undefined) {
        throw new BadRequestException(`${dto.mode} requires price`);
      }
      const fulfillmentMode =
        dto.mode === 'service'
          ? FulfillmentMode.service
          : FulfillmentMode.subscription;
      const meta: Record<string, unknown> = {};
      if (dto.mode === 'service' && dto.durationMinutes != null) {
        meta.durationMinutes = Number(dto.durationMinutes);
      }
      if (dto.mode === 'subscription' && dto.billingPeriod != null) {
        meta.billingPeriodDays = Number(dto.billingPeriod);
      }
      try {
        const product = await this.prisma.product.create({
          data: {
            tenantId: user.tenantId,
            categoryId: dto.categoryId,
            name: dto.title.trim(),
            skuCode: dto.sku.trim().toUpperCase(),
            description: dto.description?.trim(),
            kind: dto.mode === 'service' ? 'service' : 'digital',
            fulfillmentMode,
            trackQty: false,
            trackSerial: false,
            basePrice: Number(dto.price),
            meta: Object.keys(meta).length
              ? (meta as Prisma.InputJsonValue)
              : undefined,
          },
        });
        return {
          mode: dto.mode,
          product: {
            id: product.id,
            title: product.name,
            sku: product.skuCode,
            description: product.description,
            fulfillmentMode: product.fulfillmentMode,
          },
        };
      } catch (error) {
        throwIfUnique(error, 'SKU already exists for this shop');
      }
    }

    throw new BadRequestException(
      `No catalog create handler registered for mode "${dto.mode}"`,
    );
  }

  /** Dashboard floor: catalog + (rental) orders/returns/fit field keys */
  async dashboardCatalog(user: AuthUser) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: user.tenantId },
      select: { settings: true },
    });
    const parsed = parseCommerceModes(tenant.settings);
    const modes = parsed.modes;
    const isRental = modes.includes('rental');

    const [categories, products, stockLevels, stockUnits, openOrders] =
      await Promise.all([
        this.prisma.category.findMany({
          where: { tenantId: user.tenantId },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        this.prisma.product.findMany({
          where: { tenantId: user.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            name: true,
            skuCode: true,
            description: true,
            fulfillmentMode: true,
            basePrice: true,
            category: { select: { id: true, name: true } },
            _count: { select: { stockLevels: true, stockUnits: true } },
          },
        }),
        this.prisma.stockLevel.count({ where: { tenantId: user.tenantId } }),
        this.prisma.stockUnit.count({ where: { tenantId: user.tenantId } }),
        this.prisma.order.findMany({
          where: {
            tenantId: user.tenantId,
            status: { notIn: ['closed', 'cancelled'] },
          },
          orderBy: { createdAt: 'desc' },
          take: 40,
          select: {
            id: true,
            orderNumber: true,
            status: true,
            kind: true,
            balanceDue: true,
            customer: {
              select: { id: true, fullName: true, phone: true },
            },
            rentalExt: {
              select: {
                lifecycle: true,
                pickupDate: true,
                returnDueDate: true,
              },
            },
          },
        }),
      ]);

    const recentReturns = isRental
      ? await this.prisma.returnEvent.findMany({
          where: { tenantId: user.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            notes: true,
            createdAt: true,
            order: { select: { id: true, orderNumber: true } },
            stockUnit: {
              select: { id: true, barcodeSku: true, variantLabel: true },
            },
          },
        })
      : [];

    return {
      setupComplete: parsed.setupComplete,
      modes,
      primary: modes[0] ?? null,
      fields: {
        sale: SALE_PRODUCT_FIELDS,
        rental: RENTAL_PRODUCT_FIELDS,
        /** Generic fit keys — any sized rental, not clothes-only */
        fitMeasurements: [
          { key: 'heightCm', label: 'Height' },
          { key: 'chest', label: 'Chest' },
          { key: 'waist', label: 'Waist' },
          { key: 'inseam', label: 'Inseam' },
          { key: 'sleeve', label: 'Sleeve' },
          { key: 'shoeSize', label: 'Shoe / size' },
        ],
      },
      rentalLifecycle: isRental ? [...RENTAL_LIFECYCLE_STATES] : [],
      counts: {
        categories: categories.length,
        products: products.length,
        saleStockRows: stockLevels,
        rentalUnits: stockUnits,
        openOrders: openOrders.length,
      },
      categories,
      products: products.map((p) => ({
        id: p.id,
        title: p.name,
        description: p.description,
        sku: p.skuCode,
        mode: p.fulfillmentMode,
        price: p.basePrice,
        category: p.category,
        stockLevels: p._count.stockLevels,
        stockUnits: p._count.stockUnits,
      })),
      openOrders: openOrders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        kind: o.kind,
        balanceDue: o.balanceDue,
        customer: o.customer,
        lifecycle: o.rentalExt?.lifecycle ?? null,
        pickupDate: o.rentalExt?.pickupDate ?? null,
        returnDueDate: o.rentalExt?.returnDueDate ?? null,
      })),
      recentReturns: recentReturns.map((r) => ({
        id: r.id,
        notes: r.notes,
        createdAt: r.createdAt,
        orderNumber: r.order?.orderNumber ?? null,
        barcodeSku: r.stockUnit?.barcodeSku ?? null,
        size: r.stockUnit?.variantLabel ?? null,
      })),
    };
  }

  private async assertCategory(tenantId: string, id: string) {
    const row = await this.prisma.category.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Category not found');
  }

  /**
   * Enable module pack for a registered commerce mode — batched, skips already-on.
   * Called from setCommerceModes only (never from bootstrap).
   */
  private async syncCommerceModules(user: AuthUser, mode: CommerceMode) {
    if (!isCommerceMode(mode)) return;
    const stack = moduleStackForMode(mode);
    const installed = await this.prisma.tenantModule.findMany({
      where: { tenantId: user.tenantId, status: ModuleStatus.enabled },
      select: { module: { select: { code: true } } },
    });
    const enabled = new Set(installed.map((t) => t.module.code));
    const missing = stack.filter((code) => !enabled.has(code));
    if (!missing.length) return;

    // One enable() per missing root is enough — each resolves dependsOn.
    // Prefer enabling deepest-needed codes; enabling each missing is OK and rare.
    for (const code of missing) {
      try {
        await this.enable(user, code);
      } catch {
        /* plan limits / race */
      }
    }
  }

  /** Resolve module + transitive dependsOn (depth-first, de-duped) */
  private async resolveDependencyClosure(code: string): Promise<string[]> {
    const catalog = await this.prisma.module.findMany();
    const byCode = new Map(catalog.map((m) => [m.code, m]));
    if (!byCode.has(code)) {
      // fallback to static catalog if DB row missing mid-seed
      const staticMod = PLATFORM_MODULES.find((m) => m.code === code);
      if (!staticMod) throw new NotFoundException(`Module ${code} not found`);
    }

    const ordered: string[] = [];
    const visiting = new Set<string>();

    const visit = (c: string) => {
      if (ordered.includes(c)) return;
      if (visiting.has(c)) {
        throw new BadRequestException(`Circular module dependency at ${c}`);
      }
      visiting.add(c);
      const mod = byCode.get(c);
      const deps = mod?.dependsOn ?? [];
      for (const d of deps) visit(d);
      visiting.delete(c);
      ordered.push(c);
    };

    visit(code);
    return ordered;
  }

  private async findEnabledDependents(tenantId: string, code: string) {
    const enabled = await this.prisma.tenantModule.findMany({
      where: { tenantId, status: ModuleStatus.enabled },
      include: { module: true },
    });
    return enabled
      .filter((tm) => tm.module.dependsOn.includes(code))
      .map((tm) => tm.module.code);
  }

  private async assertPlanAllows(
    tenantId: string,
    moduleCode: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    const sub = await db.tenantSubscription.findFirst({
      where: { tenantId, status: 'active' },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) return;

    const features = (sub.plan.features ?? {}) as {
      modules?: string[];
    };
    const allowed = features.modules;
    if (!allowed?.length) return;

    if (!allowed.includes(moduleCode)) {
      throw new ForbiddenException(
        `Plan ${sub.plan.code} does not allow module ${moduleCode}`,
      );
    }
  }
}
