/**
 * Universal Sale POS — Zomato-style order flow smoke:
 * browse catalog → add lines → pay → stock down.
 *
 * Usage: node scripts/smoke-universal-zomato-flow.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const SUFFIX = Date.now().toString(36);
const SLUG = `universal-mart-${SUFFIX}`;
const EMAIL = `owner@${SLUG}.test`;
const PASSWORD = 'Universal@2026!';

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

function assert(c, m) {
  if (!c) throw new Error(m);
}

async function main() {
  console.log('=== 1. Create Universal Sale user ===');
  const reg = await req('/auth/register-tenant', {
    method: 'POST',
    body: {
      tenantName: 'Universal Mart',
      tenantSlug: SLUG,
      storeName: 'Main Counter',
      adminFullName: 'Mart Owner',
      adminEmail: EMAIL,
      adminPassword: PASSWORD,
      adminPhone: '9876501122',
    },
  });
  const token = reg.accessToken;
  assert(token, 'token');

  await req('/tenants/me/commerce-modes', {
    method: 'POST',
    token,
    body: { mode: 'sale', shopTitle: 'Universal Mart' },
  });

  await req('/tenants/me', {
    method: 'PATCH',
    token,
    body: {
      branding: {
        productName: 'Universal Mart',
        tagline: 'Any product · one counter',
      },
    },
  }).catch(() => null);

  const boot = await req('/tenants/me/bootstrap', { token });
  assert(boot.commerce?.modes?.includes('sale') || boot.tenant?.settings?.commerceModes?.includes('sale'), 'sale mode');
  const rentalOn = (boot.modules || []).some(
    (m) => m.code === 'rental' && m.status === 'enabled',
  );
  assert(!rentalOn, 'rental must be off');
  console.log('OK shop', SLUG, 'Sale mode');

  const locs = await req('/locations', { token });
  const loc = (Array.isArray(locs) ? locs : locs.items ?? [])[0];
  assert(loc?.id, 'location');

  console.log('=== 2. Menu categories + products (any industry) ===');
  const catA = await req('/pos/sale/categories', {
    method: 'POST',
    token,
    body: { name: 'Beverages' },
  });
  const catB = await req('/pos/sale/categories', {
    method: 'POST',
    token,
    body: { name: 'Snacks' },
  });
  const catC = await req('/pos/sale/categories', {
    method: 'POST',
    token,
    body: { name: 'Accessories' },
  });

  const menu = [
    { title: 'Cold Coffee', sku: 'BEV-COFFEE', price: 149, qty: 50, categoryId: catA.id },
    { title: 'Masala Chips', sku: 'SNK-CHIPS', price: 40, qty: 80, categoryId: catB.id },
    { title: 'USB Cable', sku: 'ACC-USB', price: 199, qty: 30, categoryId: catC.id },
  ];

  for (const p of menu) {
    await req('/pos/sale/products', {
      method: 'POST',
      token,
      body: {
        title: p.title,
        sku: p.sku,
        price: p.price,
        qty: p.qty,
        categoryId: p.categoryId,
        description: 'Universal demo item',
      },
    });
  }

  const catalog = await req('/pos/sale/catalog?limit=50', { token });
  const items = catalog.items ?? [];
  assert(items.length >= 3, 'catalog has menu items');
  console.log(
    'OK menu',
    items.map((i) => `${i.name} @ ${i.sellPrice}`).join(' | '),
  );

  console.log('=== 3. Zomato-style order: add 2+1 items → pay ===');
  await req('/pos/sale/register/open', {
    method: 'POST',
    token,
    body: { locationId: loc.id, openingFloat: 500 },
  });

  const coffee = items.find((i) => i.sku === 'BEV-COFFEE');
  const chips = items.find((i) => i.sku === 'SNK-CHIPS');
  assert(coffee && chips, 'coffee + chips in catalog');

  // prepare for tax-aware due (like seeing bill before pay)
  const prepared = await req('/pos/sale/prepare', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      items: [
        { stockLevelId: coffee.id, quantity: 2, unitPrice: Number(coffee.sellPrice) },
        { stockLevelId: chips.id, quantity: 1, unitPrice: Number(chips.sellPrice) },
      ],
    },
  });
  const due = Number(prepared.balanceDue);
  console.log('OK bill due', due, '(subtotal+tax)');

  // cancel prepare then real checkout (cash path commits stock)
  if (prepared.orderId) {
    await req(`/pos/sale/prepare/${prepared.orderId}/cancel`, {
      method: 'POST',
      token,
    }).catch(() => null);
  }

  const sale = await req('/pos/sale/checkout', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      items: [
        { stockLevelId: coffee.id, quantity: 2, unitPrice: Number(coffee.sellPrice) },
        { stockLevelId: chips.id, quantity: 1, unitPrice: Number(chips.sellPrice) },
      ],
      payments: [
        {
          method: 'cash',
          amount: due,
          idempotencyKey: `zomato-flow-${Date.now()}`,
        },
      ],
      cashTendered: due + 50,
    },
  });

  const orderNo = sale.order?.orderNumber || sale.orderNumber;
  console.log('OK order placed', orderNo, 'change', sale.change);

  const after = await req('/pos/sale/catalog?limit=50', { token });
  const coffeeAfter = (after.items ?? []).find((i) => i.id === coffee.id);
  assert(
    Number(coffeeAfter.qtyOnHand) === Number(coffee.qtyOnHand) - 2,
    'coffee stock reduced',
  );
  console.log('OK stock coffee', coffee.qtyOnHand, '→', coffeeAfter.qtyOnHand);

  console.log('=== 4. Sync endpoint (offline path) ===');
  const sync = await fetch(`${API}/sync/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(sync.status !== 404, 'sync mounted');
  console.log('OK sync status', sync.status);

  console.log('');
  console.log('========================================');
  console.log('UNIVERSAL ZOMATO-FLOW SMOKE: PASS');
  console.log('  Login in UI:');
  console.log('  slug:    ', SLUG);
  console.log('  email:   ', EMAIL);
  console.log('  password:', PASSWORD);
  console.log('  Flow: browse → ADD → ticket → Charge');
  console.log('========================================');
}

main().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
