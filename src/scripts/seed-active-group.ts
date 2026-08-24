import { PrismaClient, PaymentMethod } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Checking active business groups and tenants ---');
  const groups = await prisma.businessGroup.findMany({
    include: {
      tenants: {
        include: {
          locations: true,
          users: true,
        },
      },
    },
  });

  console.log(`Found ${groups.length} business groups.`);
  for (const g of groups) {
    console.log(`Group: ${g.name} (id: ${g.id})`);
    for (const t of g.tenants) {
      console.log(`  - Tenant: ${t.name} (id: ${t.id}, slug: ${t.slug}, locations: ${t.locations.length})`);
    }
  }

  // Seed sample products, expenses, closed orders, and approval requests for all tenants
  for (const g of groups) {
    for (const tenant of g.tenants) {
      const loc = tenant.locations[0];
      const user = tenant.users[0];
      if (!loc || !user) continue;

      console.log(`\nSeeding realistic demo data for tenant: ${tenant.name}...`);

      // 1. Create Categories & Products
      const cat = await prisma.category.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: 'General Merchandise' } },
        create: { tenantId: tenant.id, name: 'General Merchandise' },
        update: {},
      });

      const demoProducts = [
        { name: `${tenant.name} Premium Item A`, sku: `${tenant.slug.slice(0, 3).toUpperCase()}-101`, price: 499, cost: 250, qty: 50 },
        { name: `${tenant.name} Standard Item B`, sku: `${tenant.slug.slice(0, 3).toUpperCase()}-102`, price: 899, cost: 450, qty: 40 },
        { name: `${tenant.name} Economy Item C`, sku: `${tenant.slug.slice(0, 3).toUpperCase()}-103`, price: 299, cost: 120, qty: 80 },
        { name: `${tenant.name} Value Pack D`, sku: `${tenant.slug.slice(0, 3).toUpperCase()}-104`, price: 1499, cost: 800, qty: 25 },
        { name: `${tenant.name} Express Item E`, sku: `${tenant.slug.slice(0, 3).toUpperCase()}-105`, price: 199, cost: 80, qty: 100 },
      ];

      const stockRows: Array<{ productId: string; stockLevelId: string; price: number; name: string; sku: string }> = [];

      for (const dp of demoProducts) {
        const prod = await prisma.product.upsert({
          where: { tenantId_skuCode: { tenantId: tenant.id, skuCode: dp.sku } },
          create: {
            tenantId: tenant.id,
            categoryId: cat.id,
            name: dp.name,
            skuCode: dp.sku,
            basePrice: dp.price,
            costPrice: dp.cost,
            kind: 'physical',
            fulfillmentMode: 'sale',
            trackQty: true,
            status: 'active',
            isActive: true,
            availableInPos: true,
            unitOfMeasure: 'pcs',
          },
          update: {
            name: dp.name,
            basePrice: dp.price,
            costPrice: dp.cost,
            status: 'active',
            isActive: true,
          },
        });

        const level = await prisma.stockLevel.upsert({
          where: { tenantId_locationId_sku: { tenantId: tenant.id, locationId: loc.id, sku: dp.sku } },
          create: {
            tenantId: tenant.id,
            locationId: loc.id,
            productId: prod.id,
            sku: dp.sku,
            sellUnit: 'pcs',
            qtyOnHand: dp.qty,
            sellPrice: dp.price.toFixed(2),
          },
          update: {
            qtyOnHand: dp.qty,
            sellPrice: dp.price.toFixed(2),
          },
        });

        stockRows.push({
          productId: prod.id,
          stockLevelId: level.id,
          price: dp.price,
          name: prod.name,
          sku: prod.skuCode,
        });
      }

      // 2. Create Expenses
      const expCat = await prisma.expenseCategory.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: 'Operations & Rent' } },
        create: { tenantId: tenant.id, name: 'Operations & Rent', sortOrder: 1 },
        update: {},
      });

      const daysAgo = (n: number) => {
        const d = new Date();
        d.setDate(d.getDate() - n);
        return d;
      };

      const existingExp = await prisma.expense.findFirst({ where: { tenantId: tenant.id } });
      if (!existingExp) {
        await prisma.expense.createMany({
          data: [
            {
              tenantId: tenant.id,
              locationId: loc.id,
              categoryId: expCat.id,
              expenseNumber: `EXP-${tenant.slug.slice(0, 3).toUpperCase()}-001`,
              amount: 15000,
              spentAt: daysAgo(5),
              paymentMethod: 'bank_transfer',
              payee: 'Commercial Real Estate',
              status: 'approved',
              createdById: user.id,
              notes: 'Monthly store lease',
            },
            {
              tenantId: tenant.id,
              locationId: loc.id,
              categoryId: expCat.id,
              expenseNumber: `EXP-${tenant.slug.slice(0, 3).toUpperCase()}-002`,
              amount: 3200,
              spentAt: daysAgo(2),
              paymentMethod: 'cash',
              payee: 'Packaging & Utilities',
              status: 'approved',
              createdById: user.id,
              notes: 'Boxes, electricity & cleaning',
            },
          ],
        });
      }

      // 3. Create Closed Orders (Today, Yesterday, Last week, etc.)
      const existingOrders = await prisma.order.count({ where: { tenantId: tenant.id } });
      if (existingOrders < 5 && stockRows.length > 0) {
        const orderSpecs = [
          { daysAgo: 0, items: [0, 1], method: PaymentMethod.cash }, // Today
          { daysAgo: 0, items: [2, 3], method: PaymentMethod.upi },  // Today
          { daysAgo: 1, items: [1, 2, 4], method: PaymentMethod.card }, // Yesterday
          { daysAgo: 2, items: [0, 3], method: PaymentMethod.upi },
          { daysAgo: 4, items: [1, 4], method: PaymentMethod.cash },
          { daysAgo: 7, items: [2, 3, 4], method: PaymentMethod.card },
          { daysAgo: 12, items: [0, 1, 2, 3], method: PaymentMethod.upi },
        ];

        for (let i = 0; i < orderSpecs.length; i++) {
          const spec = orderSpecs[i];
          const lines = spec.items.map((idx) => stockRows[idx % stockRows.length]);
          let subtotal = 0;
          const orderLines = lines.map((item, lineIdx) => {
            const qty = 1 + (lineIdx % 2);
            const lineSub = item.price * qty;
            subtotal += lineSub;
            return {
              tenantId: tenant.id,
              itemKind: 'product' as const,
              productId: item.productId,
              stockLevelId: item.stockLevelId,
              description: item.name,
              quantity: qty,
              unitPrice: item.price,
              lineTotal: Math.round(lineSub * 1.05 * 100) / 100,
              taxAmount: Math.round(lineSub * 0.05 * 100) / 100,
            };
          });

          const taxTotal = Math.round(subtotal * 0.05 * 100) / 100;
          const grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;
          const orderDate = daysAgo(spec.daysAgo);
          const orderNumber = `ORD-${tenant.slug.slice(0, 3).toUpperCase()}-${1000 + i}`;

          await prisma.order.create({
            data: {
              tenantId: tenant.id,
              locationId: loc.id,
              createdById: user.id,
              orderNumber,
              kind: 'sale',
              status: 'closed',
              currencyCode: tenant.currencyCode || 'INR',
              subtotal,
              discountTotal: 0,
              depositTotal: 0,
              taxTotal,
              balanceDue: 0,
              createdAt: orderDate,
              updatedAt: orderDate,
              items: {
                create: orderLines,
              },
              payments: {
                create: {
                  tenantId: tenant.id,
                  locationId: loc.id,
                  type: 'payment',
                  method: spec.method,
                  status: 'succeeded',
                  amount: grandTotal,
                  currencyCode: tenant.currencyCode || 'INR',
                  idempotencyKey: `seed-${orderNumber}`,
                  takenByUserId: user.id,
                  createdAt: orderDate,
                },
              },
            },
          });
        }
        console.log(`Seeded ${orderSpecs.length} completed orders for ${tenant.name}`);
      }

      // 4. Create an Approval request for testing Approvals tab
      const existingReq = await prisma.approvalRequest.findFirst({
        where: { businessGroupId: g.id },
      });
      if (!existingReq) {
        await prisma.approvalRequest.create({
          data: {
            businessGroupId: g.id,
            tenantId: tenant.id,
            entityType: 'order',
            requestedById: user.id,
            type: 'discount',
            status: 'pending',
            currentStep: 0,
            amount: 450,
            reason: 'Customer VIP promotional discount (20%)',
            payload: {
              amount: 450,
              percent: 20,
              reason: 'Customer VIP promotional discount (20%)',
              sku: stockRows[0]?.sku,
            },
            steps: {
              create: [
                {
                  stepIndex: 0,
                  status: 'pending',
                  note: 'owner',
                },
              ],
            },
          },
        });
        console.log(`Created sample pending approval request for group ${g.name}`);
      }
    }
  }

  console.log('\n✅ Demo seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('Seeding error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
