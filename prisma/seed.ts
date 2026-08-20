/**
 * Universal POS demo seed — multi business-type shops + users
 *
 * Login (all users):  WalitShop@2026
 * Portal/login email is each owner email below.
 *
 * Shops:
 *   retail-demo     — Blue T-shirt (brand/size/colour)
 *   grocery-demo    — 1L milk (pack size / expiry)
 *   salon-demo      — Haircut (duration minutes)
 *   restaurant-demo — Paneer dish (modifiers)
 *   rental-demo     — Formal rental catalog (units)
 *   pool-store      — The Pool Store (sale + service, Valdosta sample)
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  ensurePlatformCatalog,
  provisionTenantWithAdmin,
} from '../src/common/provision-tenant';
import {
  getBusinessConfig,
  registryToDbPayload,
} from '../src/common/business-config';
import {
  POOL_STORE_CATEGORIES,
  POOL_STORE_PRODUCTS,
  POOL_STORE_SHOP,
  poolProductFlags,
} from './pool-store-catalog';
import { saveProductImage } from '../src/common/product-image';
import { foodProductImageDataUrl } from './food-product-images';
import { poolProductImageDataUrl } from './pool-store-images';
import {
  FORMAL_CATEGORIES,
  FORMAL_PRODUCTS,
} from './formal-wear-catalog';

const prisma = new PrismaClient();
const ADMIN_PASSWORD = 'WalitShop@2026';
const BCRYPT_ROUNDS = 12;

const SALE_MODULES = [
  'core',
  'iam',
  'catalog',
  'inventory',
  'orders',
  'pos',
  'payments',
  'reports',
  'notify',
] as const;

const RENTAL_MODULES = [
  ...SALE_MODULES,
  'rental',
] as const;

const SALON_MODULES = [
  ...SALE_MODULES,
  'appointments',
] as const;

async function wipeAllBusinessData() {
  // Full reset — CASCADE avoids chasing every FK as modules grow.
  const rows = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename <> '_prisma_migrations'
     ORDER BY tablename`,
  );
  if (!rows.length) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}

async function addStaff(
  tenantId: string,
  locationId: string,
  passwordHash: string,
  rows: Array<{
    email: string;
    fullName: string;
    role: string;
    code: string;
  }>,
) {
  for (const s of rows) {
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: s.role } },
    });
    const u = await prisma.user.create({
      data: {
        tenantId,
        primaryLocationId: locationId,
        email: s.email,
        fullName: s.fullName,
        passwordHash,
        isActive: true,
        passwordChangedAt: new Date(),
      },
    });
    await prisma.employee.create({
      data: {
        tenantId,
        userId: u.id,
        employeeCode: s.code,
        status: 'active',
        hiredAt: new Date(),
        jobTitle: s.fullName,
      },
    });
    await prisma.userRole.create({
      data: { userId: u.id, roleId: role.id, locationId },
    });
    await prisma.membership.create({
      data: {
        tenantId,
        userId: u.id,
        locationId,
        roleId: role.id,
        status: 'active',
      },
    });
  }
}

/** Portal identity so email login → organizations works like signup */
async function linkIdentity(
  passwordHash: string,
  email: string,
  fullName: string,
  phone: string | undefined,
  tenantId: string,
  userId: string,
) {
  const identity = await prisma.identityAccount.upsert({
    where: { email: email.toLowerCase() },
    create: {
      email: email.toLowerCase(),
      passwordHash,
      fullName,
      phone: phone ?? null,
    },
    update: {
      passwordHash,
      fullName,
      phone: phone ?? null,
    },
  });
  await prisma.identityTenantMembership.upsert({
    where: {
      identityId_tenantId: {
        identityId: identity.id,
        tenantId,
      },
    },
    create: {
      identityId: identity.id,
      tenantId,
      userId,
    },
    update: { userId },
  });
  return identity;
}

async function applyBusinessType(
  tenantId: string,
  businessType: string,
  modes: string[],
) {
  const profile = getBusinessConfig(businessType);
  const payload = registryToDbPayload(profile);
  await prisma.businessConfig.upsert({
    where: { tenantId },
    create: {
      tenantId,
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

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const prev = (tenant.settings ?? {}) as Record<string, unknown>;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      settings: {
        ...prev,
        businessType: profile.id,
        businessConfigId: profile.id,
        businessConfigSetAt: new Date().toISOString(),
        commerceModes: modes,
        commerceSetupAt: new Date().toISOString(),
      } as Prisma.InputJsonValue,
    },
  });
}

type OpsProductSpec = {
  category: string;
  name: string;
  sku: string;
  price: number;
  qty: number;
  cost?: number;
  kind?: 'physical' | 'service';
  taxCode?: string;
  brand?: string;
  meta?: Record<string, unknown>;
};

/**
 * Realistic demo pack: more catalog rows, customers, suppliers, POs,
 * closed sales + GST invoices, expenses, coupons — so every main screen has data.
 */
async function seedOpsPack(opts: {
  tenantId: string;
  locationId: string;
  userId: string;
  currencyCode: string;
  taxId: string;
  /** 8-digit base so phones stay unique across shops */
  phoneBase: string;
  codePrefix: string;
  products: OpsProductSpec[];
  skipOrders?: boolean;
}) {
  const {
    tenantId,
    locationId,
    userId,
    currencyCode,
    taxId,
    phoneBase,
    codePrefix,
    products,
  } = opts;

  const tenantRow = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
  });
  const prevSettings =
    tenantRow.settings && typeof tenantRow.settings === 'object'
      ? { ...(tenantRow.settings as Record<string, unknown>) }
      : {};
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      taxId,
      settings: {
        ...prevSettings,
        organizationProfile: {
          addressLine1: '12 Market Road',
          city: 'Ahmedabad',
          state: 'Gujarat',
          phone: `+91${phoneBase}00`,
          email: `hello@${codePrefix.toLowerCase()}.demo`,
        },
      } as Prisma.InputJsonValue,
    },
  });

  const categoryIds = new Map<string, string>();
  const brandIds = new Map<string, string>();
  const stockRows: Array<{
    productId: string;
    stockLevelId: string;
    name: string;
    sku: string;
    price: number;
    taxCode: string | null;
  }> = [];

  for (const p of products) {
    if (!categoryIds.has(p.category)) {
      const existing = await prisma.category.findFirst({
        where: { tenantId, name: p.category },
      });
      if (existing) {
        categoryIds.set(p.category, existing.id);
      } else {
        const cat = await prisma.category.create({
          data: { tenantId, name: p.category },
        });
        categoryIds.set(p.category, cat.id);
      }
    }
    let brandId: string | undefined;
    if (p.brand) {
      if (!brandIds.has(p.brand)) {
        const brand = await prisma.brand.upsert({
          where: { tenantId_name: { tenantId, name: p.brand } },
          create: { tenantId, name: p.brand },
          update: {},
        });
        brandIds.set(p.brand, brand.id);
      }
      brandId = brandIds.get(p.brand);
    }

    const existingProduct = await prisma.product.findFirst({
      where: { tenantId, skuCode: p.sku },
    });
    if (existingProduct) {
      const level = await prisma.stockLevel.findFirst({
        where: { tenantId, productId: existingProduct.id, locationId },
      });
      if (level) {
        stockRows.push({
          productId: existingProduct.id,
          stockLevelId: level.id,
          name: existingProduct.name,
          sku: existingProduct.skuCode,
          price: Number(level.sellPrice),
          taxCode: existingProduct.taxCode,
        });
      }
      continue;
    }

    const kind = p.kind ?? 'physical';
    const trackQty = kind !== 'service';
    const product = await prisma.product.create({
      data: {
        tenantId,
        categoryId: categoryIds.get(p.category)!,
        brandId: brandId ?? null,
        name: p.name,
        skuCode: p.sku,
        taxCode: p.taxCode ?? '9983',
        kind,
        fulfillmentMode: kind === 'service' ? 'service' : 'sale',
        basePrice: p.price,
        costPrice: p.cost ?? Math.round(p.price * 0.55 * 100) / 100,
        trackQty,
        trackSerial: false,
        meta: {
          sellUnit: trackQty ? 'pcs' : 'job',
          itemType: kind === 'service' ? 'service' : 'goods',
          ...(p.meta ?? {}),
        },
      },
    });
    const level = await prisma.stockLevel.create({
      data: {
        tenantId,
        locationId,
        productId: product.id,
        sku: p.sku,
        sellUnit: trackQty ? 'pcs' : 'job',
        qtyOnHand: trackQty ? p.qty : 0,
        sellPrice: p.price,
      },
    });
    stockRows.push({
      productId: product.id,
      stockLevelId: level.id,
      name: product.name,
      sku: product.skuCode,
      price: p.price,
      taxCode: product.taxCode,
    });
  }

  // Also include any existing stock at this location (hero product from shop seed)
  const existingLevels = await prisma.stockLevel.findMany({
    where: { tenantId, locationId },
    include: { product: true },
  });
  for (const level of existingLevels) {
    if (stockRows.some((r) => r.stockLevelId === level.id)) continue;
    stockRows.push({
      productId: level.productId,
      stockLevelId: level.id,
      name: level.product.name,
      sku: level.product.skuCode,
      price: Number(level.sellPrice),
      taxCode: level.product.taxCode,
    });
  }

  const customers = await Promise.all(
    [
      { name: 'Walk-in Guest', phone: `${phoneBase}01`, email: null as string | null },
      {
        name: 'Priya Sharma',
        phone: `${phoneBase}02`,
        email: `priya@${codePrefix.toLowerCase()}.demo`,
      },
      {
        name: 'Amit Patel',
        phone: `${phoneBase}03`,
        email: `amit@${codePrefix.toLowerCase()}.demo`,
      },
      {
        name: 'Neha Verma',
        phone: `${phoneBase}04`,
        email: `neha@${codePrefix.toLowerCase()}.demo`,
      },
      {
        name: 'Rahul Mehta',
        phone: `${phoneBase}05`,
        email: `rahul@${codePrefix.toLowerCase()}.demo`,
      },
    ].map((c) =>
      prisma.customer.create({
        data: {
          tenantId,
          fullName: c.name,
          phone: c.phone,
          email: c.email,
          loyaltyPoints: c.name === 'Priya Sharma' ? 120 : 0,
          marketingOptIn: Boolean(c.email),
        },
      }),
    ),
  );

  const supplier = await prisma.supplier.create({
    data: {
      tenantId,
      code: `SUP-${codePrefix}-001`,
      name: `${codePrefix} Wholesale Hub`,
      legalName: `${codePrefix} Wholesale Hub Pvt Ltd`,
      supplierType: 'wholesaler',
      category: 'General merchandise',
      status: 'active',
      contact: 'Suresh Kumar',
      phone: `${phoneBase}88`,
      email: `supply@${codePrefix.toLowerCase()}.demo`,
      taxId: taxId,
      paymentTerm: 'net_30',
      dueDays: 30,
      creditLimit: 250000,
      currencyCode,
      notes: 'Preferred restock partner for demo',
    },
  });
  await prisma.supplierContact.create({
    data: {
      tenantId,
      supplierId: supplier.id,
      name: 'Suresh Kumar',
      email: `supply@${codePrefix.toLowerCase()}.demo`,
      phone: `${phoneBase}88`,
      role: 'Account manager',
      isPrimary: true,
    },
  });
  await prisma.supplierAddress.create({
    data: {
      tenantId,
      supplierId: supplier.id,
      kind: 'billing',
      line1: 'Warehouse 4, Ring Road',
      city: 'Ahmedabad',
      state: 'Gujarat',
      postalCode: '380015',
      country: 'IN',
      isDefault: true,
    },
  });
  await prisma.supplier.create({
    data: {
      tenantId,
      code: `SUP-${codePrefix}-002`,
      name: 'Local Services Co',
      supplierType: 'services',
      status: 'active',
      contact: 'Anjali Shah',
      phone: `${phoneBase}89`,
      email: `services@${codePrefix.toLowerCase()}.demo`,
      paymentTerm: 'immediate',
      currencyCode,
    },
  });

  if (stockRows.length) {
    const poLines = stockRows.slice(0, Math.min(3, stockRows.length));
    const po = await prisma.purchaseOrder.create({
      data: {
        tenantId,
        supplierId: supplier.id,
        poNumber: `PO-${codePrefix}-1001`,
        status: 'ordered',
        expectedDelivery: new Date(Date.now() + 5 * 86400000),
        notes: 'Seed purchase order — ready to receive',
        lines: {
          create: poLines.map((row) => ({
            tenantId,
            stockLevelId: row.stockLevelId,
            qtyOrdered: 20,
            unitCost: Math.round(row.price * 0.55 * 100) / 100,
          })),
        },
      },
    });
    void po;
  }

  await prisma.coupon.createMany({
    data: [
      {
        tenantId,
        code: `${codePrefix}10`,
        description: '10% off orders over ₹500',
        discountType: 'percent',
        discountValue: 10,
        minOrderAmount: 500,
        maxRedemptions: 200,
        isActive: true,
      },
      {
        tenantId,
        code: `${codePrefix}FLAT50`,
        description: 'Flat ₹50 off',
        discountType: 'fixed',
        discountValue: 50,
        minOrderAmount: 300,
        maxRedemptions: 100,
        isActive: true,
      },
    ],
  });

  const rent = await prisma.expenseCategory.create({
    data: { tenantId, name: 'Rent & utilities', sortOrder: 1 },
  });
  const supplies = await prisma.expenseCategory.create({
    data: { tenantId, name: 'Store supplies', sortOrder: 2 },
  });
  const marketing = await prisma.expenseCategory.create({
    data: { tenantId, name: 'Marketing', sortOrder: 3 },
  });
  const daysAgo = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  await prisma.expense.createMany({
    data: [
      {
        tenantId,
        locationId,
        categoryId: rent.id,
        expenseNumber: `EXP-${codePrefix}-001`,
        amount: 18000,
        spentAt: daysAgo(12),
        paymentMethod: 'bank_transfer',
        payee: 'Property Manager',
        status: 'approved',
        createdById: userId,
        approvedById: userId,
        approvedAt: new Date(),
        notes: 'Monthly shop rent',
      },
      {
        tenantId,
        locationId,
        categoryId: supplies.id,
        expenseNumber: `EXP-${codePrefix}-002`,
        amount: 2450,
        spentAt: daysAgo(4),
        paymentMethod: 'cash',
        payee: 'Stationery Mart',
        status: 'approved',
        createdById: userId,
        approvedById: userId,
        approvedAt: new Date(),
        notes: 'Bags, receipts, cleaning',
      },
      {
        tenantId,
        locationId,
        categoryId: marketing.id,
        expenseNumber: `EXP-${codePrefix}-003`,
        amount: 3200,
        spentAt: daysAgo(2),
        paymentMethod: 'upi',
        payee: 'Local Ads',
        status: 'pending',
        createdById: userId,
        notes: 'Weekend flyer campaign',
      },
    ],
  });

  if (opts.skipOrders || stockRows.length === 0) {
    return {
      productCount: stockRows.length,
      customerCount: customers.length,
      orderCount: 0,
    };
  }

  const sellable = stockRows.filter((r) => r.price > 0);
  const taxRate = 0.05; // 5% GST split CGST/SGST for demo

  async function createClosedSale(params: {
    orderNumber: string;
    invoiceNumber: string;
    customerId: string | null;
    lineIndexes: number[];
    qty?: number;
    method: 'cash' | 'upi' | 'card';
    daysAgo: number;
  }) {
    const lines = params.lineIndexes
      .map((i) => sellable[i % sellable.length])
      .filter(Boolean);
    if (!lines.length) return null;
    const qty = params.qty ?? 1;
    let subtotal = 0;
    const built = lines.map((row) => {
      const lineSub = row.price * qty;
      const tax = Math.round(lineSub * taxRate * 100) / 100;
      subtotal += lineSub;
      return { row, qty, lineSub, tax };
    });
    const taxTotal = built.reduce((s, l) => s + l.tax, 0);
    const grand = Math.round((subtotal + taxTotal) * 100) / 100;
    const cgst = Math.round((taxTotal / 2) * 100) / 100;
    const sgst = Math.round((taxTotal - cgst) * 100) / 100;
    const createdAt = daysAgo(params.daysAgo);

    const order = await prisma.order.create({
      data: {
        tenantId,
        locationId,
        customerId: params.customerId,
        orderNumber: params.orderNumber,
        kind: 'sale',
        status: 'closed',
        currencyCode,
        subtotal,
        taxTotal,
        discountTotal: 0,
        depositTotal: 0,
        balanceDue: 0,
        createdById: userId,
        createdAt,
        items: {
          create: built.map((l) => ({
            tenantId,
            itemKind: 'product' as const,
            productId: l.row.productId,
            stockLevelId: l.row.stockLevelId,
            description: l.row.name,
            quantity: l.qty,
            unitPrice: l.row.price,
            lineTotal: Math.round((l.lineSub + l.tax) * 100) / 100,
            taxAmount: l.tax,
          })),
        },
        payments: {
          create: {
            tenantId,
            locationId,
            type: 'payment',
            method: params.method,
            status: 'succeeded',
            amount: grand,
            currencyCode,
            idempotencyKey: `seed-${params.orderNumber}`,
            takenByUserId: userId,
            createdAt,
          },
        },
        invoices: {
          create: {
            tenantId,
            invoiceNumber: params.invoiceNumber,
            taxIdSnapshot: taxId,
            taxBreakdown: {
              cgst,
              sgst,
              igst: 0,
              placeOfSupply: 'Gujarat',
            },
            cgst,
            sgst,
            igst: 0,
            grandTotal: grand,
            createdAt,
          },
        },
      },
    });
    return order;
  }

  const orders = [
    await createClosedSale({
      orderNumber: `ORD-${codePrefix}-00001`,
      invoiceNumber: `INV-${codePrefix}-00001`,
      customerId: customers[1]?.id ?? null,
      lineIndexes: [0, 1],
      method: 'upi',
      daysAgo: 6,
    }),
    await createClosedSale({
      orderNumber: `ORD-${codePrefix}-00002`,
      invoiceNumber: `INV-${codePrefix}-00002`,
      customerId: customers[2]?.id ?? null,
      lineIndexes: [0],
      qty: 2,
      method: 'cash',
      daysAgo: 3,
    }),
    await createClosedSale({
      orderNumber: `ORD-${codePrefix}-00003`,
      invoiceNumber: `INV-${codePrefix}-00003`,
      customerId: customers[3]?.id ?? null,
      lineIndexes: [1, 2, 0],
      method: 'card',
      daysAgo: 1,
    }),
  ].filter(Boolean);

  return {
    productCount: stockRows.length,
    customerCount: customers.length,
    orderCount: orders.length,
  };
}

async function seedSaleShop(opts: {
  passwordHash: string;
  tenantName: string;
  slug: string;
  adminEmail: string;
  adminFullName: string;
  adminPhone: string;
  businessType: string;
  commerceModes: string[];
  modules: readonly string[];
  brandingTagline: string;
  category: string;
  product: {
    name: string;
    sku: string;
    price: number;
    qty: number;
    kind?: 'physical' | 'service';
    trackQty?: boolean;
    photoUrl?: string;
    meta: Record<string, unknown>;
  };
  staff: Array<{
    email: string;
    fullName: string;
    role: string;
    code: string;
  }>;
  ops?: {
    taxId: string;
    phoneBase: string;
    codePrefix: string;
    products: OpsProductSpec[];
  };
}) {
  const result = await prisma.$transaction(async (tx) =>
    provisionTenantWithAdmin(tx, {
      tenantName: opts.tenantName,
      slug: opts.slug,
      locationName: 'Main Store',
      adminEmail: opts.adminEmail,
      adminFullName: opts.adminFullName,
      adminPhone: opts.adminPhone,
      passwordHash: opts.passwordHash,
      currencyCode: 'INR',
      locale: 'en-IN',
      moduleCodes: [...opts.modules],
    }),
  );

  await prisma.tenant.update({
    where: { id: result.tenant.id },
    data: {
      branding: {
        productName: opts.tenantName,
        tagline: opts.brandingTagline,
      },
    },
  });

  await applyBusinessType(
    result.tenant.id,
    opts.businessType,
    opts.commerceModes,
  );

  const cat = await prisma.category.create({
    data: { tenantId: result.tenant.id, name: opts.category },
  });

  let cover = opts.product.photoUrl ?? null;
  if (cover?.startsWith('data:')) {
    cover = await saveProductImage(result.tenant.id, cover);
  }

  const product = await prisma.product.create({
    data: {
      tenantId: result.tenant.id,
      categoryId: cat.id,
      name: opts.product.name,
      skuCode: opts.product.sku,
      kind: opts.product.kind ?? 'physical',
      fulfillmentMode: 'sale',
      basePrice: opts.product.price,
      trackQty: opts.product.trackQty ?? true,
      trackSerial: false,
      photoUrl: cover,
      meta: {
        sellUnit: 'pcs',
        itemType: opts.product.kind === 'service' ? 'service' : 'goods',
        ...(cover ? { images: [cover] } : {}),
        ...opts.product.meta,
      },
    },
  });

  if (opts.product.trackQty !== false && opts.product.kind !== 'service') {
    await prisma.stockLevel.create({
      data: {
        tenantId: result.tenant.id,
        locationId: result.location.id,
        productId: product.id,
        sku: opts.product.sku,
        sellUnit: 'pcs',
        qtyOnHand: opts.product.qty,
        sellPrice: opts.product.price,
      },
    });
  } else {
    await prisma.stockLevel.create({
      data: {
        tenantId: result.tenant.id,
        locationId: result.location.id,
        productId: product.id,
        sku: opts.product.sku,
        sellUnit: 'pcs',
        qtyOnHand: 0,
        sellPrice: opts.product.price,
      },
    });
  }

  await addStaff(
    result.tenant.id,
    result.location.id,
    opts.passwordHash,
    opts.staff,
  );

  await linkIdentity(
    opts.passwordHash,
    opts.adminEmail,
    opts.adminFullName,
    opts.adminPhone,
    result.tenant.id,
    result.user.id,
  );

  for (const s of opts.staff) {
    const u = await prisma.user.findFirst({
      where: { tenantId: result.tenant.id, email: s.email },
    });
    if (u) {
      await linkIdentity(
        opts.passwordHash,
        s.email,
        s.fullName,
        undefined,
        result.tenant.id,
        u.id,
      );
    }
  }

  let opsSummary = { productCount: 1, customerCount: 0, orderCount: 0 };
  if (opts.ops) {
    opsSummary = await seedOpsPack({
      tenantId: result.tenant.id,
      locationId: result.location.id,
      userId: result.user.id,
      currencyCode: 'INR',
      taxId: opts.ops.taxId,
      phoneBase: opts.ops.phoneBase,
      codePrefix: opts.ops.codePrefix,
      products: opts.ops.products,
    });
  }

  return {
    ...result,
    productName: product.name,
    productSku: product.skuCode,
    ops: opsSummary,
  };
}

async function seedRentalDemo(passwordHash: string) {
  const result = await prisma.$transaction(async (tx) =>
    provisionTenantWithAdmin(tx, {
      tenantName: 'City Rental Demo',
      slug: 'rental-demo',
      taxId: '29RENTALDEMO1Z5',
      locationName: 'Rental Flagship',
      adminEmail: 'owner@rental.demo',
      adminFullName: 'Rental Owner',
      adminPhone: '9811122233',
      passwordHash,
      moduleCodes: [...RENTAL_MODULES],
    }),
  );

  await prisma.tenant.update({
    where: { id: result.tenant.id },
    data: {
      branding: {
        productName: 'City Rental',
        tagline: 'Formal wear & gear rental',
      },
    },
  });

  // rental shops still use a general-ish config + rental mode
  await applyBusinessType(result.tenant.id, 'general', ['rental', 'sale']);

  const categoryIds = new Map<string, string>();
  for (const name of FORMAL_CATEGORIES) {
    const cat = await prisma.category.create({
      data: { tenantId: result.tenant.id, name },
    });
    categoryIds.set(name, cat.id);
  }

  let unitCount = 0;
  for (const p of FORMAL_PRODUCTS.slice(0, 6)) {
    const product = await prisma.product.create({
      data: {
        tenantId: result.tenant.id,
        categoryId: categoryIds.get(p.category)!,
        name: p.name,
        skuCode: p.sku,
        kind: 'physical',
        fulfillmentMode: 'rental',
        basePrice: p.rentalPrice,
        trackQty: false,
        trackSerial: true,
        meta: {
          vertical: 'formal_rental',
          sellUnit: 'pcs',
          itemType: 'goods',
        },
      },
    });
    for (const u of p.units.slice(0, 2)) {
      await prisma.stockUnit.create({
        data: {
          tenantId: result.tenant.id,
          locationId: result.location.id,
          productId: product.id,
          barcodeSku: u.barcode,
          variantLabel: u.size,
          condition: 'good',
          status: 'available',
          ownership: 'own',
          depositAmount: u.deposit,
          meta: { rentalPrice: p.rentalPrice },
        },
      });
      unitCount += 1;
    }
  }

  await addStaff(result.tenant.id, result.location.id, passwordHash, [
    {
      email: 'manager@rental.demo',
      fullName: 'Rental Manager',
      role: 'manager',
      code: 'R002',
    },
    {
      email: 'cashier@rental.demo',
      fullName: 'Rental Cashier',
      role: 'cashier',
      code: 'R003',
    },
  ]);

  await linkIdentity(
    passwordHash,
    'owner@rental.demo',
    'Rental Owner',
    '9811122233',
    result.tenant.id,
    result.user.id,
  );

  const ops = await seedOpsPack({
    tenantId: result.tenant.id,
    locationId: result.location.id,
    userId: result.user.id,
    currencyCode: 'INR',
    taxId: '29RENTALDEMO1Z5',
    phoneBase: '98150000',
    codePrefix: 'RN',
    products: [
      {
        category: 'Retail add-ons',
        name: 'Garment Steamer Hire',
        sku: 'RN-STEAM-01',
        price: 199,
        qty: 10,
        taxCode: '9987',
      },
      {
        category: 'Retail add-ons',
        name: 'Shoe Shine Kit',
        sku: 'RN-SHINE-01',
        price: 149,
        qty: 25,
        taxCode: '3405',
      },
    ],
  });

  return { unitCount, tenant: result.tenant, ops };
}

async function seedPoolStoreLight(passwordHash: string) {
  const result = await prisma.$transaction(async (tx) =>
    provisionTenantWithAdmin(tx, {
      tenantName: 'The Pool Store',
      slug: 'pool-store',
      locationName: 'Valdosta Flagship',
      adminEmail: 'owner@pool.demo',
      adminFullName: 'Pool Store Owner',
      adminPhone: '9876500001',
      passwordHash,
      currencyCode: 'USD',
      locale: 'en-US',
      timezone: 'America/New_York',
      taxMode: 'simple',
      moduleCodes: [...SALE_MODULES],
    }),
  );

  await applyBusinessType(result.tenant.id, 'retail', ['sale', 'service']);

  const poolTenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: result.tenant.id },
  });
  await prisma.tenant.update({
    where: { id: result.tenant.id },
    data: {
      branding: {
        productName: POOL_STORE_SHOP.name,
        tagline: POOL_STORE_SHOP.tagline,
      },
      settings: {
        ...((poolTenant.settings ?? {}) as Record<string, unknown>),
        phone: POOL_STORE_SHOP.phone,
        city: POOL_STORE_SHOP.city,
        state: POOL_STORE_SHOP.state,
        country: POOL_STORE_SHOP.country,
        hours: POOL_STORE_SHOP.hours,
      },
    },
  });

  await prisma.location.update({
    where: { id: result.location.id },
    data: {
      address: POOL_STORE_SHOP.address,
      regionCode: POOL_STORE_SHOP.state,
    },
  });

  const categoryIds = new Map<string, string>();
  for (const name of POOL_STORE_CATEGORIES) {
    const cat = await prisma.category.create({
      data: { tenantId: result.tenant.id, name },
    });
    categoryIds.set(name, cat.id);
  }

  const products = POOL_STORE_PRODUCTS;
  for (const p of products) {
    const flags = poolProductFlags(p);
    const product = await prisma.product.create({
      data: {
        tenantId: result.tenant.id,
        categoryId: categoryIds.get(p.category)!,
        name: p.name,
        skuCode: p.sku,
        kind: flags.kind,
        fulfillmentMode: flags.fulfillmentMode,
        basePrice: p.price,
        trackQty: flags.trackQty,
        photoUrl: poolProductImageDataUrl(p.category, p.name),
        meta: {
          sellUnit: flags.trackQty ? 'pcs' : 'job',
          sourceNav: p.category,
        },
      },
    });
    if (flags.trackQty) {
      await prisma.stockLevel.create({
        data: {
          tenantId: result.tenant.id,
          locationId: result.location.id,
          productId: product.id,
          sku: p.sku,
          qtyOnHand: p.qty,
          sellPrice: p.price,
        },
      });
    }
  }

  await addStaff(result.tenant.id, result.location.id, passwordHash, [
    {
      email: 'cashier@pool.demo',
      fullName: 'Pool Cashier',
      role: 'cashier',
      code: 'E002',
    },
  ]);
  await linkIdentity(
    passwordHash,
    'owner@pool.demo',
    'Pool Store Owner',
    '9876500001',
    result.tenant.id,
    result.user.id,
  );

  const ops = await seedOpsPack({
    tenantId: result.tenant.id,
    locationId: result.location.id,
    userId: result.user.id,
    currencyCode: 'USD',
    taxId: 'US-POOL-TAX-01',
    phoneBase: '98765001',
    codePrefix: 'PL',
    products: [],
  });

  return { productCount: products.length, ops };
}

async function main() {
  console.log('Universal POS seed — multi business demos…');
  await wipeAllBusinessData();
  await ensurePlatformCatalog(prisma);
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);

  const retail = await seedSaleShop({
    passwordHash,
    tenantName: 'Urban Retail Demo',
    slug: 'retail-demo',
    adminEmail: 'owner@retail.demo',
    adminFullName: 'Retail Owner',
    adminPhone: '9800000001',
    businessType: 'retail',
    commerceModes: ['sale'],
    modules: SALE_MODULES,
    brandingTagline: 'Apparel · catalog + counter',
    category: 'Apparel',
    product: {
      name: 'Blue T-shirt',
      sku: 'RET-TSHIRT-BLU-M',
      price: 599,
      qty: 40,
      meta: {
        brand: 'UrbanWear',
        size: 'M',
        color: 'Blue',
        manufacturer: 'UrbanWear Co',
      },
    },
    staff: [
      {
        email: 'cashier@retail.demo',
        fullName: 'Retail Cashier',
        role: 'cashier',
        code: 'RT02',
      },
      {
        email: 'manager@retail.demo',
        fullName: 'Retail Manager',
        role: 'manager',
        code: 'RT03',
      },
    ],
    ops: {
      taxId: '24AABCU9603R1ZM',
      phoneBase: '98110000',
      codePrefix: 'RT',
      products: [
        {
          category: 'Apparel',
          name: 'Black Jeans 32',
          sku: 'RET-JEANS-BLK-32',
          price: 1299,
          qty: 25,
          taxCode: '6103',
          brand: 'UrbanWear',
        },
        {
          category: 'Apparel',
          name: 'Cotton Cap',
          sku: 'RET-CAP-NVY',
          price: 299,
          qty: 50,
          taxCode: '6505',
          brand: 'UrbanWear',
        },
        {
          category: 'Accessories',
          name: 'Leather Belt',
          sku: 'RET-BELT-BRN',
          price: 449,
          qty: 30,
          taxCode: '4203',
          brand: 'UrbanWear',
        },
        {
          category: 'Accessories',
          name: 'Canvas Tote',
          sku: 'RET-TOTE-01',
          price: 399,
          qty: 35,
          taxCode: '4202',
        },
        {
          category: 'Footwear',
          name: 'Sports Sneaker',
          sku: 'RET-SNKR-WHT',
          price: 1899,
          qty: 18,
          taxCode: '6404',
          brand: 'Stride',
        },
      ],
    },
  });

  const grocery = await seedSaleShop({
    passwordHash,
    tenantName: 'Fresh Grocery Demo',
    slug: 'grocery-demo',
    adminEmail: 'owner@grocery.demo',
    adminFullName: 'Grocery Owner',
    adminPhone: '9800000002',
    businessType: 'grocery',
    commerceModes: ['sale'],
    modules: SALE_MODULES,
    brandingTagline: 'Pack goods · stock-heavy selling',
    category: 'Dairy',
    product: {
      name: '1L Full Cream Milk',
      sku: 'GRC-MILK-1L',
      price: 62,
      qty: 120,
      meta: {
        packSize: '1 L',
        expiryTracked: true,
        sellUnit: 'pcs',
        perishable: true,
        brand: 'FarmFresh',
      },
    },
    staff: [
      {
        email: 'cashier@grocery.demo',
        fullName: 'Grocery Cashier',
        role: 'cashier',
        code: 'GR02',
      },
    ],
    ops: {
      taxId: '24AABCG9603R1ZN',
      phoneBase: '98120000',
      codePrefix: 'GR',
      products: [
        {
          category: 'Dairy',
          name: 'Curd 400g',
          sku: 'GRC-CURD-400',
          price: 35,
          qty: 80,
          taxCode: '0403',
          brand: 'FarmFresh',
        },
        {
          category: 'Bakery',
          name: 'Whole Wheat Bread',
          sku: 'GRC-BREAD-WW',
          price: 45,
          qty: 60,
          taxCode: '1905',
        },
        {
          category: 'Beverages',
          name: 'Mineral Water 1L',
          sku: 'GRC-WTR-1L',
          price: 20,
          qty: 200,
          taxCode: '2201',
        },
        {
          category: 'Snacks',
          name: 'Namkeen Mix 200g',
          sku: 'GRC-NMKN-200',
          price: 55,
          qty: 90,
          taxCode: '2106',
        },
        {
          category: 'Staples',
          name: 'Basmati Rice 1kg',
          sku: 'GRC-RICE-1K',
          price: 145,
          qty: 70,
          taxCode: '1006',
        },
      ],
    },
  });

  const salon = await seedSaleShop({
    passwordHash,
    tenantName: 'Luxe Salon Demo',
    slug: 'salon-demo',
    adminEmail: 'owner@salon.demo',
    adminFullName: 'Salon Owner',
    adminPhone: '9800000003',
    businessType: 'salon',
    commerceModes: ['service', 'sale'],
    modules: SALON_MODULES,
    brandingTagline: 'Services + appointments',
    category: 'Hair',
    product: {
      name: 'Haircut – Men',
      sku: 'SAL-CUT-MEN',
      price: 350,
      qty: 0,
      kind: 'service',
      trackQty: false,
      meta: {
        durationMinutes: 30,
        staffSkill: 'Stylist',
        itemType: 'service',
        returnable: false,
      },
    },
    staff: [
      {
        email: 'stylist@salon.demo',
        fullName: 'Lead Stylist',
        role: 'manager',
        code: 'SL02',
      },
      {
        email: 'cashier@salon.demo',
        fullName: 'Salon Cashier',
        role: 'cashier',
        code: 'SL03',
      },
    ],
    ops: {
      taxId: '24AABCS9603R1ZP',
      phoneBase: '98130000',
      codePrefix: 'SL',
      products: [
        {
          category: 'Hair',
          name: 'Haircut – Women',
          sku: 'SAL-CUT-WMN',
          price: 550,
          qty: 0,
          kind: 'service',
          taxCode: '9997',
        },
        {
          category: 'Hair',
          name: 'Hair Colour',
          sku: 'SAL-COLOR-01',
          price: 1200,
          qty: 0,
          kind: 'service',
          taxCode: '9997',
        },
        {
          category: 'Retail',
          name: 'Shampoo 250ml',
          sku: 'SAL-SHMP-250',
          price: 399,
          qty: 40,
          taxCode: '3305',
          brand: 'LuxeCare',
        },
        {
          category: 'Retail',
          name: 'Hair Serum',
          sku: 'SAL-SERUM-01',
          price: 649,
          qty: 25,
          taxCode: '3305',
          brand: 'LuxeCare',
        },
      ],
    },
  });

  const restaurant = await seedSaleShop({
    passwordHash,
    tenantName: 'Spice Table Demo',
    slug: 'restaurant-demo',
    adminEmail: 'owner@restaurant.demo',
    adminFullName: 'Restaurant Owner',
    adminPhone: '9800000004',
    businessType: 'restaurant',
    commerceModes: ['sale'],
    modules: SALE_MODULES,
    brandingTagline: 'Menu items · table meta on orders',
    category: 'Mains',
    product: {
      name: 'Paneer Butter Masala',
      sku: 'RST-PANEER-BM',
      price: 280,
      qty: 999,
      photoUrl: foodProductImageDataUrl('Mains', 'Paneer Butter Masala'),
      meta: {
        modifiers: ['Extra cheese', 'No onion', 'Extra gravy', 'Butter naan side'],
        sellUnit: 'pcs',
        brand: 'House special',
      },
    },
    staff: [
      {
        email: 'cashier@restaurant.demo',
        fullName: 'Floor Cashier',
        role: 'cashier',
        code: 'RS02',
      },
    ],
    ops: {
      taxId: '24AABCR9603R1ZQ',
      phoneBase: '98140000',
      codePrefix: 'RS',
      products: [
        {
          category: 'Mains',
          name: 'Dal Tadka',
          sku: 'RST-DAL-TDK',
          price: 180,
          qty: 999,
          taxCode: '9963',
        },
        {
          category: 'Breads',
          name: 'Butter Naan',
          sku: 'RST-NAAN-BTR',
          price: 50,
          qty: 999,
          taxCode: '9963',
        },
        {
          category: 'Breads',
          name: 'Garlic Naan',
          sku: 'RST-NAAN-GRL',
          price: 70,
          qty: 999,
          taxCode: '9963',
        },
        {
          category: 'Drinks',
          name: 'Masala Chaas',
          sku: 'RST-CHAAS-01',
          price: 60,
          qty: 999,
          taxCode: '9963',
        },
        {
          category: 'Desserts',
          name: 'Gulab Jamun (2pc)',
          sku: 'RST-GJAM-2',
          price: 90,
          qty: 999,
          taxCode: '9963',
        },
      ],
    },
  });

  const rental = await seedRentalDemo(passwordHash);
  const pool = await seedPoolStoreLight(passwordHash);

  console.log('');
  console.log('=== Seed complete — password for ALL: WalitShop@2026 ===');
  console.log('');
  console.log(
    `Retail     owner@retail.demo     items~${retail.ops.productCount} customers=${retail.ops.customerCount} orders=${retail.ops.orderCount}`,
  );
  console.log(
    `Grocery    owner@grocery.demo    items~${grocery.ops.productCount} customers=${grocery.ops.customerCount} orders=${grocery.ops.orderCount}`,
  );
  console.log(
    `Salon      owner@salon.demo      items~${salon.ops.productCount} customers=${salon.ops.customerCount} orders=${salon.ops.orderCount}`,
  );
  console.log(
    `Restaurant owner@restaurant.demo items~${restaurant.ops.productCount} customers=${restaurant.ops.customerCount} orders=${restaurant.ops.orderCount}`,
  );
  console.log('Rental     owner@rental.demo     units:', rental.unitCount, 'orders:', rental.ops.orderCount);
  console.log(
    'Pool       owner@pool.demo       SKUs:',
    pool.productCount,
    'customers:',
    pool.ops.customerCount,
    'orders:',
    pool.ops.orderCount,
  );
  console.log('');
  console.log('Also staff: cashier@*.demo / manager@retail.demo etc (same password)');
  console.log('Login at /login → pick organization if portal lists multiple.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
