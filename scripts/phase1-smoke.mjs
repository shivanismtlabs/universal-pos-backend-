/**
 * Phase 1 MVP smoke test — client delivery checklist
 * Run: node scripts/phase1-smoke.mjs
 */
const BASE = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const TENANT = process.env.SMOKE_TENANT ?? 'pool-store';
const EMAIL = process.env.SMOKE_EMAIL ?? 'owner@pool.demo';
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'WalitShop@2026';

const results = [];

function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail });
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  const data = json?.data ?? json;
  return { status: res.status, json, data, ok: res.ok && json?.success !== false };
}

async function main() {
  console.log(`\nPhase 1 smoke → ${BASE}  tenant=${TENANT}\n`);

  // ── 1) Auth ─────────────────────────────────────────────
  const login = await api('POST', '/auth/login', {
    body: { tenantSlug: TENANT, email: EMAIL, password: PASSWORD },
  });
  if (!login.ok || !login.data?.accessToken) {
    fail('1. Auth login', `${login.status} ${JSON.stringify(login.json?.message)}`);
    printSummary();
    process.exit(1);
  }
  const token = login.data.accessToken;
  const locationId = login.data.user?.locationId ?? login.data.user?.storeId;
  const roles = login.data.user?.roles ?? [];
  ok('1. Auth login', `roles=${roles.join(',')}`);

  const me = await api('GET', '/auth/me', { token });
  if (me.ok && me.data?.email) ok('1b. Auth /me', me.data.email);
  else fail('1b. Auth /me', String(me.status));

  const users = await api('GET', '/users', { token });
  if (users.ok) {
    const list = users.data?.items ?? users.data ?? [];
    const n = Array.isArray(list) ? list.length : 0;
    ok('1c. Roles / staff list', `${n} users`);
  } else fail('1c. Roles / staff list', String(users.status));

  // Bad login should fail
  const bad = await api('POST', '/auth/login', {
    body: { tenantSlug: TENANT, email: EMAIL, password: 'WrongPass!999' },
  });
  if (!bad.ok) ok('1d. Auth rejects bad password');
  else fail('1d. Auth rejects bad password', 'accepted wrong password');

  // ── 2) Product management ───────────────────────────────
  const catName = `Phase1 Cat ${Date.now().toString().slice(-6)}`;
  const cat = await api('POST', '/pos/sale/categories', {
    token,
    body: { name: catName },
  });
  if (cat.ok && cat.data?.id) ok('2. Product category create', catName);
  else fail('2. Product category create', JSON.stringify(cat.json?.message));

  const sku = `P1-${Date.now().toString().slice(-8)}`;
  const product = await api('POST', '/pos/sale/products', {
    token,
    body: {
      title: 'Phase1 Test Item',
      sku,
      price: 19.99,
      qty: 25,
      categoryId: cat.data?.id,
      locationId,
    },
  });
  if (product.ok && (product.data?.stockLevel?.id || product.data?.id)) {
    ok('2b. Product create', sku);
  } else {
    fail('2b. Product create', JSON.stringify(product.json?.message));
  }

  const stockLevelId =
    product.data?.stockLevel?.id ??
    product.data?.id ??
    product.data?.stockLevelId;

  const catalog = await api(
    'GET',
    `/pos/sale/catalog?locationId=${locationId}&limit=50`,
    { token },
  );
  const items = catalog.data?.items ?? [];
  const found = items.find((i) => i.sku === sku || i.id === stockLevelId);
  if (catalog.ok && (found || items.length > 0)) {
    ok('2c. Product catalog list', `${items.length} items`);
  } else fail('2c. Product catalog list', String(catalog.status));

  // ── 3) Inventory ────────────────────────────────────────
  const floor = await api('GET', '/pos/sale/floor', { token });
  if (floor.ok && floor.data?.counts) {
    ok(
      '3. Inventory floor counts',
      `products=${floor.data.counts.products} inStock=${floor.data.counts.inStock}`,
    );
  } else fail('3. Inventory floor counts', String(floor.status));

  if (stockLevelId) {
    const adjust = await api('POST', `/pos/sale/products/${stockLevelId}/adjust-stock`, {
      token,
      body: { delta: 5 },
    });
    if (adjust.ok) ok('3b. Inventory stock adjust', '+5');
    else {
      // some APIs use different id — soft fail detail
      fail('3b. Inventory stock adjust', JSON.stringify(adjust.json?.message));
    }
  } else {
    fail('3b. Inventory stock adjust', 'no stockLevelId');
  }

  // ── 4) Billing / checkout ───────────────────────────────
  let sellId = stockLevelId;
  if (!sellId && items[0]) sellId = items[0].id;

  const reg = await api(
    'GET',
    `/pos/sale/register/current?locationId=${locationId}`,
    { token },
  );
  if (!reg.data) {
    const opened = await api('POST', '/pos/sale/register/open', {
      token,
      body: { locationId, openingFloat: 100 },
    });
    if (opened.ok) ok('4. Register open');
    else fail('4. Register open', JSON.stringify(opened.json?.message));
  } else {
    ok('4. Register open', 'already open');
  }

  // Prepare then cash checkout with tax buffer
  const unitPrice = Number(found?.sellPrice ?? found?.price ?? 19.99);
  const payAmount = Math.round(unitPrice * 1.2 * 100) / 100 + 5;

  const checkout = await api('POST', '/pos/sale/checkout', {
    token,
    body: {
      locationId,
      items: [{ stockLevelId: sellId, quantity: 1 }],
      payments: [
        {
          method: 'cash',
          amount: payAmount,
          idempotencyKey: `p1-${Date.now()}`,
        },
      ],
      cashTendered: payAmount + 20,
    },
  });

  let orderId = checkout.data?.order?.id;
  let orderNumber = checkout.data?.order?.orderNumber;
  if (checkout.ok && orderId) {
    ok('4b. Billing checkout', orderNumber);
  } else {
    // retry with higher amount from error message
    fail('4b. Billing checkout', JSON.stringify(checkout.json?.message));
  }

  // ── 5) Customers ────────────────────────────────────────
  const custName = `Phase1 Customer ${Date.now().toString().slice(-4)}`;
  const customer = await api('POST', '/customers', {
    token,
    body: {
      fullName: custName,
      phone: `555${Date.now().toString().slice(-7)}`,
      email: `p1.${Date.now()}@example.com`,
    },
  });
  if (customer.ok && customer.data?.id) ok('5. Customer create', custName);
  else fail('5. Customer create', JSON.stringify(customer.json?.message));

  const custList = await api('GET', '/customers?limit=20', { token });
  const cItems = custList.data?.items ?? custList.data ?? [];
  if (custList.ok && Array.isArray(cItems) && cItems.length > 0) {
    ok('5b. Customer list', `${cItems.length} customers`);
  } else fail('5b. Customer list', String(custList.status));

  // ── 6) Reports ──────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const salesR = await api(
    'GET',
    `/reports/sales-summary?from=${from}&to=${today}`,
    { token },
  );
  if (salesR.ok) ok('6. Reports sales-summary');
  else fail('6. Reports sales-summary', String(salesR.status));

  const payR = await api(
    'GET',
    `/reports/payments-summary?from=${from}&to=${today}`,
    { token },
  );
  if (payR.ok) ok('6b. Reports payments-summary');
  else fail('6b. Reports payments-summary', String(payR.status));

  const balR = await api('GET', '/reports/balances', { token });
  if (balR.ok) ok('6c. Reports balances');
  else fail('6c. Reports balances', String(balR.status));

  // ── 7) Receipt ──────────────────────────────────────────
  if (!orderId) {
    const recent = await api('GET', '/pos/sale/recent?limit=5', { token });
    const first = recent.data?.items?.[0];
    orderId = first?.id;
    orderNumber = first?.orderNumber;
  }

  if (orderId) {
    const receipt = await api('GET', `/pos/orders/${orderId}/receipt`, {
      token,
    });
    if (receipt.ok && (receipt.data?.orderNumber || receipt.data?.lines)) {
      ok('7. Receipt print data', receipt.data.orderNumber ?? orderNumber);
    } else if (receipt.ok) {
      ok('7. Receipt print data', 'payload ok');
    } else {
      fail('7. Receipt print data', JSON.stringify(receipt.json?.message));
    }
  } else {
    fail('7. Receipt print data', 'no order to print');
  }

  // Frontend routes smoke (HTML)
  const pages = [
    '/login',
    '/dashboard',
    '/catalog',
    '/pos',
    '/customers',
    '/reports',
    '/plan',
  ];
  for (const p of pages) {
    try {
      const r = await fetch(`http://127.0.0.1:3000${p}`, {
        redirect: 'manual',
      });
      if (r.status >= 200 && r.status < 400) ok(`UI ${p}`, String(r.status));
      else fail(`UI ${p}`, String(r.status));
    } catch (e) {
      fail(`UI ${p}`, e.message);
    }
  }

  printSummary();
  const failed = results.filter((r) => !r.pass).length;
  process.exit(failed ? 1 : 0);
}

function printSummary() {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log('\n──────── Phase 1 summary ────────');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed) {
    console.log('Failed cases:');
    for (const r of results.filter((x) => !x.pass)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
  }
  console.log('─────────────────────────────────\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
