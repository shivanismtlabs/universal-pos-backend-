/**
 * Phase 2 seed — Identity & Organization foundation.
 *
 * Login:
 *   Tenant: demo-shop
 *   Email:  owner@crown.demo
 *   Pass:   WalitShop@2026
 *   Also:   manager@ / cashier@ crown.demo (same password)
 *
 * Run after: prisma db push --force-reset
 *   npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  ensurePlatformCatalog,
  provisionTenantWithAdmin,
} from '../src/common/provision-tenant';

const prisma = new PrismaClient();

const TENANT_SLUG = 'demo-shop';
const ADMIN_PASSWORD = 'WalitShop@2026';
const BCRYPT_ROUNDS = 12;

async function wipeAllBusinessData() {
  // Order matters for FKs without cascade
  await prisma.membership.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.tenantModule.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.tenantSubscription.deleteMany();
  await prisma.customFieldValue.deleteMany();
  await prisma.customFieldDefinition.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.user.deleteMany();
  await prisma.role.deleteMany();
  await prisma.team.deleteMany();
  await prisma.department.deleteMany();
  await prisma.location.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.tenant.deleteMany();
}

async function main() {
  console.log('Phase 2 seed — wiping tenants…');
  await wipeAllBusinessData();
  await ensurePlatformCatalog(prisma);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS);

  const result = await prisma.$transaction(async (tx) =>
    provisionTenantWithAdmin(tx, {
      tenantName: 'Crown Demo Shop',
      slug: TENANT_SLUG,
      taxId: '29AABCU9603R1ZM',
      locationName: 'MG Road Flagship',
      adminEmail: 'owner@crown.demo',
      adminFullName: 'Shop Owner',
      adminPhone: '9811111111',
      passwordHash,
      moduleCodes: ['core', 'iam'],
    }),
  );

  // Second location for multi-location smoke
  const warehouse = await prisma.location.create({
    data: {
      tenantId: result.tenant.id,
      organizationId: result.organization.id,
      name: 'City Warehouse',
      code: 'WH01',
      type: 'warehouse',
      isActive: true,
    },
  });

  const staff = [
    {
      email: 'manager@crown.demo',
      fullName: 'Store Manager',
      role: 'manager',
      locationId: result.location.id,
      code: 'E002',
    },
    {
      email: 'cashier@crown.demo',
      fullName: 'Front Cashier',
      role: 'cashier',
      locationId: result.location.id,
      code: 'E003',
    },
  ];

  for (const s of staff) {
    const role = await prisma.role.findUniqueOrThrow({
      where: {
        tenantId_code: { tenantId: result.tenant.id, code: s.role },
      },
    });
    const u = await prisma.user.create({
      data: {
        tenantId: result.tenant.id,
        primaryLocationId: s.locationId,
        email: s.email,
        fullName: s.fullName,
        passwordHash,
        isActive: true,
        passwordChangedAt: new Date(),
      },
    });
    await prisma.employee.create({
      data: {
        tenantId: result.tenant.id,
        userId: u.id,
        employeeCode: s.code,
        status: 'active',
        hiredAt: new Date(),
        jobTitle: s.fullName,
      },
    });
    await prisma.userRole.create({
      data: {
        userId: u.id,
        roleId: role.id,
        locationId: s.locationId,
      },
    });
    await prisma.membership.create({
      data: {
        tenantId: result.tenant.id,
        userId: u.id,
        locationId: s.locationId,
        roleId: role.id,
        status: 'active',
      },
    });
  }

  console.log('Seeded Phase 2 Identity & Organization');
  console.log(`  Tenant:     ${TENANT_SLUG}`);
  console.log(`  Org:        ${result.organization.code}`);
  console.log(`  Store:      ${result.location.code} (${result.location.name})`);
  console.log(`  Warehouse:  ${warehouse.code}`);
  console.log(`  Owner:      owner@crown.demo / ${ADMIN_PASSWORD}`);
  console.log(`  Manager:    manager@crown.demo / ${ADMIN_PASSWORD}`);
  console.log(`  Cashier:    cashier@crown.demo / ${ADMIN_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
