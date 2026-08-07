/**
 * Ensure SaaS plans exist and every tenant has an active Starter subscription.
 *   node scripts/seed-saas-plans.mjs
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function upsertPlan(code, name, priceAmount, limits, features) {
  return prisma.plan.upsert({
    where: { code },
    create: {
      code,
      name,
      priceAmount,
      currencyCode: 'INR',
      limits,
      features,
    },
    update: {
      name,
      priceAmount,
      limits,
      features,
    },
  });
}

async function main() {
  const starterMods = [
    'core',
    'iam',
    'catalog',
    'inventory',
    'orders',
    'pos',
    'payments',
    'rental',
    'appointments',
    'notify',
    'reports',
  ];

  const starter = await upsertPlan(
    'starter',
    'Starter',
    999,
    { locations: 2, users: 10 },
    { modules: starterMods },
  );
  const pro = await upsertPlan(
    'professional',
    'Professional',
    2999,
    { locations: 10, users: 50 },
    { modules: starterMods },
  );

  console.log('Plans:', starter.code, pro.code);

  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true } });
  let attached = 0;
  for (const t of tenants) {
    const existing = await prisma.tenantSubscription.findFirst({
      where: { tenantId: t.id },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) continue;
    await prisma.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planId: starter.id,
        status: 'active',
        seatsUsed: 1,
        locationsUsed: 1,
        currentPeriodEnd: new Date(Date.now() + 365 * 86400000),
      },
    });
    attached += 1;
    console.log('  + starter →', t.slug);
  }
  console.log(`Subscriptions attached: ${attached}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
