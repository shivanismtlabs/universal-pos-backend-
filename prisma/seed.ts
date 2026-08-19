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
  try {
    await prisma.intercompanyTransferLine.deleteMany();
    await prisma.intercompanyTransfer.deleteMany();
    await prisma.approvalStep.deleteMany();
    await prisma.approvalRequest.deleteMany();
    await prisma.approvalPolicy.deleteMany();
    await prisma.exceptionAlertRule.deleteMany();
    await prisma.groupSupplierLink.deleteMany();
    await prisma.groupCustomerLink.deleteMany();
    await prisma.businessSpinOff.deleteMany();
    await prisma.businessGroupMembership.deleteMany();
    await prisma.tenant.updateMany({ data: { businessGroupId: null } });
    await prisma.businessGroup.deleteMany();
  } catch {
    /* tables may not exist yet */
  }
  await prisma.payment.deleteMany();
  await prisma.orderFee.deleteMany();
  await prisma.layawaySchedule.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.returnEvent.deleteMany();
  await prisma.stockReservation.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.modRentalOrder.deleteMany();
  await prisma.order.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.document.deleteMany();
  await prisma.notificationLog.deleteMany();
  await prisma.modRentalCleaningJob.deleteMany();
  await prisma.modRentalDamageRecord.deleteMany();
  await prisma.modRentalPartyMember.deleteMany();
  await prisma.modRentalParty.deleteMany();
  await prisma.modRentalMeasurement.deleteMany();
  try {
    await prisma.purchaseOrderLine.deleteMany();
  } catch {
    /* */
  }
  try {
    await prisma.customerSubscription.deleteMany();
  } catch {
    /* */
  }
  try {
    await prisma.couponRedemption.deleteMany();
  } catch {
    /* */
  }
  try {
    await prisma.coupon.deleteMany();
  } catch {
    /* */
  }
  try {
    await prisma.expense.deleteMany();
  } catch {
    /* */
  }
  try {
    await prisma.expenseCategory.deleteMany();
  } catch {
    /* */
  }
  await prisma.stockLevel.deleteMany();
  await prisma.stockUnit.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.registerSession.deleteMany();
  await prisma.offlineSyncEvent.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.customFieldValue.deleteMany();
  await prisma.customFieldDefinition.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.tenantModule.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.tenantSubscription.deleteMany();
  try {
    await prisma.businessConfig.deleteMany();
  } catch {
    /* table may not exist on very old DBs */
  }
  try {
    await prisma.identityTenantMembership.deleteMany();
    await prisma.identityAccount.deleteMany();
  } catch {
    /* optional */
  }
  try {
    await prisma.authOtpChallenge.deleteMany();
  } catch {
    /* optional */
  }
  await prisma.user.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.department.deleteMany();
  await prisma.location.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.tenant.deleteMany();
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

  return { ...result, productName: product.name, productSku: product.skuCode };
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

  return { unitCount, tenant: result.tenant };
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

  return { productCount: products.length };
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
  });

  const rental = await seedRentalDemo(passwordHash);
  const pool = await seedPoolStoreLight(passwordHash);

  console.log('');
  console.log('=== Seed complete — password for ALL: WalitShop@2026 ===');
  console.log('');
  console.log('Retail     owner@retail.demo     product:', retail.productName);
  console.log('Grocery    owner@grocery.demo    product:', grocery.productName);
  console.log('Salon      owner@salon.demo      product:', salon.productName);
  console.log(
    'Restaurant owner@restaurant.demo product:',
    restaurant.productName,
  );
  console.log('Rental     owner@rental.demo     units:', rental.unitCount);
  console.log('Pool (retail sample) owner@pool.demo SKUs:', pool.productCount);
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
