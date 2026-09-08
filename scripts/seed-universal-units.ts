import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Universal Units (pcs, box, carton, pack, dozen, kg, g, L, ml)...');

  // 1. Ensure System Unit Groups
  const SYSTEM_GROUPS = [
    { code: 'WEIGHT', name: 'Weight' },
    { code: 'VOLUME', name: 'Volume' },
    { code: 'LENGTH', name: 'Length' },
    { code: 'AREA', name: 'Area' },
    { code: 'COUNT', name: 'Count' },
    { code: 'TIME', name: 'Time' },
    { code: 'CUSTOM', name: 'Custom' },
  ];

  for (const g of SYSTEM_GROUPS) {
    await prisma.unitGroup.upsert({
      where: { code: g.code },
      create: { code: g.code, name: g.name },
      update: { name: g.name, isActive: true },
    });
  }

  const groups = await prisma.unitGroup.findMany();
  const byGroupCode = new Map(groups.map((x) => [x.code, x.id]));

  // 2. Ensure System Units
  const SYSTEM_UNITS: Array<[string, string, string, boolean, number]> = [
    ['g', 'Gram', 'WEIGHT', true, 1],
    ['kg', 'Kilogram', 'WEIGHT', false, 1000],
    ['mg', 'Milligram', 'WEIGHT', false, 0.001],
    ['ml', 'Millilitre', 'VOLUME', true, 1],
    ['L', 'Litre', 'VOLUME', false, 1000],
    ['cm', 'Centimetre', 'LENGTH', false, 10],
    ['m', 'Metre', 'LENGTH', false, 1000],
    ['pcs', 'Piece', 'COUNT', true, 1],
    ['dozen', 'Dozen', 'COUNT', false, 12],
    ['pack', 'Pack', 'COUNT', false, 1],
    ['box', 'Box', 'COUNT', false, 1],
    ['carton', 'Carton', 'COUNT', false, 1],
    ['bag', 'Bag', 'COUNT', false, 1],
    ['set', 'Set', 'COUNT', false, 1],
  ];

  const unitsBySymbol = new Map<string, any>();
  for (const [symbol, name, groupCode, isBase, factor] of SYSTEM_UNITS) {
    const unitGroupId = byGroupCode.get(groupCode);
    if (!unitGroupId) continue;

    let unit = await prisma.unit.findFirst({
      where: { unitGroupId, symbol },
    });
    if (!unit) {
      unit = await prisma.unit.create({
        data: {
          unitGroupId,
          name,
          symbol,
          isBaseUnit: isBase,
          conversionToGroupBase: factor,
          isActive: true,
        },
      });
    }
    unitsBySymbol.set(symbol.toLowerCase(), unit);
  }

  // 3. Find Grocery Tenant
  const tenant = await prisma.tenant.findFirst({
    where: {
      OR: [
        { slug: 'grocery-demo' },
        { name: { contains: 'Grocery', mode: 'insensitive' } },
      ],
    },
    include: { locations: true },
  });

  if (!tenant || !tenant.locations.length) {
    console.error('Grocery tenant or location not found!');
    return;
  }

  const tenantId = tenant.id;
  const locationId = tenant.locations[0].id;
  console.log(`Target Tenant: ${tenant.name} (${tenantId})`);

  // Helper to ensure category
  async function getCategory(name: string) {
    let cat = await prisma.category.findFirst({
      where: { tenantId, name: { equals: name, mode: 'insensitive' } },
    });
    if (!cat) {
      cat = await prisma.category.create({
        data: { tenantId, name },
      });
    }
    return cat;
  }

  const catChocolates = await getCategory('Confectionery');
  const catFruits = await getCategory('Fresh Fruits');
  const catOil = await getCategory('Oils & Ghee');
  const catBiscuits = await getCategory('Snacks & Biscuits');
  const catEggs = await getCategory('Dairy & Eggs');

  const pcsUnit = unitsBySymbol.get('pcs');
  const boxUnit = unitsBySymbol.get('box');
  const cartonUnit = unitsBySymbol.get('carton');
  const packUnit = unitsBySymbol.get('pack');
  const dozenUnit = unitsBySymbol.get('dozen');
  const kgUnit = unitsBySymbol.get('kg');
  const gUnit = unitsBySymbol.get('g');
  const LUnit = unitsBySymbol.get('l');
  const mlUnit = unitsBySymbol.get('ml');

  const DEMO_PRODUCTS = [
    {
      skuCode: 'GRC-CAD-SILK-BOX',
      barcode: '8901234567890',
      name: 'Cadbury Dairy Milk Silk (Box of 24)',
      categoryId: catChocolates.id,
      baseUnit: pcsUnit,
      pricingUnit: boxUnit,
      basePrice: 150, // 150 per pc
      costPrice: 110,
      taxCode: '1806',
      stockQty: 120, // 5 boxes
      sellUnit: 'box',
      packSize: 'Box of 24 pcs',
      productUnits: [
        { unit: pcsUnit, conversionToBase: 1, fixedPrice: 150, isDefault: false },
        { unit: boxUnit, conversionToBase: 24, fixedPrice: 3400, isDefault: true }, // ₹3400 per box (discounted from 3600)
      ],
      stockPrice: 3400,
    },
    {
      skuCode: 'GRC-APPLE-FUJI-BOX',
      barcode: '8902345678901',
      name: 'Fresh Fuji Red Apples (Box / Kg)',
      categoryId: catFruits.id,
      baseUnit: kgUnit,
      pricingUnit: boxUnit,
      basePrice: 180, // 180 per kg
      costPrice: 130,
      taxCode: '0808',
      stockQty: 50, // 50 kg = 5 boxes
      sellUnit: 'box',
      packSize: '10 kg Box',
      productUnits: [
        { unit: kgUnit, conversionToBase: 1, fixedPrice: 180, isDefault: false },
        { unit: gUnit, conversionToBase: 0.001, fixedPrice: 0.18, isDefault: false },
        { unit: boxUnit, conversionToBase: 10, fixedPrice: 1700, isDefault: true },
      ],
      stockPrice: 1700,
    },
    {
      skuCode: 'GRC-OIL-SUN-1L',
      barcode: '8903456789012',
      name: 'Fortune Sunflower Oil 1L (Carton of 12)',
      categoryId: catOil.id,
      baseUnit: LUnit,
      pricingUnit: cartonUnit,
      basePrice: 165, // 165 per Litre
      costPrice: 135,
      taxCode: '1512',
      stockQty: 60, // 60 L = 5 cartons
      sellUnit: 'carton',
      packSize: '12 Litres Carton',
      productUnits: [
        { unit: LUnit, conversionToBase: 1, fixedPrice: 165, isDefault: false },
        { unit: mlUnit, conversionToBase: 0.001, fixedPrice: 0.165, isDefault: false },
        { unit: cartonUnit, conversionToBase: 12, fixedPrice: 1920, isDefault: true },
      ],
      stockPrice: 1920,
    },
    {
      skuCode: 'GRC-OREO-PK12',
      barcode: '8904567890123',
      name: 'Oreo Chocolate Cream Biscuits (Pack of 12)',
      categoryId: catBiscuits.id,
      baseUnit: pcsUnit,
      pricingUnit: packUnit,
      basePrice: 30, // 30 per pc
      costPrice: 22,
      taxCode: '1905',
      stockQty: 120, // 10 packs
      sellUnit: 'pack',
      packSize: 'Pack of 12 pcs',
      productUnits: [
        { unit: pcsUnit, conversionToBase: 1, fixedPrice: 30, isDefault: false },
        { unit: packUnit, conversionToBase: 12, fixedPrice: 340, isDefault: true },
      ],
      stockPrice: 340,
    },
    {
      skuCode: 'GRC-EGGS-FARM',
      barcode: '8905678901234',
      name: 'Farm Fresh Brown Eggs (Dozen / Tray)',
      categoryId: catEggs.id,
      baseUnit: pcsUnit,
      pricingUnit: dozenUnit,
      basePrice: 7, // 7 per egg
      costPrice: 5,
      taxCode: '0407',
      stockQty: 300, // 25 dozen
      sellUnit: 'dozen',
      packSize: '12 pcs per Dozen',
      productUnits: [
        { unit: pcsUnit, conversionToBase: 1, fixedPrice: 7, isDefault: false },
        { unit: dozenUnit, conversionToBase: 12, fixedPrice: 80, isDefault: true },
        { unit: boxUnit, conversionToBase: 30, fixedPrice: 195, isDefault: false }, // Tray of 30 eggs
      ],
      stockPrice: 80,
    },
  ];

  for (const p of DEMO_PRODUCTS) {
    if (!p.baseUnit || !p.pricingUnit) {
      console.warn(`Skipping ${p.name} — unit missing`);
      continue;
    }

    const existing = await prisma.product.findFirst({
      where: { tenantId, skuCode: p.skuCode },
    });

    let productId: string;
    if (existing) {
      productId = existing.id;
      console.log(`Product ${p.skuCode} already exists. Updating ProductUnits & StockLevel...`);
      await prisma.product.update({
        where: { id: productId },
        data: {
          baseUnitId: p.baseUnit.id,
          pricingUnitId: p.pricingUnit.id,
          basePrice: p.basePrice,
          costPrice: p.costPrice,
        },
      });
    } else {
      const created = await prisma.product.create({
        data: {
          tenantId,
          categoryId: p.categoryId,
          name: p.name,
          skuCode: p.skuCode,
          barcode: p.barcode,
          basePrice: p.basePrice,
          costPrice: p.costPrice,
          taxCode: p.taxCode,
          kind: 'physical',
          fulfillmentMode: 'sale',
          trackQty: true,
          trackSerial: false,
          trackBatch: false,
          baseUnitId: p.baseUnit.id,
          pricingUnitId: p.pricingUnit.id,
          pricingStrategy: 'converted',
          meta: {
            sellUnit: p.sellUnit,
            packSize: p.packSize,
            taxRatePercent: 5,
            photoUrl: 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=400&q=80',
          },
        },
      });
      productId = created.id;
      console.log(`✨ Created product ${p.name} (${p.skuCode})`);
    }

    // Upsert ProductUnits
    for (const pu of p.productUnits) {
      const existingPu = await prisma.productUnit.findFirst({
        where: { tenantId, productId, unitId: pu.unit.id },
      });
      if (existingPu) {
        await prisma.productUnit.update({
          where: { id: existingPu.id },
          data: {
            conversionToBase: pu.conversionToBase,
            fixedPrice: pu.fixedPrice,
            isDefaultSellingUnit: pu.isDefault,
          },
        });
      } else {
        await prisma.productUnit.create({
          data: {
            tenantId,
            productId,
            unitId: pu.unit.id,
            conversionToBase: pu.conversionToBase,
            fixedPrice: pu.fixedPrice,
            isDefaultSellingUnit: pu.isDefault,
          },
        });
      }
    }

    // Upsert StockLevel
    await prisma.stockLevel.upsert({
      where: {
        tenantId_locationId_productId_variantKey: {
          tenantId,
          locationId,
          productId,
          variantKey: '',
        },
      },
      create: {
        tenantId,
        locationId,
        productId,
        variantKey: '',
        sku: p.skuCode,
        sellPrice: p.stockPrice,
        qtyOnHand: p.stockQty,
        sellUnit: p.sellUnit,
      },
      update: {
        qtyOnHand: p.stockQty,
        sellPrice: p.stockPrice,
        sellUnit: p.sellUnit,
      },
    });

    console.log(`   └─ Linked units (${p.productUnits.map((u) => u.unit.symbol).join(', ')}) & StockLevel: ${p.stockQty} ${p.baseUnit.symbol}`);
  }

  console.log('✅ Universal unit products seeded successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
