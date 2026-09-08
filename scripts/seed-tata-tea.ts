import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // 1. Find FreshMart Grocery tenant
  const tenant = await prisma.tenant.findFirst({
    where: {
      OR: [
        { slug: 'grocery-demo' },
        { name: { contains: 'Grocery', mode: 'insensitive' } },
      ],
    },
    include: {
      locations: true,
    },
  });

  if (!tenant) {
    console.error('FreshMart Grocery tenant not found!');
    return;
  }

  const location = tenant.locations[0];
  if (!location) {
    console.error('No location found for Grocery tenant!');
    return;
  }

  const tenantId = tenant.id;
  const locationId = location.id;

  console.log(`Found Tenant: ${tenant.name} (${tenantId}), Location: ${location.name} (${locationId})`);

  // 2. Find or create Beverages category
  let category = await prisma.category.findFirst({
    where: { tenantId, name: { contains: 'Beverages', mode: 'insensitive' } },
  });
  if (!category) {
    category = await prisma.category.findFirst({
      where: { tenantId },
    });
  }
  if (!category) {
    category = await prisma.category.create({
      data: { tenantId, name: 'Beverages' },
    });
  }

  // 3. Find or create UnitGroup (COUNT) for pcs and carton
  let countGroup = await prisma.unitGroup.findUnique({
    where: { code: 'COUNT' },
  });
  if (!countGroup) {
    countGroup = await prisma.unitGroup.create({
      data: { code: 'COUNT', name: 'Count' },
    });
  }

  let pcsUnit = await prisma.unit.findFirst({
    where: { symbol: { equals: 'pcs', mode: 'insensitive' } },
  });
  if (!pcsUnit) {
    pcsUnit = await prisma.unit.create({
      data: {
        unitGroupId: countGroup.id,
        name: 'Piece',
        symbol: 'pcs',
        isBaseUnit: true,
        conversionToGroupBase: 1,
      },
    });
  }

  let cartonUnit = await prisma.unit.findFirst({
    where: { symbol: { equals: 'carton', mode: 'insensitive' } },
  });
  if (!cartonUnit) {
    cartonUnit = await prisma.unit.create({
      data: {
        unitGroupId: countGroup.id,
        name: 'Carton',
        symbol: 'carton',
        isBaseUnit: false,
        conversionToGroupBase: 12,
      },
    });
  }

  // 4. Create Product: Tata Tea Gold 1kg Carton
  const skuCode = 'GRC-TEA-TATA-1KC';
  const barcode = '8901058001001';
  const name = 'Tata Tea Gold 1kg Carton';

  const existingProduct = await prisma.product.findFirst({
    where: { tenantId, skuCode },
  });

  if (existingProduct) {
    console.log(`Product ${skuCode} already exists. Updating stock level...`);
    await prisma.stockLevel.upsert({
      where: {
        tenantId_locationId_productId_variantKey: {
          tenantId,
          locationId,
          productId: existingProduct.id,
          variantKey: '',
        },
      },
      create: {
        tenantId,
        locationId,
        productId: existingProduct.id,
        variantKey: '',
        sku: skuCode,
        sellPrice: 2400,
        qtyOnHand: 24, // 2 cartons
        sellUnit: 'carton',
      },
      update: {
        qtyOnHand: 24,
        sellPrice: 2400,
        sellUnit: 'carton',
      },
    });
    console.log(`✅ Updated existing product ${name} with 24 pcs (2 cartons) stock!`);
    return;
  }

  const product = await prisma.product.create({
    data: {
      tenantId,
      categoryId: category.id,
      name,
      skuCode,
      barcode,
      basePrice: 200, // 200 per piece
      costPrice: 150, // 150 per piece
      taxCode: '0902',
      kind: 'physical',
      fulfillmentMode: 'sale',
      trackQty: true,
      trackSerial: false,
      trackBatch: false,
      baseUnitId: pcsUnit.id,
      pricingUnitId: cartonUnit.id,
      pricingStrategy: 'converted',
      meta: {
        sellUnit: 'carton',
        packSize: '12 pcs per carton',
        taxRatePercent: 5,
        photoUrl: 'https://images.unsplash.com/photo-1576092768241-dec231879fc3?w=400&q=80',
      },
    },
  });

  // 5. Connect ProductUnits (Carton = 12 pcs, Pcs = 1 pc)
  await prisma.productUnit.createMany({
    data: [
      {
        tenantId,
        productId: product.id,
        unitId: cartonUnit.id,
        conversionToBase: 12,
        fixedPrice: 2400, // 2400 per carton
        isDefaultSellingUnit: true,
      },
      {
        tenantId,
        productId: product.id,
        unitId: pcsUnit.id,
        conversionToBase: 1,
        fixedPrice: 200, // 200 per piece
        isDefaultSellingUnit: false,
      },
    ],
  });

  // 6. Create StockLevel (24 pcs = 2 cartons)
  await prisma.stockLevel.create({
    data: {
      tenantId,
      locationId,
      productId: product.id,
      variantKey: '',
      sku: skuCode,
      sellPrice: 2400,
      qtyOnHand: 24, // 24 pieces in stock = 2 cartons
      qtyReserved: 0,
      sellUnit: 'carton',
    },
  });

  console.log(`🎉 SUCCESS! Created product "${name}" in ${tenant.name}:`);
  console.log(`   - SKU: ${skuCode}`);
  console.log(`   - Barcode: ${barcode}`);
  console.log(`   - Selling Unit: carton (1 Carton = 12 pcs)`);
  console.log(`   - Price: ₹2,400.00 / carton (₹200.00 / piece)`);
  console.log(`   - Stock: 24 pcs (Displays as "2 carton left" in POS grid)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
