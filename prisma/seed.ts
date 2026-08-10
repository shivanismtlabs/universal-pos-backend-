/**
 * Universal Business OS seed — Phase 1 MVP (sale-only)
 *
 * Tenants:
 *   demo-shop   — retail demo (INR)
 *   pool-store  — The Pool Store style retail (USD) — best for client demos
 *
 * Password (all): WalitShop@2026
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  ensurePlatformCatalog,
  provisionTenantWithAdmin,
} from '../src/common/provision-tenant';
import {
  POOL_STORE_CATEGORIES,
  POOL_STORE_PRODUCTS,
} from './pool-store-catalog';
import { poolProductImageDataUrl } from './pool-store-images';
import {
  FORMAL_CATEGORIES,
  FORMAL_PRODUCTS,
} from './formal-wear-catalog';

const prisma = new PrismaClient();
const ADMIN_PASSWORD = 'WalitShop@2026';
const BCRYPT_ROUNDS = 12;

async function wipeAllBusinessData() {
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

async function seedDemoShop(passwordHash: string) {
  const result = await prisma.$transaction(async (tx) =>
    provisionTenantWithAdmin(tx, {
      tenantName: 'Demo Shop',
      slug: 'demo-shop',
      taxId: '29AABCU9603R1ZM',
      locationName: 'MG Road Flagship',
      adminEmail: 'owner@demo.shop',
      adminFullName: 'Demo Owner',
      adminPhone: '9811111111',
      passwordHash,
      moduleCodes: [
        'core',
        'iam',
        'catalog',
        'inventory',
        'orders',
        'pos',
        'payments',
        'reports',
        'notify',
      ],
    }),
  );

  await prisma.tenant.update({
    where: { id: result.tenant.id },
    data: {
      branding: {
        productName: 'Demo Shop',
        tagline: 'Point of sale for your business',
      },
      settings: { industry: 'general', commerceModes: ['sale'] },
    },
  });

  await prisma.location.create({
    data: {
      tenantId: result.tenant.id,
      organizationId: result.organization.id,
      name: 'City Warehouse',
      code: 'WH01',
      type: 'warehouse',
      isActive: true,
    },
  });

  const categoryIds = new Map<string, string>();
  for (const name of FORMAL_CATEGORIES) {
    const cat = await prisma.category.create({
      data: { tenantId: result.tenant.id, name },
    });
    categoryIds.set(name, cat.id);
  }

  let unitCount = 0;
  let firstUnitId: string | null = null;
  for (const p of FORMAL_PRODUCTS) {
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
        meta: { vertical: 'formal_rental' },
      },
    });
    for (const u of p.units) {
      const unit = await prisma.stockUnit.create({
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
      if (!firstUnitId) firstUnitId = unit.id;
    }
  }

  const groom = await prisma.customer.create({
    data: {
      tenantId: result.tenant.id,
      fullName: 'Arjun Mehta',
      phone: '9822222201',
      email: 'arjun.mehta@example.com',
      notes: 'Groom — Dec wedding',
    },
  });
  const bestMan = await prisma.customer.create({
    data: {
      tenantId: result.tenant.id,
      fullName: 'Rohan Shah',
      phone: '9822222202',
      email: 'rohan.shah@example.com',
    },
  });

  await prisma.modRentalMeasurement.create({
    data: {
      tenantId: result.tenant.id,
      customerId: groom.id,
      heightCm: 178,
      chest: 102,
      waist: 86,
      inseam: 81,
      sleeve: 64,
      shoeSize: '9',
      extras: {},
    },
  });

  const party = await prisma.modRentalParty.create({
    data: {
      tenantId: result.tenant.id,
      name: 'Mehta Wedding Party',
      eventDate: new Date('2026-12-15'),
      primaryCustomerId: groom.id,
      members: {
        create: [
          { customerId: groom.id, roleLabel: 'groom' },
          { customerId: bestMan.id, roleLabel: 'best_man' },
        ],
      },
    },
  });

  await addStaff(result.tenant.id, result.location.id, passwordHash, [
    {
      email: 'manager@demo.shop',
      fullName: 'Store Manager',
      role: 'manager',
      code: 'E002',
    },
    {
      email: 'cashier@demo.shop',
      fullName: 'Front Cashier',
      role: 'cashier',
      code: 'E003',
    },
    {
      email: 'fitter@demo.shop',
      fullName: 'Lead Fitter',
      role: 'fitter',
      code: 'E004',
    },
  ]);

  return {
    ...result,
    unitCount,
    firstUnitId,
    groom,
    party,
  };
}

async function seedPoolStore(passwordHash: string) {
  const result = await prisma.$transaction(async (tx) =>
    provisionTenantWithAdmin(tx, {
      tenantName: 'The Pool Store',
      slug: 'pool-store',
      taxId: 'US-GA-POOL',
      locationName: 'Valdosta Flagship',
      adminEmail: 'owner@pool.demo',
      adminFullName: 'Pool Store Owner',
      adminPhone: '9876500001',
      passwordHash,
      currencyCode: 'USD',
      locale: 'en-US',
      timezone: 'America/New_York',
      taxMode: 'simple',
      moduleCodes: [
        'core',
        'iam',
        'catalog',
        'inventory',
        'orders',
        'pos',
        'payments',
        'reports',
        'notify',
      ],
    }),
  );

  await prisma.tenant.update({
    where: { id: result.tenant.id },
    data: {
      name: 'The Pool Store',
      branding: {
        productName: 'The Pool Store',
        tagline: 'Example shop — Universal POS works for any catalog',
        primaryColor: '#0c4a6e',
      },
      settings: {
        // Industry tag is metadata only — POS stays universal Sale keys
        industry: 'retail',
        country: 'US',
        state: 'GA',
        city: 'Valdosta',
        phone: '229-247-6440',
        commerceModes: ['sale'],
        commerceSetupAt: new Date().toISOString(),
      },
    },
  });

  await prisma.location.update({
    where: { id: result.location.id },
    data: {
      address: '3363 North Valdosta Road, Valdosta, GA 31602',
      regionCode: 'GA',
    },
  });

  const categoryIds = new Map<string, string>();
  for (const name of POOL_STORE_CATEGORIES) {
    const cat = await prisma.category.create({
      data: { tenantId: result.tenant.id, name },
    });
    categoryIds.set(name, cat.id);
  }

  for (const p of POOL_STORE_PRODUCTS) {
    const product = await prisma.product.create({
      data: {
        tenantId: result.tenant.id,
        categoryId: categoryIds.get(p.category)!,
        name: p.name,
        skuCode: p.sku,
        kind: 'physical',
        fulfillmentMode: 'sale',
        basePrice: p.price,
        trackQty: true,
        trackSerial: false,
        photoUrl: poolProductImageDataUrl(p.category, p.name),
        meta: {},
      },
    });
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

  // Universal custom field demo (any retail can define their own keys)
  const field = await prisma.customFieldDefinition.create({
    data: {
      tenantId: result.tenant.id,
      entity: 'customer',
      fieldKey: 'loyalty_note',
      label: 'Loyalty note',
      dataType: 'text',
      required: false,
      moduleCode: 'catalog',
      sortOrder: 1,
    },
  });

  const customer = await prisma.customer.create({
    data: {
      tenantId: result.tenant.id,
      fullName: 'Jordan Hayes',
      phone: '2292476440',
      email: 'jordan.hayes@example.com',
      notes: 'Regular Valdosta customer',
      meta: { city: 'Valdosta', state: 'GA' },
    },
  });

  await prisma.customFieldValue.create({
    data: {
      tenantId: result.tenant.id,
      definitionId: field.id,
      entityId: customer.id,
      valueText: 'Preferred contact: store phone',
    },
  });

  await addStaff(result.tenant.id, result.location.id, passwordHash, [
    {
      email: 'cashier@pool.demo',
      fullName: 'Pool Cashier',
      role: 'cashier',
      code: 'E002',
    },
  ]);

  await prisma.featureFlag.create({
    data: {
      tenantId: result.tenant.id,
      key: 'offline_pos',
      enabled: true,
    },
  });

  return {
    tenant: result.tenant,
    location: result.location,
    productCount: POOL_STORE_PRODUCTS.length,
    customer,
  };
}

async function main() {
  console.log('Phase 1 MVP seed — wiping + demo-shop + pool-store (sale-only)…');
  await wipeAllBusinessData();
  await ensurePlatformCatalog(prisma);
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);

  const demo = await seedDemoShop(passwordHash);
  const pool = await seedPoolStore(passwordHash);

  console.log('Seeded Phase 1 MVP (sale-only)');
  console.log('  demo-shop  owner@demo.shop / WalitShop@2026 (INR retail)');
  console.log(
    `  demo catalog: ${demo.unitCount} units, party=${demo.party.name}`,
  );
  console.log(
    '  pool-store owner@pool.demo / WalitShop@2026 (USD retail — preferred demo)',
  );
  console.log(
    `  pool-store catalog: ${pool.productCount} SKUs @ ${pool.location.name}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
