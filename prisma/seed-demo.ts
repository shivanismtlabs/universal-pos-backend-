/**
 * Universal POS — Multi-Vertical Demo Seed (ADDITIVE / IDEMPOTENT)
 *
 * CRITICAL RULES:
 *  - NEVER wipes any table. Safe to run multiple times.
 *  - Uses slug/email/SKU upserts so reruns are no-ops.
 *  - 100% config-driven: all vertical behavior comes from business-config.ts.
 *  - Every record carries the correct tenantId + locationId + businessId.
 *
 * Creates:
 *   gym-demo       Gym & Fitness Center   (service + subscription)
 *   grocery-demo   Grocery Store          (sale)
 *   rental-demo    Rental Business        (rental)
 *   swimming-demo  Swimming Academy       (service + subscription)
 *   salon-demo     Salon                  (service + sale)
 *
 * Password for ALL users: WalitShop@2026
 *
 * Usage:
 *   cd backend
 *   npx ts-node -r tsconfig-paths/register prisma/seed-demo.ts
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
  GYM_PRODUCTS,
  GYM_CUSTOMERS,
  GYM_STAFF,
  GYM_SUPPLIERS,
  GYM_CATEGORIES,
} from './catalogs/gym';

import {
  GROCERY_PRODUCTS,
  GROCERY_CUSTOMERS,
  GROCERY_STAFF,
  GROCERY_SUPPLIERS,
  GROCERY_CATEGORIES,
} from './catalogs/grocery';

import {
  RENTAL_PRODUCTS,
  RENTAL_CUSTOMERS,
  RENTAL_STAFF,
  RENTAL_SUPPLIERS,
  RENTAL_CATEGORIES,
} from './catalogs/rental';

import {
  SWIMMING_PRODUCTS,
  SWIMMING_CUSTOMERS,
  SWIMMING_STAFF,
  SWIMMING_SUPPLIERS,
  SWIMMING_CATEGORIES,
} from './catalogs/swimming';

import {
  SALON_PRODUCTS,
  SALON_CUSTOMERS,
  SALON_STAFF,
  SALON_SUPPLIERS,
  SALON_CATEGORIES,
} from './catalogs/salon';

// ─── Shared ───────────────────────────────────────────────────────────────────
const prisma = new PrismaClient();
const ADMIN_PASSWORD = 'WalitShop@2026';
const BCRYPT_ROUNDS = 12;
const CURRENCY = 'INR';

const SALE_MODULES = [
  'core', 'iam', 'catalog', 'inventory', 'orders', 'pos', 'payments', 'reports', 'notify',
] as const;

const RENTAL_MODULES = [...SALE_MODULES, 'rental'] as const;
const SALON_MODULES = [...SALE_MODULES, 'appointments'] as const;
const GYM_MODULES = [...SALE_MODULES, 'appointments', 'subscriptions'] as const;
const SWIMMING_MODULES = [...SALE_MODULES, 'appointments', 'subscriptions'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
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
    create: { email: email.toLowerCase(), passwordHash, fullName, phone: phone ?? null },
    update: { passwordHash, fullName, phone: phone ?? null },
  });
  await prisma.identityTenantMembership.upsert({
    where: { identityId_tenantId: { identityId: identity.id, tenantId } },
    create: { identityId: identity.id, tenantId, userId },
    update: { userId },
  });
  return identity;
}

async function addStaffMembers(
  tenantId: string,
  locationId: string,
  passwordHash: string,
  rows: Array<{ email: string; fullName: string; role: string; code: string }>,
) {
  for (const s of rows) {
    const existing = await prisma.user.findFirst({ where: { tenantId, email: s.email } });
    if (existing) {
      await linkIdentity(passwordHash, s.email, s.fullName, undefined, tenantId, existing.id);
      continue;
    }
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
        tenantId, userId: u.id, employeeCode: s.code,
        status: 'active', hiredAt: new Date(), jobTitle: s.fullName,
      },
    });
    await prisma.userRole.create({ data: { userId: u.id, roleId: role.id, locationId } });
    await prisma.membership.create({
      data: { tenantId, userId: u.id, locationId, roleId: role.id, status: 'active' },
    });
    await linkIdentity(passwordHash, s.email, s.fullName, undefined, tenantId, u.id);
  }
}

async function ensureExpenseCategories(tenantId: string, locationId: string, userId: string) {
  const cats = ['Rent & utilities', 'Staff costs', 'Store supplies', 'Marketing'];
  const catIds: Record<string, string> = {};
  for (let i = 0; i < cats.length; i++) {
    const name = cats[i];
    const existing = await prisma.expenseCategory.findFirst({ where: { tenantId, name } });
    const row = existing ?? await prisma.expenseCategory.create({
      data: { tenantId, name, sortOrder: i + 1 },
    });
    catIds[name] = row.id;
  }
  const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  const expNums = await prisma.expense.findMany({ where: { tenantId }, select: { expenseNumber: true } });
  const existingNums = new Set(expNums.map(e => e.expenseNumber));
  const expenses = [
    { num: `EXP-DEMO-001-${tenantId.slice(0,6)}`, cat: 'Rent & utilities', amount: 25000, daysAgo: 10, method: 'bank_transfer', payee: 'Building Owner', notes: 'Monthly rent' },
    { num: `EXP-DEMO-002-${tenantId.slice(0,6)}`, cat: 'Store supplies', amount: 3500, daysAgo: 5, method: 'cash', payee: 'Local Mart', notes: 'Bags and cleaning' },
    { num: `EXP-DEMO-003-${tenantId.slice(0,6)}`, cat: 'Marketing', amount: 5000, daysAgo: 2, method: 'upi', payee: 'Digital Agency', notes: 'Social media ads' },
    { num: `EXP-DEMO-004-${tenantId.slice(0,6)}`, cat: 'Staff costs', amount: 8000, daysAgo: 1, method: 'bank_transfer', payee: 'Staff Payroll', notes: 'Part-time staff October' },
  ];
  for (const e of expenses) {
    if (existingNums.has(e.num)) continue;
    await prisma.expense.create({
      data: {
        tenantId, locationId,
        categoryId: catIds[e.cat],
        expenseNumber: e.num,
        amount: e.amount,
        spentAt: daysAgo(e.daysAgo),
        paymentMethod: e.method as any,
        payee: e.payee,
        status: 'approved',
        createdById: userId,
        approvedById: userId,
        approvedAt: new Date(),
        notes: e.notes,
      },
    });
  }
}

async function ensureCoupons(tenantId: string, prefix: string) {
  const codes = [`${prefix}10`, `${prefix}FLAT100`];
  const existing = await prisma.coupon.findMany({ where: { tenantId, code: { in: codes } }, select: { code: true } });
  const existingSet = new Set(existing.map(c => c.code));
  const toCreate = [
    { code: `${prefix}10`, description: '10% off orders over ₹500', discountType: 'percent', discountValue: 10, minOrderAmount: 500, maxRedemptions: 200 },
    { code: `${prefix}FLAT100`, description: 'Flat ₹100 off', discountType: 'fixed', discountValue: 100, minOrderAmount: 400, maxRedemptions: 100 },
  ].filter(c => !existingSet.has(c.code));
  if (toCreate.length) {
    await prisma.coupon.createMany({
      data: toCreate.map(c => ({ tenantId, ...c, isActive: true })),
    });
  }
}

async function seedCategories(tenantId: string, categoryNames: string[]) {
  const map = new Map<string, string>();
  for (const name of categoryNames) {
    const existing = await prisma.category.findFirst({ where: { tenantId, name } });
    const row = existing ?? await prisma.category.create({ data: { tenantId, name } });
    map.set(name, row.id);
  }
  return map;
}

async function seedBrands(tenantId: string, brandNames: string[]) {
  const map = new Map<string, string>();
  for (const name of brandNames) {
    if (!name) continue;
    const row = await prisma.brand.upsert({
      where: { tenantId_name: { tenantId, name } },
      create: { tenantId, name },
      update: {},
    });
    map.set(name, row.id);
  }
  return map;
}

type CatalogItem = {
  category: string;
  name: string;
  sku: string;
  price: number;
  costPrice: number;
  taxCode: string;
  unit: string;
  kind: 'physical' | 'service';
  trackQty: boolean;
  qty: number;
  brand?: string;
  description?: string;
  meta?: Record<string, unknown>;
};

type StockRow = {
  productId: string;
  stockLevelId: string;
  name: string;
  sku: string;
  price: number;
  taxCode: string | null;
  kind: 'physical' | 'service';
};

async function seedSaleCatalog(
  tenantId: string,
  locationId: string,
  categoryMap: Map<string, string>,
  brandMap: Map<string, string>,
  items: CatalogItem[],
): Promise<StockRow[]> {
  const stockRows: StockRow[] = [];
  for (const p of items) {
    const categoryId = categoryMap.get(p.category);
    if (!categoryId) {
      console.warn(`  [WARN] Category not found: ${p.category} — skipping ${p.sku}`);
      continue;
    }
    // Idempotent: skip if SKU already exists for this tenant
    const existing = await prisma.product.findFirst({ where: { tenantId, skuCode: p.sku } });
    if (existing) {
      const level = await prisma.stockLevel.findFirst({ where: { tenantId, productId: existing.id, locationId } });
      if (level) {
        stockRows.push({ productId: existing.id, stockLevelId: level.id, name: existing.name, sku: existing.skuCode, price: Number(level.sellPrice), taxCode: existing.taxCode, kind: existing.kind as any });
      }
      continue;
    }

    const product = await prisma.product.create({
      data: {
        tenantId,
        categoryId,
        brandId: p.brand ? (brandMap.get(p.brand) ?? null) : null,
        name: p.name,
        skuCode: p.sku,
        taxCode: p.taxCode,
        kind: p.kind,
        fulfillmentMode: p.kind === 'service' ? 'service' : 'sale',
        basePrice: p.price,
        costPrice: p.costPrice,
        trackQty: p.trackQty,
        trackSerial: false,
        description: p.description ?? null,
        meta: {
          sellUnit: p.unit,
          itemType: p.kind === 'service' ? 'service' : 'goods',
          ...(p.meta ?? {}),
        } as Prisma.InputJsonValue,
      },
    });

    const level = await prisma.stockLevel.create({
      data: {
        tenantId,
        locationId,
        productId: product.id,
        sku: p.sku,
        sellUnit: p.unit,
        qtyOnHand: p.trackQty ? p.qty : 0,
        sellPrice: p.price,
      },
    });

    stockRows.push({ productId: product.id, stockLevelId: level.id, name: product.name, sku: product.skuCode, price: p.price, taxCode: product.taxCode, kind: p.kind });
  }
  return stockRows;
}

type RentalItem = {
  category: string;
  name: string;
  sku: string;
  rentalPrice: number;
  depositAmount: number;
  taxCode: string;
  kind: 'physical';
  description?: string;
  brand?: string;
  units: Array<{ barcode: string; size: string; condition: 'new' | 'good' | 'damaged'; ownership: 'own'; depositAmount: number }>;
  meta?: Record<string, unknown>;
};

async function seedRentalCatalog(
  tenantId: string,
  locationId: string,
  categoryMap: Map<string, string>,
  brandMap: Map<string, string>,
  items: RentalItem[],
): Promise<number> {
  let unitCount = 0;
  for (const p of items) {
    const categoryId = categoryMap.get(p.category);
    if (!categoryId) {
      console.warn(`  [WARN] Rental category not found: ${p.category} — skipping ${p.sku}`);
      continue;
    }
    let productId: string;
    const existing = await prisma.product.findFirst({ where: { tenantId, skuCode: p.sku } });
    if (existing) {
      productId = existing.id;
    } else {
      const product = await prisma.product.create({
        data: {
          tenantId,
          categoryId,
          brandId: p.brand ? (brandMap.get(p.brand) ?? null) : null,
          name: p.name,
          skuCode: p.sku,
          taxCode: p.taxCode,
          kind: 'physical',
          fulfillmentMode: 'rental',
          basePrice: p.rentalPrice,
          costPrice: Math.round(p.rentalPrice * 0.3 * 100) / 100,
          trackQty: false,
          trackSerial: true,
          description: p.description ?? null,
          meta: {
            sellUnit: 'day',
            itemType: 'goods',
            depositAmount: p.depositAmount,
            rentalPricePerDay: p.rentalPrice,
            ...(p.meta ?? {}),
          } as Prisma.InputJsonValue,
        },
      });
      productId = product.id;
    }

    // Seed serial units (idempotent: skip existing barcodes)
    for (const u of p.units) {
      const existingUnit = await prisma.stockUnit.findFirst({
        where: { tenantId, barcodeSku: u.barcode },
      });
      if (existingUnit) continue;
      await prisma.stockUnit.create({
        data: {
          tenantId,
          locationId,
          productId,
          barcodeSku: u.barcode,
          variantLabel: u.size,
          condition: u.condition,
          status: 'available',
          ownership: u.ownership,
          depositAmount: u.depositAmount,
          meta: { rentalPrice: p.rentalPrice } as Prisma.InputJsonValue,
        },
      });
      unitCount++;
    }
  }
  return unitCount;
}

type CustomerSpec = {
  name: string;
  phone: string;
  email: string | null;
  meta?: Record<string, unknown>;
};

async function seedCustomers(
  tenantId: string,
  customers: CustomerSpec[],
): Promise<Array<{ id: string }>> {
  const result: Array<{ id: string }> = [];
  for (const c of customers) {
    const existing = await prisma.customer.findFirst({
      where: { tenantId, phone: c.phone },
    });
    if (existing) { result.push({ id: existing.id }); continue; }
    const row = await prisma.customer.create({
      data: {
        tenantId,
        fullName: c.name,
        phone: c.phone,
        email: c.email ?? null,
        loyaltyPoints: 0,
        marketingOptIn: Boolean(c.email),
        meta: (c.meta ?? {}) as Prisma.InputJsonValue,
      },
    });
    result.push({ id: row.id });
  }
  return result;
}

type SupplierSpec = {
  code: string;
  name: string;
  supplierType: string;
  contact: string;
  phone: string;
  email: string;
  taxId?: string;
  paymentTerm: string;
  dueDays: number;
  creditLimit: number;
};

async function seedSuppliers(
  tenantId: string,
  suppliers: SupplierSpec[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const s of suppliers) {
    const existing = await prisma.supplier.findFirst({ where: { tenantId, code: s.code } });
    if (existing) { ids.push(existing.id); continue; }
    const row = await prisma.supplier.create({
      data: {
        tenantId,
        code: s.code,
        name: s.name,
        legalName: `${s.name} Pvt Ltd`,
        supplierType: s.supplierType,
        status: 'active',
        contact: s.contact,
        phone: s.phone,
        email: s.email,
        taxId: s.taxId ?? null,
        paymentTerm: s.paymentTerm,
        dueDays: s.dueDays,
        creditLimit: s.creditLimit,
        currencyCode: CURRENCY,
      },
    });
    // primary contact
    await prisma.supplierContact.create({
      data: {
        tenantId, supplierId: row.id,
        name: s.contact, email: s.email, phone: s.phone,
        role: 'Account manager', isPrimary: true,
      },
    });
    ids.push(row.id);
  }
  return ids;
}

async function createDemoOrders(params: {
  tenantId: string;
  locationId: string;
  userId: string;
  orderPrefix: string;
  taxId: string;
  stockRows: StockRow[];
  customerIds: string[];
  count?: number;
}) {
  const {
    tenantId, locationId, userId,
    orderPrefix, taxId, stockRows, customerIds,
  } = params;

  const sellable = stockRows.filter(r => r.price > 0 && r.kind !== 'service');
  const serviceable = stockRows.filter(r => r.kind === 'service' && r.price > 0);
  const all = [...sellable.slice(0, 15), ...serviceable.slice(0, 5)];
  if (!all.length) return 0;

  const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(10, 0, 0, 0); return d; };
  const taxRate = 0.05;
  const methods = ['cash', 'upi', 'card'] as const;
  const count = params.count ?? 12;
  let created = 0;

  for (let i = 0; i < count; i++) {
    const orderNum = `ORD-${orderPrefix}-${String(10001 + i).padStart(5, '0')}`;
    const existing = await prisma.order.findFirst({ where: { tenantId, orderNumber: orderNum } });
    if (existing) continue;

    const lineCount = (i % 3) + 1;
    const lines = Array.from({ length: lineCount }, (_, j) => all[(i + j) % all.length]);
    const qty = (i % 3) + 1;
    const subtotal = lines.reduce((sum, r) => sum + r.price * qty, 0);
    const taxTotal = Math.round(subtotal * taxRate * 100) / 100;
    const grand = Math.round((subtotal + taxTotal) * 100) / 100;
    const cgst = Math.round((taxTotal / 2) * 100) / 100;
    const sgst = taxTotal - cgst;
    const createdAt = daysAgo(count - i);
    const customerId = customerIds[i % customerIds.length] ?? null;
    const method = methods[i % methods.length];

    await prisma.order.create({
      data: {
        tenantId,
        locationId,
        customerId,
        orderNumber: orderNum,
        kind: 'sale',
        status: 'closed',
        currencyCode: CURRENCY,
        subtotal,
        taxTotal,
        discountTotal: 0,
        depositTotal: 0,
        balanceDue: 0,
        createdById: userId,
        createdAt,
        items: {
          create: lines.map(row => ({
            tenantId,
            itemKind: 'product' as const,
            productId: row.productId,
            stockLevelId: row.stockLevelId,
            description: row.name,
            quantity: qty,
            unitPrice: row.price,
            lineTotal: Math.round((row.price * qty + row.price * qty * taxRate) * 100) / 100,
            taxAmount: Math.round(row.price * qty * taxRate * 100) / 100,
          })),
        },
        payments: {
          create: {
            tenantId,
            locationId,
            type: 'payment',
            method,
            status: 'succeeded',
            amount: grand,
            currencyCode: CURRENCY,
            idempotencyKey: `seed-demo-${orderNum}`,
            takenByUserId: userId,
            createdAt,
          },
        },
        invoices: {
          create: {
            tenantId,
            invoiceNumber: `INV-${orderPrefix}-${String(10001 + i).padStart(5, '0')}`,
            taxIdSnapshot: taxId,
            taxBreakdown: { cgst, sgst, igst: 0, placeOfSupply: 'Karnataka' } as Prisma.InputJsonValue,
            cgst,
            sgst,
            igst: 0,
            grandTotal: grand,
            createdAt,
          },
        },
      },
    });
    created++;
  }
  return created;
}

async function createPurchaseOrders(
  tenantId: string,
  supplierIds: string[],
  stockRows: StockRow[],
  prefix: string,
) {
  if (!supplierIds.length || !stockRows.length) return 0;
  const physical = stockRows.filter(r => r.kind === 'physical').slice(0, 5);
  if (!physical.length) return 0;
  let count = 0;
  for (let i = 0; i < Math.min(3, supplierIds.length); i++) {
    const poNum = `PO-${prefix}-${String(1001 + i).padStart(4, '0')}`;
    const existing = await prisma.purchaseOrder.findFirst({ where: { tenantId, poNumber: poNum } });
    if (existing) continue;
    const lines = physical.slice(0, Math.min(3 + i, physical.length));
    await prisma.purchaseOrder.create({
      data: {
        tenantId,
        supplierId: supplierIds[i % supplierIds.length],
        poNumber: poNum,
        status: i === 0 ? 'received' : 'ordered',
        expectedDelivery: new Date(Date.now() + (i + 1) * 5 * 86400000),
        notes: `Demo purchase order ${i + 1}`,
        lines: {
          create: lines.map(row => ({
            tenantId,
            stockLevelId: row.stockLevelId,
            qtyOrdered: 20 + i * 10,
            unitCost: Math.round(row.price * 0.55 * 100) / 100,
          })),
        },
      },
    });
    count++;
  }
  return count;
}

// ─── Business Provisioners ────────────────────────────────────────────────────

async function provisionIfAbsent(
  passwordHash: string,
  slug: string,
  tenantName: string,
  adminEmail: string,
  adminFullName: string,
  adminPhone: string,
  moduleCodes: readonly string[],
) {
  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    console.log(`  [EXISTING] Tenant "${slug}" found (${existing.id})`);
    let loc = await prisma.location.findFirst({ where: { tenantId: existing.id } });
    if (!loc) {
      loc = await prisma.location.create({
        data: {
          tenantId: existing.id,
          name: 'Main Branch',
          slug: 'main',
          isActive: true,
        },
      });
    }

    let user = await prisma.user.findFirst({ where: { tenantId: existing.id, email: adminEmail } });
    if (!user) {
      // Find admin role
      const adminRole = await prisma.role.findFirst({
        where: { tenantId: existing.id, code: 'admin' },
      });
      user = await prisma.user.create({
        data: {
          tenantId: existing.id,
          primaryLocationId: loc.id,
          email: adminEmail,
          fullName: adminFullName,
          passwordHash,
          isActive: true,
          passwordChangedAt: new Date(),
        },
      });
      if (adminRole) {
        await prisma.userRole.create({
          data: { userId: user.id, roleId: adminRole.id, locationId: loc.id },
        });
        await prisma.membership.create({
          data: {
            tenantId: existing.id,
            userId: user.id,
            locationId: loc.id,
            roleId: adminRole.id,
            status: 'active',
          },
        });
      }
    } else {
      // Ensure password is updated to standard demo password
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, isActive: true },
      });
    }

    return { tenant: existing, location: loc, user };
  }
  const result = await prisma.$transaction(async (tx) =>
    provisionTenantWithAdmin(tx, {
      tenantName,
      slug,
      locationName: 'Main Branch',
      adminEmail,
      adminFullName,
      adminPhone,
      passwordHash,
      currencyCode: CURRENCY,
      locale: 'en-IN',
      moduleCodes: [...moduleCodes],
    }),
  );
  return result;
}

// ─── GYM ─────────────────────────────────────────────────────────────────────

async function seedGym(passwordHash: string) {
  console.log('\n🏋️  Provisioning Gym & Fitness Center...');
  const result = await provisionIfAbsent(
    passwordHash,
    'gym-demo',
    'Peak Performance Gym',
    'gym.admin@gym.demo',
    'Gym Admin',
    '9701000100',
    GYM_MODULES,
  );

  const tenantId = result.tenant.id;
  const locationId = result.location.id;
  const userId = result.user.id;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      taxId: '29GYMDEMODEMO1Z5',
      branding: { productName: 'Peak Performance Gym', tagline: 'Transform · Perform · Excel' } as Prisma.InputJsonValue,
    },
  });

  await applyBusinessType(tenantId, 'gym', ['sale', 'service', 'subscription']);
  await linkIdentity(passwordHash, 'gym.admin@gym.demo', 'Gym Admin', '9701000100', tenantId, userId);
  await addStaffMembers(tenantId, locationId, passwordHash, GYM_STAFF);

  const categoryMap = await seedCategories(tenantId, GYM_CATEGORIES);
  const brandNames = [...new Set(GYM_PRODUCTS.filter(p => p.brand).map(p => p.brand!))];
  const brandMap = await seedBrands(tenantId, brandNames);

  console.log(`  Seeding ${GYM_PRODUCTS.length} gym products...`);
  const stockRows = await seedSaleCatalog(tenantId, locationId, categoryMap, brandMap, GYM_PRODUCTS);
  console.log(`  ✅ ${stockRows.length} gym products/services seeded`);

  const customerRows = await seedCustomers(tenantId, GYM_CUSTOMERS);
  console.log(`  ✅ ${customerRows.length} gym customers seeded`);

  const supplierIds = await seedSuppliers(tenantId, GYM_SUPPLIERS);
  console.log(`  ✅ ${supplierIds.length} gym suppliers seeded`);

  const orderCount = await createDemoOrders({
    tenantId, locationId, userId,
    orderPrefix: 'GYM', taxId: '29GYMDEMODEMO1Z5',
    stockRows, customerIds: customerRows.map(c => c.id), count: 15,
  });
  console.log(`  ✅ ${orderCount} gym demo orders created`);

  const poCount = await createPurchaseOrders(tenantId, supplierIds, stockRows, 'GYM');
  console.log(`  ✅ ${poCount} gym purchase orders created`);

  await ensureExpenseCategories(tenantId, locationId, userId);
  await ensureCoupons(tenantId, 'GYM');

  return { tenantId, products: stockRows.length, customers: customerRows.length, orders: orderCount };
}

// ─── GROCERY ─────────────────────────────────────────────────────────────────

async function seedGrocery(passwordHash: string) {
  console.log('\n🛒  Provisioning Grocery Store...');
  const result = await provisionIfAbsent(
    passwordHash,
    'grocery-demo',
    'FreshMart Grocery',
    'grocery.admin@grocery.demo',
    'Grocery Admin',
    '9702000100',
    SALE_MODULES,
  );

  const tenantId = result.tenant.id;
  const locationId = result.location.id;
  const userId = result.user.id;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      taxId: '29GRCDEMODEMO1Z5',
      branding: { productName: 'FreshMart Grocery', tagline: 'Fresh · Local · Affordable' } as Prisma.InputJsonValue,
    },
  });

  await applyBusinessType(tenantId, 'grocery', ['sale']);
  await linkIdentity(passwordHash, 'grocery.admin@grocery.demo', 'Grocery Admin', '9702000100', tenantId, userId);
  await addStaffMembers(tenantId, locationId, passwordHash, GROCERY_STAFF);

  const categoryMap = await seedCategories(tenantId, GROCERY_CATEGORIES);
  const brandNames = [...new Set(GROCERY_PRODUCTS.filter(p => p.brand).map(p => p.brand!))];
  const brandMap = await seedBrands(tenantId, brandNames);

  console.log(`  Seeding ${GROCERY_PRODUCTS.length} grocery products...`);
  const stockRows = await seedSaleCatalog(tenantId, locationId, categoryMap, brandMap, GROCERY_PRODUCTS);
  console.log(`  ✅ ${stockRows.length} grocery products seeded`);

  const customerRows = await seedCustomers(tenantId, GROCERY_CUSTOMERS);
  console.log(`  ✅ ${customerRows.length} grocery customers seeded`);

  const supplierIds = await seedSuppliers(tenantId, GROCERY_SUPPLIERS);
  console.log(`  ✅ ${supplierIds.length} grocery suppliers seeded`);

  const orderCount = await createDemoOrders({
    tenantId, locationId, userId,
    orderPrefix: 'GRC', taxId: '29GRCDEMODEMO1Z5',
    stockRows, customerIds: customerRows.map(c => c.id), count: 20,
  });
  console.log(`  ✅ ${orderCount} grocery demo orders created`);

  const poCount = await createPurchaseOrders(tenantId, supplierIds, stockRows, 'GRC');
  console.log(`  ✅ ${poCount} grocery purchase orders created`);

  await ensureExpenseCategories(tenantId, locationId, userId);
  await ensureCoupons(tenantId, 'GRC');

  return { tenantId, products: stockRows.length, customers: customerRows.length, orders: orderCount };
}

// ─── RENTAL ──────────────────────────────────────────────────────────────────

async function seedRental(passwordHash: string) {
  console.log('\n🎭  Provisioning Rental Business...');
  const result = await provisionIfAbsent(
    passwordHash,
    'rental-demo',
    'Prestige Rentals',
    'rental.admin@rental.demo',
    'Rental Admin',
    '9703000100',
    RENTAL_MODULES,
  );

  const tenantId = result.tenant.id;
  const locationId = result.location.id;
  const userId = result.user.id;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      taxId: '29RNTDEMODEMO1Z5',
      branding: { productName: 'Prestige Rentals', tagline: 'Rent · Style · Return' } as Prisma.InputJsonValue,
    },
  });

  await applyBusinessType(tenantId, 'rental', ['rental', 'sale']);
  await linkIdentity(passwordHash, 'rental.admin@rental.demo', 'Rental Admin', '9703000100', tenantId, userId);
  await addStaffMembers(tenantId, locationId, passwordHash, RENTAL_STAFF);

  const categoryMap = await seedCategories(tenantId, RENTAL_CATEGORIES);
  const brandNames = [...new Set(RENTAL_PRODUCTS.filter(p => p.brand).map(p => p.brand!))];
  const brandMap = await seedBrands(tenantId, brandNames);

  console.log(`  Seeding ${RENTAL_PRODUCTS.length} rental items with serial units...`);
  const unitCount = await seedRentalCatalog(tenantId, locationId, categoryMap, brandMap, RENTAL_PRODUCTS);
  console.log(`  ✅ ${RENTAL_PRODUCTS.length} rental products + ${unitCount} serial units seeded`);

  const customerRows = await seedCustomers(tenantId, RENTAL_CUSTOMERS);
  console.log(`  ✅ ${customerRows.length} rental customers seeded`);

  const supplierIds = await seedSuppliers(tenantId, RENTAL_SUPPLIERS);
  console.log(`  ✅ ${supplierIds.length} rental suppliers seeded`);

  await ensureExpenseCategories(tenantId, locationId, userId);
  await ensureCoupons(tenantId, 'RNT');

  return { tenantId, products: RENTAL_PRODUCTS.length, units: unitCount, customers: customerRows.length };
}

// ─── SWIMMING ─────────────────────────────────────────────────────────────────

async function seedSwimming(passwordHash: string) {
  console.log('\n🏊  Provisioning Swimming Academy...');
  const result = await provisionIfAbsent(
    passwordHash,
    'swimming-demo',
    'AquaStar Swimming Academy',
    'swimming.admin@swimming.demo',
    'Swimming Admin',
    '9704000100',
    SWIMMING_MODULES,
  );

  const tenantId = result.tenant.id;
  const locationId = result.location.id;
  const userId = result.user.id;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      taxId: '29SWMDEMODEMO1Z5',
      branding: { productName: 'AquaStar Swimming Academy', tagline: 'Swim · Train · Excel' } as Prisma.InputJsonValue,
    },
  });

  await applyBusinessType(tenantId, 'coaching', ['sale', 'service', 'subscription']);
  await linkIdentity(passwordHash, 'swimming.admin@swimming.demo', 'Swimming Admin', '9704000100', tenantId, userId);
  await addStaffMembers(tenantId, locationId, passwordHash, SWIMMING_STAFF);

  const categoryMap = await seedCategories(tenantId, SWIMMING_CATEGORIES);
  const brandNames = [...new Set(SWIMMING_PRODUCTS.filter(p => p.brand).map(p => p.brand!))];
  const brandMap = await seedBrands(tenantId, brandNames);

  console.log(`  Seeding ${SWIMMING_PRODUCTS.length} swimming products/services...`);
  const stockRows = await seedSaleCatalog(tenantId, locationId, categoryMap, brandMap, SWIMMING_PRODUCTS);
  console.log(`  ✅ ${stockRows.length} swimming products/services seeded`);

  const customerRows = await seedCustomers(tenantId, SWIMMING_CUSTOMERS);
  console.log(`  ✅ ${customerRows.length} swimming customers seeded`);

  const supplierIds = await seedSuppliers(tenantId, SWIMMING_SUPPLIERS);
  console.log(`  ✅ ${supplierIds.length} swimming suppliers seeded`);

  const orderCount = await createDemoOrders({
    tenantId, locationId, userId,
    orderPrefix: 'SWM', taxId: '29SWMDEMODEMO1Z5',
    stockRows, customerIds: customerRows.map(c => c.id), count: 15,
  });
  console.log(`  ✅ ${orderCount} swimming demo orders created`);

  await ensureExpenseCategories(tenantId, locationId, userId);
  await ensureCoupons(tenantId, 'SWM');

  return { tenantId, products: stockRows.length, customers: customerRows.length, orders: orderCount };
}

// ─── SALON ────────────────────────────────────────────────────────────────────

async function seedSalon(passwordHash: string) {
  console.log('\n💇  Provisioning Salon...');
  const result = await provisionIfAbsent(
    passwordHash,
    'salon-demo',
    'Glow Salon & Spa',
    'salon.admin@salon.demo',
    'Salon Admin',
    '9705000100',
    SALON_MODULES,
  );

  const tenantId = result.tenant.id;
  const locationId = result.location.id;
  const userId = result.user.id;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      taxId: '29SLNDEMODEMO1Z5',
      branding: { productName: 'Glow Salon & Spa', tagline: 'Look Good · Feel Great' } as Prisma.InputJsonValue,
    },
  });

  await applyBusinessType(tenantId, 'salon', ['service', 'sale']);
  await linkIdentity(passwordHash, 'salon.admin@salon.demo', 'Salon Admin', '9705000100', tenantId, userId);
  await addStaffMembers(tenantId, locationId, passwordHash, SALON_STAFF);

  const categoryMap = await seedCategories(tenantId, SALON_CATEGORIES);
  const brandNames = [...new Set(SALON_PRODUCTS.filter(p => p.brand).map(p => p.brand!))];
  const brandMap = await seedBrands(tenantId, brandNames);

  console.log(`  Seeding ${SALON_PRODUCTS.length} salon services + products...`);
  const stockRows = await seedSaleCatalog(tenantId, locationId, categoryMap, brandMap, SALON_PRODUCTS);
  console.log(`  ✅ ${stockRows.length} salon services/products seeded`);

  const customerRows = await seedCustomers(tenantId, SALON_CUSTOMERS);
  console.log(`  ✅ ${customerRows.length} salon customers seeded`);

  const supplierIds = await seedSuppliers(tenantId, SALON_SUPPLIERS);
  console.log(`  ✅ ${supplierIds.length} salon suppliers seeded`);

  const orderCount = await createDemoOrders({
    tenantId, locationId, userId,
    orderPrefix: 'SLN', taxId: '29SLNDEMODEMO1Z5',
    stockRows, customerIds: customerRows.map(c => c.id), count: 12,
  });
  console.log(`  ✅ ${orderCount} salon demo orders created`);

  const poCount = await createPurchaseOrders(tenantId, supplierIds, stockRows, 'SLN');
  console.log(`  ✅ ${poCount} salon purchase orders created`);

  await ensureExpenseCategories(tenantId, locationId, userId);
  await ensureCoupons(tenantId, 'SLN');

  return { tenantId, products: stockRows.length, customers: customerRows.length, orders: orderCount };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  Universal POS — Multi-Vertical Demo Seed (ADDITIVE)');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  Password for ALL users: WalitShop@2026');
  console.log('  Mode: ADDITIVE — existing data is preserved');
  console.log('  Idempotent: safe to run multiple times');
  console.log('');

  await ensurePlatformCatalog(prisma);
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);

  const gym = await seedGym(passwordHash);
  const grocery = await seedGrocery(passwordHash);
  const rental = await seedRental(passwordHash);
  const swimming = await seedSwimming(passwordHash);
  const salon = await seedSalon(passwordHash);

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  SEED SUMMARY');
  console.log('════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Business             Admin Email                         Products  Customers  Orders');
  console.log('  ──────────────────── ─────────────────────────────────── ───────── ────────── ──────');
  console.log(`  Gym                  gym.admin@gym.demo                  ${String(gym.products).padStart(9)} ${String(gym.customers).padStart(10)} ${String(gym.orders).padStart(6)}`);
  console.log(`  Grocery              grocery.admin@grocery.demo          ${String(grocery.products).padStart(9)} ${String(grocery.customers).padStart(10)} ${String(grocery.orders).padStart(6)}`);
  console.log(`  Rental               rental.admin@rental.demo            ${String(rental.products).padStart(9)} ${String(rental.customers).padStart(10)}      N/A`);
  console.log(`  Swimming Academy     swimming.admin@swimming.demo        ${String(swimming.products).padStart(9)} ${String(swimming.customers).padStart(10)} ${String(swimming.orders).padStart(6)}`);
  console.log(`  Salon                salon.admin@salon.demo              ${String(salon.products).padStart(9)} ${String(salon.customers).padStart(10)} ${String(salon.orders).padStart(6)}`);
  console.log('');
  console.log('  Staff usernames (same password):');
  console.log('    gym.manager@gym.demo / gym.staff@gym.demo');
  console.log('    grocery.manager@grocery.demo / grocery.staff@grocery.demo');
  console.log('    rental.manager@rental.demo / rental.staff@rental.demo');
  console.log('    swimming.manager@swimming.demo / swimming.staff@swimming.demo');
  console.log('    salon.manager@salon.demo / salon.staff@salon.demo');
  console.log('');
  console.log('  Tenants:');
  console.log(`    gym-demo       → ${gym.tenantId}`);
  console.log(`    grocery-demo   → ${grocery.tenantId}`);
  console.log(`    rental-demo    → ${rental.tenantId}`);
  console.log(`    swimming-demo  → ${swimming.tenantId}`);
  console.log(`    salon-demo     → ${salon.tenantId}`);
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  ✅ Seed complete — all 5 businesses ready for testing!');
  console.log('════════════════════════════════════════════════════════════');
  console.log('');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
