/**
 * Universal rental E2E — register shop, add any categories (Dresses + Bikes),
 * rent → pay → checkout → exchange → return → inspect → clean → close.
 *
 * Usage: node scripts/smoke-universal-rental.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const SUFFIX = Date.now().toString(36);
const SLUG = `rent-hub-${SUFFIX}`;
const EMAIL = `owner@${SLUG}.test`;
const PASSWORD = 'RentHub@2026!';

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

async function main() {
  console.log('=== 1. Register rental tenant ===');
  const reg = await req('/auth/register-tenant', {
    method: 'POST',
    body: {
      tenantName: 'Universal Rent Hub',
      tenantSlug: SLUG,
      storeName: 'Main Hub',
      adminFullName: 'Rent Owner',
      adminEmail: EMAIL,
      adminPassword: PASSWORD,
      adminPhone: '9876500001',
    },
  });
  let token = reg.accessToken;
  assert(token, 'no accessToken from register');
  console.log('registered', SLUG, EMAIL);

  console.log('=== 2. Choose Rental mode ===');
  await req('/tenants/me/commerce-modes', {
    method: 'POST',
    token,
    body: {
      mode: 'rental',
      shopTitle: 'Universal Rent Hub',
      tagline: 'Dresses · Bikes · Anything',
    },
  });

  const boot = await req('/tenants/me/bootstrap', { token });
  const rentalMod = boot.modules?.find((m) => m.code === 'rental');
  assert(
    rentalMod?.status === 'enabled' ||
      boot.capabilities?.includes?.('rental') ||
      boot.nav?.some?.((n) => String(n.href || n.path || '').includes('return')),
    `rental module not enabled: ${JSON.stringify(rentalMod)}`,
  );
  console.log('bootstrap ok', boot.tenant?.branding?.productName ?? boot.tenant?.name);

  const locsRaw = await req('/locations', { token });
  const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
  const loc = locs.find((l) => l.code === 'MAIN') ?? locs[0];
  assert(loc?.id, 'no location');

  console.log('=== 3. Rental schema / floor ===');
  const schema = await req('/pos/rental/schema', { token });
  assert(schema.mode === 'rental', 'schema mode');
  assert(
    schema.fields?.some((f) => f.key === 'barcode'),
    'barcode field missing',
  );
  assert(
    schema.fields?.some((f) => f.key === 'variant' || f.key === 'size'),
    'variant field missing',
  );
  console.log(
    'schema fields',
    schema.fields.map((f) => f.key).join(', '),
  );

  const floor = await req('/pos/rental/floor', { token });
  assert(floor.locationId, 'floor location');

  console.log('=== 4. Dynamic categories (Dress + Bike) ===');
  const dresses = await req('/pos/rental/categories', {
    method: 'POST',
    token,
    body: { name: 'Dresses' },
  });
  const bikes = await req('/pos/rental/categories', {
    method: 'POST',
    token,
    body: { name: 'Bikes' },
  });
  console.log('categories', dresses.name, bikes.name);

  console.log('=== 5. Products + units (universal keys) ===');
  const dress = await req('/pos/rental/products', {
    method: 'POST',
    token,
    body: {
      title: 'Evening Gown',
      description: 'Formal dress rental',
      categoryId: dresses.id,
      sku: 'DRS-GOWN-1',
      rentalPrice: 2500,
      deposit: 1000,
      barcode: 'DRS-001',
      variant: 'M',
      locationId: loc.id,
    },
  });
  const dressUnit = dress.unit;
  assert(dressUnit?.id, 'dress unit');

  const dress2 = await req('/pos/rental/units', {
    method: 'POST',
    token,
    body: {
      productId: dress.product.id,
      barcode: 'DRS-002',
      variant: 'L',
      rentalPrice: 2500,
      deposit: 1000,
      locationId: loc.id,
    },
  });

  const bike = await req('/pos/rental/products', {
    method: 'POST',
    token,
    body: {
      title: 'Trail Bike',
      description: 'Mountain bike day rental',
      categoryId: bikes.id,
      sku: 'BIKE-TRAIL',
      rentalPrice: 800,
      deposit: 2000,
      barcode: 'BIKE-001',
      variant: 'Frame-M',
      locationId: loc.id,
    },
  });
  const bikeUnit = bike.unit;
  assert(bikeUnit?.id, 'bike unit');

  const bike2 = await req('/pos/rental/units', {
    method: 'POST',
    token,
    body: {
      productId: bike.product.id,
      barcode: 'BIKE-002',
      variant: 'Frame-L',
      locationId: loc.id,
    },
  });
  console.log(
    'units',
    dressUnit.barcodeSku,
    dress2.barcodeSku,
    bikeUnit.barcodeSku,
    bike2.barcodeSku,
  );

  const catalog = await req('/pos/rental/catalog', { token });
  assert(catalog.items?.length >= 4, `catalog expected ≥4, got ${catalog.items?.length}`);

  const lookup = await req('/pos/rental/lookup?barcode=BIKE-001', { token });
  assert(lookup.id === bikeUnit.id, 'lookup bike');

  console.log('=== 6. Customer ===');
  const customer = await req('/customers', {
    method: 'POST',
    token,
    body: {
      fullName: 'Alex Renter',
      phone: '9000010001',
      email: 'alex@example.com',
    },
  });

  console.log('=== 7. Rental order (dress + bike on one ticket) ===');
  const today = new Date();
  const pickup = today.toISOString().slice(0, 10);
  const retDue = new Date(today.getTime() + 2 * 86400000)
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
          stockUnitId: dressUnit.id,
          unitPrice: 2500,
        },
        {
          itemKind: 'stock_unit',
          stockUnitId: bikeUnit.id,
          unitPrice: 800,
        },
      ],
    },
  });
  console.log(
    'order',
    order.orderNumber,
    'lifecycle',
    order.rentalExt?.lifecycle,
    'due',
    order.balanceDue,
  );
  assert(Number(order.balanceDue) > 0, 'balanceDue should be > 0');

  console.log('=== 8. Reserve → pay → checkout ===');
  const reserved = await req(`/orders/${order.id}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'reserved' },
  });
  assert(reserved.rentalExt?.lifecycle === 'reserved', 'reserved');

  await req('/payments', {
    method: 'POST',
    token,
    body: {
      orderId: order.id,
      method: 'cash',
      amount: Number(order.balanceDue),
      idempotencyKey: `univ-rent-pay-${SUFFIX}`,
    },
  });

  const checkedOut = await req(`/orders/${order.id}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'checked_out' },
  });
  assert(checkedOut.rentalExt?.lifecycle === 'checked_out', 'checked_out');
  console.log('checked_out ok');

  console.log('=== 9. Exchange bike for spare ===');
  const exchanged = await req('/pos/rental/exchange', {
    method: 'POST',
    token,
    body: {
      orderId: order.id,
      fromStockUnitId: bikeUnit.id,
      toStockUnitId: bike2.id,
      reason: 'Customer preferred larger frame',
    },
  });
  assert(exchanged.toStockUnitId === bike2.id, 'exchange target');
  console.log('exchanged', bikeUnit.barcodeSku, '→', bike2.barcodeSku);

  const candidates = await req('/returns/candidates', { token });
  const cand = (candidates.items ?? []).find((o) => o.id === order.id);
  assert(cand, 'candidates should list checked-out order');
  const outIds = cand.unitsOut.map((u) => u.stockUnitId);
  assert(outIds.includes(dressUnit.id), 'dress still out');
  assert(outIds.includes(bike2.id), 'exchanged bike out');
  assert(!outIds.includes(bikeUnit.id), 'old bike should not be out');

  console.log('=== 10. Return both units ===');
  const ret1 = await req('/returns', {
    method: 'POST',
    token,
    body: {
      orderId: order.id,
      stockUnitId: dressUnit.id,
      cleaningRequired: true,
      inspectNotes: 'Needs clean',
    },
  });
  const mid = await req(`/orders/${order.id}`, { token });
  console.log('after first return lifecycle', mid.rentalExt?.lifecycle);

  const ret2 = await req('/returns', {
    method: 'POST',
    token,
    body: {
      orderId: order.id,
      stockUnitId: bike2.id,
      cleaningRequired: false,
      inspectNotes: 'Bike ok',
    },
  });
  const afterBoth = await req(`/orders/${order.id}`, { token });
  assert(
    afterBoth.rentalExt?.lifecycle === 'returned',
    `expected returned after all units, got ${afterBoth.rentalExt?.lifecycle}`,
  );
  console.log('both returned', ret1.id, ret2.id);

  await req(`/returns/${ret1.id}/inspect`, {
    method: 'POST',
    token,
    body: { inspectStatus: 'needs_cleaning' },
  });
  await req(`/returns/${ret1.id}/cleaning/complete`, {
    method: 'POST',
    token,
  });

  await req(`/returns/${ret2.id}/inspect`, {
    method: 'POST',
    token,
    body: { inspectStatus: 'clean_ready' },
  });

  console.log('=== 11. Close ticket ===');
  await req(`/orders/${order.id}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'closed' },
  });
  const closed = await req(`/orders/${order.id}`, { token });
  assert(
    closed.rentalExt?.lifecycle === 'closed' || closed.status === 'closed',
    'close',
  );

  const recent = await req('/pos/rental/recent?limit=5', { token });
  assert(
    (recent.items ?? []).some((o) => o.id === order.id),
    'recent should include order',
  );

  // Login again to prove credentials
  const login = await req('/auth/login', {
    method: 'POST',
    body: { tenantSlug: SLUG, email: EMAIL, password: PASSWORD },
  });
  assert(login.accessToken, 're-login');

  console.log('\n========================================');
  console.log('UNIVERSAL RENTAL SMOKE PASS');
  console.log('Login credentials:');
  console.log(`  tenantSlug: ${SLUG}`);
  console.log(`  email:      ${EMAIL}`);
  console.log(`  password:   ${PASSWORD}`);
  console.log('========================================\n');
}

main().catch((e) => {
  console.error('\nSMOKE FAILED:', e.message || e);
  process.exit(1);
});
