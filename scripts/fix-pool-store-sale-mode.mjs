/**
 * Repair pool-store demo → Sale mode (rental OFF).
 * Usage: node scripts/fix-pool-store-sale-mode.mjs
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'pool-store' } });
  if (!tenant) {
    console.log('pool-store tenant not found — run prisma seed first');
    return;
  }

  const prev = /** @type {Record<string, unknown>} */ (tenant.settings ?? {});
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      settings: {
        ...prev,
        industry: prev.industry ?? 'pool_spa_retail',
        country: prev.country ?? 'US',
        state: prev.state ?? 'GA',
        commerceModes: ['sale'],
        commerceSetupAt: prev.commerceSetupAt ?? new Date().toISOString(),
      },
    },
  });

  const rentalMod = await prisma.module.findFirst({ where: { code: 'rental' } });
  if (rentalMod) {
    await prisma.tenantModule.updateMany({
      where: { tenantId: tenant.id, moduleId: rentalMod.id },
      data: { status: 'disabled' },
    });
  }

  for (const code of ['catalog', 'inventory', 'orders', 'payments', 'pos']) {
    const mod = await prisma.module.findFirst({ where: { code } });
    if (!mod) continue;
    await prisma.tenantModule.upsert({
      where: {
        tenantId_moduleId: { tenantId: tenant.id, moduleId: mod.id },
      },
      create: {
        tenantId: tenant.id,
        moduleId: mod.id,
        status: 'enabled',
      },
      update: { status: 'enabled' },
    });
  }

  console.log('pool-store repaired → Sale mode, rental disabled');
  console.log('Login: owner@pool.demo / WalitShop@2026');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
