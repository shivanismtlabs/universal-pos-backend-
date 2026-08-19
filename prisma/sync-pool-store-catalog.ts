/**
 * Sync The Pool Store catalog on an existing tenant (no wipe).
 * Usage: npx ts-node --transpile-only prisma/sync-pool-store-catalog.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  POOL_STORE_CATEGORIES,
  POOL_STORE_PRODUCTS,
} from './pool-store-catalog';
import { poolProductImageDataUrl } from './pool-store-images';

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUnique({
    where: { slug: 'pool-store' },
  });
  if (!tenant) {
    throw new Error('pool-store tenant missing — run seed first');
  }

  await prisma.tenant.update({
    where: { id: tenant.id },
    data: {
      name: 'The Pool Store',
      branding: {
        productName: 'The Pool Store',
        tagline: 'Pool, Spa & Outdoor Living · Valdosta, GA',
        primaryColor: '#0c4a6e',
      },
      settings: {
        ...(typeof tenant.settings === 'object' && tenant.settings
          ? (tenant.settings as object)
          : {}),
        industry: 'retail',
        country: 'US',
        state: 'GA',
        city: 'Valdosta',
        phone: '229-247-6440',
        commerceModes: ['sale'],
      },
    },
  });

  const location = await prisma.location.findFirst({
    where: { tenantId: tenant.id },
  });
  if (location) {
    await prisma.location.update({
      where: { id: location.id },
      data: {
        name: 'Valdosta Flagship',
        address: '3363 North Valdosta Road, Valdosta, GA 31602',
        regionCode: 'GA',
      },
    });
  }

  const categoryIds = new Map<string, string>();
  for (const name of POOL_STORE_CATEGORIES) {
    const existing = await prisma.category.findFirst({
      where: { tenantId: tenant.id, name },
    });
    if (existing) {
      categoryIds.set(name, existing.id);
      continue;
    }
    const created = await prisma.category.create({
      data: { tenantId: tenant.id, name },
    });
    categoryIds.set(name, created.id);
  }

  let created = 0;
  let updated = 0;
  for (const p of POOL_STORE_PRODUCTS) {
    const catId = categoryIds.get(p.category)!;
    const photoUrl = poolProductImageDataUrl(p.category, p.name);
    const existing = await prisma.product.findFirst({
      where: { tenantId: tenant.id, skuCode: p.sku },
    });
    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          name: p.name,
          categoryId: catId,
          basePrice: p.price,
          photoUrl,
          fulfillmentMode: 'sale',
          trackQty: true,
        },
      });
      if (location) {
        await prisma.stockLevel.upsert({
          where: {
            tenantId_locationId_productId_variantKey: {
              tenantId: tenant.id,
              locationId: location.id,
              productId: existing.id,
              variantKey: '',
            },
          },
          create: {
            tenantId: tenant.id,
            locationId: location.id,
            productId: existing.id,
            sku: p.sku,
            qtyOnHand: p.qty,
            sellPrice: p.price,
          },
          update: {
            qtyOnHand: p.qty,
            sellPrice: p.price,
            sku: p.sku,
          },
        });
      }
      updated += 1;
      continue;
    }

    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        categoryId: catId,
        name: p.name,
        skuCode: p.sku,
        kind: 'physical',
        fulfillmentMode: 'sale',
        basePrice: p.price,
        trackQty: true,
        trackSerial: false,
        photoUrl,
      },
    });
    if (location) {
      await prisma.stockLevel.create({
        data: {
          tenantId: tenant.id,
          locationId: location.id,
          productId: product.id,
          sku: p.sku,
          qtyOnHand: p.qty,
          sellPrice: p.price,
        },
      });
    }
    created += 1;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenant: tenant.slug,
        categories: POOL_STORE_CATEGORIES.length,
        products: POOL_STORE_PRODUCTS.length,
        created,
        updated,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
