/**
 * Universal Sale POS smoke — catalog, discount checkout, park/resume,
 * register open/close, qty return.
 *
 * Usage: node scripts/smoke-sale-universal.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const SUFFIX = Date.now().toString(36);
const SLUG = `sale-hub-${SUFFIX}`;
const EMAIL = `owner@${SLUG}.test`;
const PASSWORD = 'SaleHub@2026!';

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
  console.log('=== 1. Register Sale tenant ===');
  const reg = await req('/auth/register-tenant', {
    method: 'POST',
    body: {
      tenantName: 'Universal Sale Hub',
      tenantSlug: SLUG,
      storeName: 'Main',
      adminFullName: 'Sale Owner',
      adminEmail: EMAIL,
      adminPassword: PASSWORD,
      adminPhone: '9876511111',
    },
  });
  const token = reg.accessToken;
  assert(token, 'token');

  await req('/tenants/me/commerce-modes', {
    method: 'POST',
    token,
    body: { mode: 'sale', shopTitle: 'Universal Sale Hub' },
  });

  const locs = await req('/locations', { token });
  const loc = (Array.isArray(locs) ? locs : locs.items ?? [])[0];
  assert(loc?.id, 'location');

  console.log('=== 2. Schema + floor ===');
  const schema = await req('/pos/sale/schema', { token });
  assert(schema.mode === 'sale', 'sale schema');
  assert(
    schema.fields?.some((f) => f.key === 'sku'),
    'sku field',
  );

  console.log('=== 3. Category + product ===');
  const cat = await req('/pos/sale/categories', {
    method: 'POST',
    token,
    body: { name: 'General' },
  });
  const prod = await req('/pos/sale/products', {
    method: 'POST',
    token,
    body: {
      title: 'Widget A',
      categoryId: cat.id,
      sku: `WGT-${SUFFIX}`,
      price: 500,
      qty: 20,
      locationId: loc.id,
    },
  });
  const stockLevelId = prod.stockLevel?.id ?? prod.posItem?.id;
  assert(stockLevelId, `stock level id from ${JSON.stringify(prod)}`);

  console.log('=== 4. Register open ===');
  const session = await req('/pos/sale/register/open', {
    method: 'POST',
    token,
    body: { locationId: loc.id, openingFloat: 1000 },
  });
  assert(session.id, 'register');
  const cur = await req(
    `/pos/sale/register/current?locationId=${loc.id}`,
    { token },
  );
  assert(cur.session?.id === session.id, 'current register');

  console.log('=== 5. Checkout with discount + tax ===');
  // Exclusive tax default 5%: merchandise 1000 − discount 50 + tax 50 = due 1000
  // (tax is computed on line totals before order discount in recalculateTotals)
  const merchandise = 1000;
  const discount = 50;
  const taxRate = 0.05;
  const taxOnLines = merchandise * taxRate; // 50
  const due = merchandise + taxOnLines - discount; // 1000
  const sale = await req('/pos/sale/checkout', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      items: [{ stockLevelId, quantity: 2, unitPrice: 500 }],
      discountAmount: discount,
      payments: [
        {
          method: 'cash',
          amount: due,
          idempotencyKey: `sale-${SUFFIX}`,
        },
      ],
      cashTendered: due + 50,
    },
  });
  assert(sale.order?.id, 'sale order');
  assert(Number(sale.order.taxTotal) > 0, 'tax must be applied on sale');
  console.log(
    'sold',
    sale.order.orderNumber,
    'tax',
    sale.order.taxTotal,
    'change',
    sale.change,
  );

  console.log('=== 6. Park / list / resume ===');
  const parked = await req('/pos/sale/park', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      items: [{ stockLevelId, quantity: 1 }],
      label: 'Hold desk',
    },
  });
  assert(parked.id, 'parked');
  const list = await req(`/pos/sale/parked?locationId=${loc.id}`, { token });
  assert(
    (list.items ?? []).some((o) => o.id === parked.id),
    'parked list',
  );
  const resumed = await req(`/pos/sale/parked/${parked.id}/resume`, {
    method: 'POST',
    token,
  });
  assert(resumed.cart?.length >= 1, 'resume cart');
  await req(`/pos/sale/parked/${parked.id}/discard`, {
    method: 'POST',
    token,
  });

  console.log('=== 7. Sale return (restock + refund) ===');
  const ret = await req('/pos/sale/returns', {
    method: 'POST',
    token,
    body: {
      orderId: sale.order.id,
      items: [{ stockLevelId, quantity: 1 }],
      refundMethod: 'cash',
      reasonCode: 'customer_changed_mind',
      reason: 'Customer changed mind',
      idempotencyKey: `ret-${SUFFIX}`,
    },
  });
  assert(ret.refundPaymentId, 'refund');
  console.log('returned', ret.amount);

  console.log('=== 8. Register close (Z-lite) ===');
  const closed = await req(`/pos/sale/register/${session.id}/close`, {
    method: 'POST',
    token,
    body: { closingCash: Number(sale.change ?? 0) + due, note: 'EOD' },
  });
  assert(closed.closedAt, 'closed');
  assert(closed.zReport, 'zReport on close');
  console.log('zReport', closed.zReport);

  console.log('\n========================================');
  console.log('UNIVERSAL SALE SMOKE PASS');
  console.log(`  slug: ${SLUG}`);
  console.log(`  email: ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log('========================================\n');
}

main().catch((e) => {
  console.error('\nSMOKE FAILED:', e.message || e);
  process.exit(1);
});
