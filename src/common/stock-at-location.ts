import type { Prisma } from '@prisma/client';

/** Prisma interactive tx or root client — keep loose; both expose the models we use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/** Other active branches get a 0-qty row so shop switch still lists the item. */
export async function seedZeroStockAtOtherLocations(
  tx: Tx,
  opts: {
    tenantId: string;
    productId: string;
    sku: string;
    sellUnit: string;
    sellPrice: Prisma.Decimal | number;
    exceptLocationId: string;
  },
) {
  const others: Array<{ id: string }> = await tx.location.findMany({
    where: { tenantId: opts.tenantId, isActive: true },
    select: { id: true },
  });
  const rows = others
    .filter((l: { id: string }) => l.id !== opts.exceptLocationId)
    .map((l: { id: string }) => ({
      tenantId: opts.tenantId,
      locationId: l.id,
      productId: opts.productId,
      sku: opts.sku,
      sellUnit: opts.sellUnit,
      qtyOnHand: 0,
      sellPrice: opts.sellPrice,
    }));
  if (!rows.length) return;
  await tx.stockLevel.createMany({ data: rows, skipDuplicates: true });
}

/** New branch: one 0-qty stock row per existing catalog item. */
export async function seedZeroStockForNewLocation(
  tx: Tx,
  opts: { tenantId: string; locationId: string },
) {
  const products = await tx.product.findMany({
    where: { tenantId: opts.tenantId },
    select: {
      id: true,
      skuCode: true,
      unitOfMeasure: true,
      basePrice: true,
      stockLevels: {
        take: 1,
        orderBy: { createdAt: 'asc' },
        select: { sku: true, sellUnit: true, sellPrice: true },
      },
    },
  });
  if (!products.length) return;
  await tx.stockLevel.createMany({
    skipDuplicates: true,
    data: products.map(
      (p: {
        id: string;
        skuCode: string;
        unitOfMeasure: string;
        basePrice: Prisma.Decimal;
        stockLevels: Array<{
          sku: string;
          sellUnit: string;
          sellPrice: Prisma.Decimal;
        }>;
      }) => {
      const tmpl = p.stockLevels[0];
      return {
        tenantId: opts.tenantId,
        locationId: opts.locationId,
        productId: p.id,
        sku: tmpl?.sku ?? p.skuCode,
        sellUnit: (tmpl?.sellUnit ?? p.unitOfMeasure).slice(0, 8),
        qtyOnHand: 0,
        sellPrice: tmpl?.sellPrice ?? p.basePrice,
      };
    }),
  });
}

/** Counter: create missing stock rows so catalog items appear at this branch. */
export async function ensurePosStockAtLocation(
  tx: Tx,
  opts: { tenantId: string; locationId: string },
) {
  await seedZeroStockForNewLocation(tx, opts);
}

