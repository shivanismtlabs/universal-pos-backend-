/**
 * Sync The Pool Store catalog on an existing tenant (no wipe).
 * Usage: npx ts-node --transpile-only prisma/sync-pool-store-catalog.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  POOL_STORE_CATEGORIES,
  POOL_STORE_PRODUCTS,
  POOL_STORE_SHOP,
  poolProductFlags,
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
        productName: POOL_STORE_SHOP.name,
        tagline: POOL_STORE_SHOP.tagline,
        primaryColor: '#0c4a6e',
      },
      settings: {
        ...(typeof tenant.settings === 'object' && tenant.settings
          ? (tenant.settings as object)
          : {}),
        industry: 'retail',
        country: POOL_STORE_SHOP.country,
        state: POOL_STORE_SHOP.state,
        city: POOL_STORE_SHOP.city,
        phone: POOL_STORE_SHOP.phone,
        hours: POOL_STORE_SHOP.hours,
        commerceModes: ['sale', 'service'],
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
        name: POOL_STORE_SHOP.locationName,
        address: POOL_STORE_SHOP.address,
        regionCode: POOL_STORE_SHOP.state,
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
    const flags = poolProductFlags(p);
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
          kind: flags.kind,
          fulfillmentMode: flags.fulfillmentMode,
          trackQty: flags.trackQty,
        },
      });
      if (location && flags.trackQty) {
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
        kind: flags.kind,
        fulfillmentMode: flags.fulfillmentMode,
        basePrice: p.price,
        trackQty: flags.trackQty,
        trackSerial: false,
        photoUrl,
      },
    });
    if (location && flags.trackQty) {
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
