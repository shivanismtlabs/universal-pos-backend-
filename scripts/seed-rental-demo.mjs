/**
 * Create a rental demo shop with sample inventory across categories, then smoke-test.
 *
 * Usage: node scripts/seed-rental-demo.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const SUFFIX = Date.now().toString(36).toUpperCase();
const SLUG = `rent-demo-${Date.now().toString(36)}`;
const EMAIL = `owner@${SLUG}.test`;
const PASSWORD = 'RentDemo@2026!';
const SHOP = `Rent Demo ${SUFFIX}`;

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json.data ?? json;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CATALOG = [
  {
    category: 'Clothes',
    products: [
      {
        title: 'Midnight Tuxedo',
        sku: 'CLO-TX-001',
        rentalPrice: 150,
        deposit: 75,
        variants: [
          { barcode: `CLO-TX-40R-${SUFFIX}`, variant: '40R' },
          { barcode: `CLO-TX-42R-${SUFFIX}`, variant: '42R' },
          { barcode: `CLO-TX-44L-${SUFFIX}`, variant: '44L' },
        ],
      },
      {
        title: 'Ivory Wedding Gown',
        sku: 'CLO-GW-001',
        rentalPrice: 220,
        deposit: 100,
        variants: [
          { barcode: `CLO-GW-S-${SUFFIX}`, variant: 'S' },
          { barcode: `CLO-GW-M-${SUFFIX}`, variant: 'M' },
        ],
      },
      {
        title: 'Navy Dinner Jacket',
        sku: 'CLO-DJ-001',
        rentalPrice: 95,
        deposit: 50,
        variants: [
          { barcode: `CLO-DJ-40R-${SUFFIX}`, variant: '40R' },
          { barcode: `CLO-DJ-42R-${SUFFIX}`, variant: '42R' },
        ],
      },
    ],
  },
  {
    category: 'Bikes',
    products: [
      {
        title: 'City Cruiser Bike',
        sku: 'BIK-CC-001',
        rentalPrice: 35,
        deposit: 100,
        variants: [
          { barcode: `BIK-CC-A1-${SUFFIX}`, variant: 'Frame A1' },
          { barcode: `BIK-CC-A2-${SUFFIX}`, variant: 'Frame A2' },
          { barcode: `BIK-CC-A3-${SUFFIX}`, variant: 'Frame A3' },
        ],
      },
      {
        title: 'Mountain Trail Bike',
        sku: 'BIK-MT-001',
        rentalPrice: 55,
        deposit: 150,
        variants: [
          { barcode: `BIK-MT-B1-${SUFFIX}`, variant: 'Frame B1' },
          { barcode: `BIK-MT-B2-${SUFFIX}`, variant: 'Frame B2' },
        ],
      },
    ],
  },
  {
    category: 'Cars',
    products: [
      {
        title: 'Compact Sedan',
        sku: 'CAR-SD-001',
        rentalPrice: 65,
        deposit: 300,
        variants: [
          { barcode: `CAR-SD-V1-${SUFFIX}`, variant: 'VIN-DEMO-001' },
          { barcode: `CAR-SD-V2-${SUFFIX}`, variant: 'VIN-DEMO-002' },
        ],
      },
      {
        title: 'SUV Weekend',
        sku: 'CAR-SUV-001',
        rentalPrice: 95,
        deposit: 400,
        variants: [{ barcode: `CAR-SUV-V1-${SUFFIX}`, variant: 'VIN-DEMO-010' }],
      },
    ],
  },
  {
    category: 'Home',
    products: [
      {
        title: 'Party Tent 10x20',
        sku: 'HOM-TN-001',
        rentalPrice: 120,
        deposit: 200,
        variants: [
          { barcode: `HOM-TN-01-${SUFFIX}`, variant: 'Unit 01' },
          { barcode: `HOM-TN-02-${SUFFIX}`, variant: 'Unit 02' },
        ],
      },
      {
        title: 'Sound System Pro',
        sku: 'HOM-SS-001',
        rentalPrice: 80,
        deposit: 150,
        variants: [{ barcode: `HOM-SS-01-${SUFFIX}`, variant: 'Kit A' }],
      },
    ],
  },
];

async function main() {
  console.log('\n=== Seed rental demo shop ===\n');
  console.log(`API: ${API}`);
  console.log(`Shop: ${SHOP}`);
  console.log(`Slug: ${SLUG}`);
  console.log(`Login: ${EMAIL} / ${PASSWORD}\n`);

  // 1) Register tenant
  const reg = await req('/auth/register-tenant', {
    method: 'POST',
    body: {
      tenantName: SHOP,
      tenantSlug: SLUG,
      storeName: 'Main',
      adminFullName: 'Rental Demo Owner',
      adminEmail: EMAIL,
      adminPassword: PASSWORD,
      adminPhone: '9876500001',
    },
  });
  let token = reg.accessToken;
  assert(token, 'no accessToken from register');
  console.log('✓ registered');

  // 2) Choose rental once
  await req('/tenants/me/commerce-modes', {
    method: 'POST',
    token,
    body: {
      mode: 'rental',
      shopTitle: SHOP,
      tagline: 'Universal rental POS',
    },
  });
  console.log('✓ commerce mode = rental');

  const locsRaw = await req('/locations', { token });
  const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
  const loc = locs[0];
  assert(loc?.id, 'no location');
  console.log(`✓ location: ${loc.name || loc.id}`);

  // 3) Seed categories + products + units
  let productCount = 0;
  let unitCount = 0;
  const first = { barcode: null, productId: null, unitId: null, price: 0 };

  for (const block of CATALOG) {
    const cat = await req('/pos/rental/categories', {
      method: 'POST',
      token,
      body: { name: block.category },
    });
    console.log(`✓ category: ${cat.name}`);

    for (const p of block.products) {
      const created = await req('/pos/rental/products', {
        method: 'POST',
        token,
        body: {
          categoryId: cat.id,
          title: p.title,
          description: `${p.title} rental unit`,
          sku: `${p.sku}-${SUFFIX}`,
          rentalPrice: p.rentalPrice,
          deposit: p.deposit,
          barcode: p.variants[0].barcode,
          variant: p.variants[0].variant,
          locationId: loc.id,
        },
      });
      assert(created.product?.id && created.unit?.id, 'product+unit');
      productCount += 1;
      unitCount += 1;

      if (!first.barcode) {
        first.barcode = p.variants[0].barcode;
        first.productId = created.product.id;
        first.unitId = created.unit.id;
        first.price = p.rentalPrice;
      }

      for (let i = 1; i < p.variants.length; i++) {
        const v = p.variants[i];
        await req('/pos/rental/units', {
          method: 'POST',
          token,
          body: {
            productId: created.product.id,
            barcode: v.barcode,
            variant: v.variant,
            locationId: loc.id,
          },
        });
        unitCount += 1;
      }
      console.log(`  · ${p.title} (${p.variants.length} units)`);
    }
  }

  // 4) Verify floor + catalog
  const floor = await req('/pos/rental/floor', { token });
  assert(floor.locationId, 'floor locationId');
  assert(
    Array.isArray(floor.schema?.categoryExamples) &&
      floor.schema.categoryExamples.length >= 4,
    'categoryExamples present',
  );
  console.log(
    `\n✓ floor ready (examples: ${floor.schema.categoryExamples.slice(0, 4).join(', ')})`,
  );

  const catalog = await req('/pos/rental/catalog', { token });
  const items = catalog.items ?? catalog ?? [];
  const itemLen = Array.isArray(items) ? items.length : 0;
  assert(itemLen >= productCount, `catalog items expected ≥${productCount}`);
  console.log(`✓ catalog: ${itemLen} items`);

  // 5) Quick rent → pay → checkout → return smoke
  const customer = await req('/customers', {
    method: 'POST',
    token,
    body: {
      fullName: 'Demo Renter',
      phone: '9123456789',
      email: `renter-${SUFFIX.toLowerCase()}@example.com`,
    },
  });
  assert(customer.id, 'customer id');

  const lookup = await req(
    `/pos/rental/lookup?barcode=${encodeURIComponent(first.barcode)}`,
    { token },
  );
  assert(lookup.id || lookup.unit?.id || lookup.product?.id, 'lookup hit');

  const today = new Date();
  const pickup = today.toISOString().slice(0, 10);
  const retDue = new Date(today.getTime() + 3 * 86400000)
    .toISOString()
    .slice(0, 10);

  const order = await req('/orders', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      customerId: customer.id,
      kind: 'rental',
      pickupDate: pickup,
      returnDueDate: retDue,
      items: [
        {
          itemKind: 'stock_unit',
          stockUnitId: first.unitId,
          unitPrice: first.price,
        },
      ],
    },
  });
  const orderId = order.id;
  assert(orderId, 'order id');

  await req(`/orders/${orderId}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'reserved' },
  });
  await req(`/orders/${orderId}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'ready' },
  });

  await req('/payments', {
    method: 'POST',
    token,
    body: {
      orderId,
      method: 'cash',
      amount: first.price,
      type: 'payment',
      idempotencyKey: `seed-pay-${SUFFIX}`,
    },
  });

  await req(`/orders/${orderId}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'checked_out' },
  });
  console.log(`✓ demo order checked out: ${orderId}`);

  const ret = await req('/returns', {
    method: 'POST',
    token,
    body: {
      orderId,
      stockUnitId: first.unitId,
      cleaningRequired: true,
      inspectNotes: 'Seed return',
    },
  });
  assert(ret.id, 'return created');

  await req(`/returns/${ret.id}/inspect`, {
    method: 'POST',
    token,
    body: { inspectStatus: 'needs_cleaning' },
  });
  await req(`/returns/${ret.id}/cleaning/complete`, {
    method: 'POST',
    token,
  });

  const cur = await req(`/orders/${orderId}`, { token });
  const lc = cur.rentalExt?.lifecycle;
  if (lc === 'returned') {
    await req(`/orders/${orderId}/rental-lifecycle`, {
      method: 'POST',
      token,
      body: { lifecycle: 'inspected' },
    });
  } else if (lc !== 'inspected' && lc !== 'closed') {
    await req(`/orders/${orderId}/rental-lifecycle`, {
      method: 'POST',
      token,
      body: { lifecycle: 'returned' },
    });
    await req(`/orders/${orderId}/rental-lifecycle`, {
      method: 'POST',
      token,
      body: { lifecycle: 'inspected' },
    });
  }
  await req(`/orders/${orderId}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'closed' },
  });
  console.log('✓ return → inspect → clean → closed');

  // 6) Availability + re-login
  const avail = await req(
    `/pos/rental/availability?productId=${first.productId}&from=${pickup}&to=${retDue}`,
    { token },
  );
  assert(typeof avail.availableCount === 'number', 'availability');
  console.log(`✓ availability: ${avail.availableCount} free for window`);

  const login = await req('/auth/login', {
    method: 'POST',
    body: { tenantSlug: SLUG, email: EMAIL, password: PASSWORD },
  });
  assert(login.accessToken, 're-login token');
  console.log('✓ re-login OK');

  console.log('\n========================================');
  console.log('RENTAL DEMO READY');
  console.log('========================================');
  console.log(`Shop:     ${SHOP}`);
  console.log(`Slug:     ${SLUG}`);
  console.log(`Email:    ${EMAIL}`);
  console.log(`Password: ${PASSWORD}`);
  console.log(`Mode:     RENTAL`);
  console.log(
    `Seeded:   ${CATALOG.length} categories, ${productCount} products, ${unitCount} units`,
  );
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
