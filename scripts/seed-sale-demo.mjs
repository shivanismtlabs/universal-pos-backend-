/**
 * Create a sale demo shop with sample inventory, then smoke checkout/register/return.
 *
 * Usage: node scripts/seed-sale-demo.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const SUFFIX = Date.now().toString(36).toUpperCase();
const SLUG = `sale-demo-${Date.now().toString(36)}`;
const EMAIL = `owner@${SLUG}.test`;
const PASSWORD = 'SaleDemo@2026!';
const SHOP = `Sale Demo ${SUFFIX}`;

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
  return json.data !== undefined ? json.data : json;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const CATALOG = [
  {
    category: 'Electronics',
    products: [
      { title: 'USB-C Cable 1m', sku: 'EL-USB-1M', price: 199, qty: 40 },
      { title: 'Wireless Mouse', sku: 'EL-MSE-01', price: 799, qty: 25 },
      { title: 'Phone Stand', sku: 'EL-STD-01', price: 349, qty: 30 },
    ],
  },
  {
    category: 'Grocery',
    products: [
      { title: 'Mineral Water 1L', sku: 'GR-WTR-1L', price: 20, qty: 100 },
      { title: 'Snack Pack', sku: 'GR-SNK-01', price: 45, qty: 80 },
    ],
  },
  {
    category: 'Accessories',
    products: [
      { title: 'Cap Classic', sku: 'AC-CAP-01', price: 299, qty: 20 },
      { title: 'Tote Bag', sku: 'AC-BAG-01', price: 499, qty: 15 },
    ],
  },
  {
    category: 'Chemicals',
    products: [
      { title: 'Pool Chlorine 1kg', sku: 'CH-CL-1K', price: 650, qty: 12 },
      { title: 'Surface Cleaner', sku: 'CH-CLN-01', price: 180, qty: 35 },
    ],
  },
];

async function main() {
  console.log('\n=== Seed sale demo shop ===\n');
  console.log(`API: ${API}`);
  console.log(`Shop: ${SHOP}`);
  console.log(`Slug: ${SLUG}`);
  console.log(`Login: ${EMAIL} / ${PASSWORD}\n`);

  const reg = await req('/auth/register-tenant', {
    method: 'POST',
    body: {
      tenantName: SHOP,
      tenantSlug: SLUG,
      storeName: 'Main',
      adminFullName: 'Sale Demo Owner',
      adminEmail: EMAIL,
      adminPassword: PASSWORD,
      adminPhone: '9876500002',
    },
  });
  let token = reg.accessToken;
  assert(token, 'no accessToken');
  console.log('✓ registered');

  await req('/tenants/me/commerce-modes', {
    method: 'POST',
    token,
    body: {
      mode: 'sale',
      shopTitle: SHOP,
      tagline: 'Universal sale POS',
    },
  });
  console.log('✓ commerce mode = sale');

  const locsRaw = await req('/locations', { token });
  const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
  const loc = locs[0];
  assert(loc?.id, 'no location');
  console.log(`✓ location: ${loc.name || loc.id}`);

  const schema = await req('/pos/sale/schema', { token });
  assert(schema.mode === 'sale', 'sale schema');
  console.log(
    `✓ schema fields: ${(schema.fields ?? []).map((f) => f.key).join(',')}`,
  );

  let productCount = 0;
  const stock = [];

  for (const block of CATALOG) {
    const cat = await req('/pos/sale/categories', {
      method: 'POST',
      token,
      body: { name: block.category },
    });
    console.log(`✓ category: ${cat.name}`);

    for (const p of block.products) {
      const created = await req('/pos/sale/products', {
        method: 'POST',
        token,
        body: {
          title: p.title,
          description: `${p.title} for retail sale`,
          categoryId: cat.id,
          sku: `${p.sku}-${SUFFIX}`,
          price: p.price,
          qty: p.qty,
          locationId: loc.id,
        },
      });
      const stockLevelId =
        created.stockLevel?.id ?? created.posItem?.id ?? created.product?.id;
      assert(stockLevelId, `stock for ${p.title}`);
      stock.push({
        title: p.title,
        sku: `${p.sku}-${SUFFIX}`,
        price: p.price,
        stockLevelId,
        productId: created.product?.id,
      });
      productCount += 1;
      console.log(`  · ${p.title} @ ${p.price} × ${p.qty}`);
    }
  }

  const floor = await req('/pos/sale/floor', { token });
  assert(floor.locationId, 'floor location');
  console.log(
    `\n✓ floor: categories=${floor.counts?.categories ?? '?'} products=${floor.counts?.products ?? productCount}`,
  );

  const catalog = await req('/pos/sale/catalog', { token });
  const items = catalog.items ?? catalog ?? [];
  assert(
    (Array.isArray(items) ? items.length : 0) >= productCount,
    'catalog size',
  );
  console.log(`✓ catalog: ${Array.isArray(items) ? items.length : 0} items`);

  // Lookup first SKU
  const first = stock[0];
  const lookup = await req(
    `/pos/sale/lookup?sku=${encodeURIComponent(first.sku)}&locationId=${loc.id}`,
    { token },
  );
  assert(lookup?.stockLevelId || lookup?.id || lookup?.sku, 'lookup hit');
  console.log(`✓ lookup: ${first.sku}`);

  // Register + cash checkout with discount
  const session = await req('/pos/sale/register/open', {
    method: 'POST',
    token,
    body: { locationId: loc.id, openingFloat: 2000 },
  });
  assert(session.id, 'register open');
  console.log('✓ register open');

  const line = stock[0];
  const line2 = stock[1];
  const subtotal = line.price * 2 + line2.price;
  const discount = 50;
  const due = subtotal - discount;

  const sale = await req('/pos/sale/checkout', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      items: [
        { stockLevelId: line.stockLevelId, quantity: 2, unitPrice: line.price },
        {
          stockLevelId: line2.stockLevelId,
          quantity: 1,
          unitPrice: line2.price,
        },
      ],
      discountAmount: discount,
      payments: [
        {
          method: 'cash',
          amount: due,
          idempotencyKey: `seed-sale-${SUFFIX}`,
        },
      ],
      cashTendered: due + 100,
    },
  });
  const orderId = sale.order?.id ?? sale.id;
  assert(orderId, 'sale order');
  console.log(`✓ checkout cash+discount: ${sale.order?.orderNumber ?? orderId}`);

  // Park / resume / discard (match smoke API)
  const parked = await req('/pos/sale/park', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      items: [{ stockLevelId: stock[2].stockLevelId, quantity: 1 }],
      label: 'Seed hold',
    },
  });
  assert(parked.id, 'park id');
  const parkedList = await req(
    `/pos/sale/parked?locationId=${loc.id}`,
    { token },
  );
  assert(
    (parkedList.items ?? []).some((o) => o.id === parked.id),
    'parked list',
  );
  const resumed = await req(`/pos/sale/parked/${parked.id}/resume`, {
    method: 'POST',
    token,
  });
  assert((resumed.cart?.length ?? 0) >= 1 || resumed.id, 'resume');
  await req(`/pos/sale/parked/${parked.id}/discard`, {
    method: 'POST',
    token,
  });
  console.log('✓ park → resume → discard');

  const ret = await req('/pos/sale/returns', {
    method: 'POST',
    token,
    body: {
      orderId,
      items: [{ stockLevelId: line.stockLevelId, quantity: 1 }],
      refundMethod: 'cash',
      reason: 'Seed return',
      idempotencyKey: `seed-ret-${SUFFIX}`,
    },
  });
  assert(ret.refundPaymentId || ret.id || ret.amount != null, 'return ok');
  console.log('✓ qty return');

  // Close register
  await req(`/pos/sale/register/${session.id}/close`, {
    method: 'POST',
    token,
    body: { closingCash: 2000 + due, note: 'Seed EOD' },
  });
  console.log('✓ register close');

  const login = await req('/auth/login', {
    method: 'POST',
    body: { tenantSlug: SLUG, email: EMAIL, password: PASSWORD },
  });
  assert(login.accessToken, 're-login');
  console.log('✓ re-login OK');

  console.log('\n========================================');
  console.log('SALE DEMO READY');
  console.log('========================================');
  console.log(`Shop:     ${SHOP}`);
  console.log(`Slug:     ${SLUG}`);
  console.log(`Email:    ${EMAIL}`);
  console.log(`Password: ${PASSWORD}`);
  console.log(`Mode:     SALE`);
  console.log(
    `Seeded:   ${CATALOG.length} categories, ${productCount} products`,
  );
  console.log('========================================\n');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
