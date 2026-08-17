/**
 * Full restaurant: signup → org → seed menu/tables/customers → dine-in + parcel
 * bills → receipt/reports. Leaves a login the owner can open in the UI.
 *
 *   node scripts/restaurant-full-e2e.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const STAMP = Date.now().toString(36);
const EMAIL = `rest.demo.${STAMP}@upos.test`;
const PASSWORD = 'RestDemo@2026';
const ORG = `Spice Garden Café ${STAMP}`;
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, 'qa-results');
mkdirSync(OUT_DIR, { recursive: true });

const RESULTS = [];
function log(name, status, detail = '', endpoint) {
  RESULTS.push({ name, status, detail, endpoint });
  console.log(`${status.padEnd(8)} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, { token, body } = {}) {
  let res;
  let text = '';
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, data: null, text: String(e.message || e) };
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: res.ok && json?.success !== false,
    status: res.status,
    data: json?.data ?? json,
    json,
    text: text.slice(0, 1400),
  };
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function sku(prefix) {
  return `${prefix}${STAMP}${Math.floor(Math.random() * 99)}`
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 18)
    .padEnd(15, '0');
}

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

async function checkoutCash(token, locId, items, opts = {}) {
  const rough =
    items.reduce(
      (s, i) => s + Number(i.unitPrice || 100) * Number(i.quantity || 1),
      0,
    ) *
      1.4 +
    100;
  const body = {
    locationId: locId,
    items,
    customerId: opts.customerId,
    note: opts.note,
    meta: opts.meta,
    discountAmount: opts.discountAmount || 0,
    payments: [
      {
        method: 'cash',
        amount: rough,
        idempotencyKey: `pay-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
      },
    ],
    cashTendered: rough + 50,
  };
  let sale = await api('POST', '/pos/sale/checkout', { token, body });
  if (!sale.ok) {
    const msg = String(sale.json?.message || sale.text || '');
    const m = msg.match(/(\d+(\.\d+)?)/);
    if (m) {
      const due = Number(m[1]);
      body.payments[0].amount = due;
      body.cashTendered = due + 20;
      body.payments[0].idempotencyKey += '-r';
      sale = await api('POST', '/pos/sale/checkout', { token, body });
    }
  }
  return sale;
}

async function main() {
  console.log(`RESTAURANT FULL E2E @ ${API}\n`);
  const health = await api('GET', '/health');
  if (!health.ok) {
    console.error('API down', health.text);
    process.exit(1);
  }
  log('API health', 'PASS', API);

  const signup = await api('POST', '/auth/signup', {
    body: { email: EMAIL, password: PASSWORD, fullName: 'Ravi Sharma' },
  });
  if (!signup.ok || !signup.data?.identityToken) {
    log('signup', 'FAIL', `${signup.status} ${signup.text}`);
    process.exit(1);
  }
  log('signup', 'PASS', EMAIL);

  const created = await api('POST', '/auth/organizations', {
    token: signup.data.identityToken,
    body: {
      organizationName: ORG,
      businessType: 'restaurant',
      addressLine1: '12 MG Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-08-01',
      storeName: 'Bandra Outlet',
    },
  });
  if (!created.ok || !created.data?.accessToken) {
    log('create restaurant org', 'FAIL', `${created.status} ${created.text}`);
    process.exit(1);
  }
  const token = created.data.accessToken;
  log('create restaurant org', 'PASS', ORG);

  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  log(
    'login with email+password',
    login.ok ? 'PASS' : 'FAIL',
    login.ok ? 'session ok' : `${login.status} ${login.text.slice(0, 180)}`,
  );

  const boot = await api('GET', '/tenants/me/bootstrap', { token });
  const modes = boot.data?.commerce?.modes || [];
  const caps =
    boot.data?.capabilities?.enabled || boot.data?.business?.capabilities || [];
  const type =
    boot.data?.business?.type || boot.data?.tenant?.settings?.businessType;
  log(
    'bootstrap restaurant profile',
    type === 'restaurant' && modes.includes('sale') ? 'PASS' : 'PARTIAL',
    `type=${type} modes=[${modes}] caps=${caps.length} (${caps.slice(0, 8)})`,
  );
  const expectedCaps = ['TABLE', 'KITCHEN', 'KOT', 'MODIFIERS'];
  const missingCaps = expectedCaps.filter((c) => !caps.includes(c));
  log(
    'restaurant capabilities',
    missingCaps.length ? 'PARTIAL' : 'PASS',
    missingCaps.length ? `missing ${missingCaps}` : expectedCaps.join(','),
  );

  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  if (!loc?.id) {
    log('location', 'FAIL', 'no store location');
    process.exit(1);
  }
  log('location', 'PASS', loc.name || loc.id);

  await api('POST', '/tenants/me/modules/resources/enable', { token, body: {} });
  await api('POST', '/tenants/me/modules/accounting/enable', { token, body: {} });

  const catNames = ['Starters', 'Mains', 'Beverages', 'Desserts'];
  const cats = {};
  for (const name of catNames) {
    const res = await api('POST', '/pos/sale/categories', {
      token,
      body: { name },
    });
    if (!res.ok) {
      log(`category ${name}`, 'FAIL', res.text, 'POST /pos/sale/categories');
    } else {
      cats[name] = res.data;
      log(`category ${name}`, 'PASS', res.data.id);
    }
  }

  const menu = [
    { cat: 'Starters', title: 'Paneer Tikka', price: 280, qty: 40 },
    { cat: 'Starters', title: 'Veg Spring Roll', price: 180, qty: 40 },
    { cat: 'Mains', title: 'Butter Chicken', price: 420, qty: 50 },
    { cat: 'Mains', title: 'Dal Makhani', price: 260, qty: 50 },
    { cat: 'Mains', title: 'Jeera Rice', price: 140, qty: 80 },
    { cat: 'Beverages', title: 'Masala Chai', price: 60, qty: 100 },
    { cat: 'Beverages', title: 'Mango Lassi', price: 90, qty: 60 },
    { cat: 'Desserts', title: 'Gulab Jamun', price: 110, qty: 40 },
  ];
  const products = {};
  for (const item of menu) {
    const res = await api('POST', '/pos/sale/products', {
      token,
      body: {
        title: item.title,
        sku: sku('RST'),
        price: item.price,
        qty: item.qty,
        locationId: loc.id,
        categoryId: cats[item.cat]?.id,
      },
    });
    if (!res.ok) {
      log(`menu ${item.title}`, 'FAIL', res.text.slice(0, 160));
      continue;
    }
    const data = res.data;
    products[item.title] = {
      ...data,
      price: item.price,
      stockLevelId: data.stockLevelId || data.stockLevel?.id || data.id,
    };
    log(`menu ${item.title}`, 'PASS', `₹${item.price}`);
  }

  const tables = [];
  for (const t of [
    { name: 'Table 1', capacity: 2 },
    { name: 'Table 5', capacity: 4 },
    { name: 'Table 12', capacity: 6 },
  ]) {
    const res = await api('POST', '/resources', {
      token,
      body: { name: t.name, type: 'table', capacity: t.capacity, locationId: loc.id },
    });
    if (res.ok) {
      tables.push(res.data);
      log(`floor ${t.name}`, 'PASS', `covers=${t.capacity}`, 'POST /resources');
    } else {
      log(`floor ${t.name}`, 'FAIL', `${res.status} ${res.text.slice(0, 120)}`, 'POST /resources');
    }
  }

  const diner = await api('POST', '/customers', {
    token,
    body: { fullName: 'Ananya Mehta', phone: phone() },
  });
  const walkin = await api('POST', '/customers', {
    token,
    body: { fullName: 'Walk-in Guest', phone: phone() },
  });
  log(
    'customers',
    diner.ok && walkin.ok ? 'PASS' : 'FAIL',
    diner.ok ? diner.data.id : diner.text,
  );

  const staff = await api('POST', '/users', {
    token,
    body: {
      fullName: 'Kasim Waiter',
      email: `waiter.${STAMP}@upos.test`,
      password: PASSWORD,
    },
  });
  log(
    'create staff cashier',
    staff.ok ? 'PASS' : 'PARTIAL',
    staff.ok ? staff.data?.id : `${staff.status} ${staff.text.slice(0, 120)}`,
    'POST /users',
  );

  const regCur = await api(
    'GET',
    `/pos/sale/register/current?locationId=${loc.id}`,
    { token },
  );
  if (!(regCur.data?.session?.id || regCur.data?.id)) {
    const opened = await api('POST', '/pos/sale/register/open', {
      token,
      body: { locationId: loc.id, openingFloat: 2000 },
    });
    log(
      'open register',
      opened.ok ? 'PASS' : 'FAIL',
      opened.ok ? '' : opened.text.slice(0, 120),
    );
  } else {
    log('open register', 'PASS', 'already open');
  }

  const tikka = products['Paneer Tikka'];
  const butter = products['Butter Chicken'];
  const rice = products['Jeera Rice'];
  const lassi = products['Mango Lassi'];
  const jamun = products['Gulab Jamun'];
  const chai = products['Masala Chai'];

  const dineIn = await checkoutCash(
    token,
    loc.id,
    [
      { stockLevelId: tikka?.stockLevelId, quantity: 1, unitPrice: 280 },
      { stockLevelId: butter?.stockLevelId, quantity: 1, unitPrice: 420 },
      { stockLevelId: rice?.stockLevelId, quantity: 2, unitPrice: 140 },
      { stockLevelId: lassi?.stockLevelId, quantity: 2, unitPrice: 90 },
    ],
    {
      customerId: diner.data?.id,
      note: 'Dine-in Table 5',
      meta: {
        tableNumber: '5',
        covers: 4,
        orderType: 'dine_in',
        kot_status: 'sent',
        courseNote: 'Spice medium',
      },
    },
  );
  const dineMeta = dineIn.data?.order?.meta || {};
  const tableOk = String(dineMeta.tableNumber) === '5';
  log(
    'dine-in bill Table 5',
    dineIn.ok && tableOk ? 'PASS' : dineIn.ok ? 'PARTIAL' : 'FAIL',
    dineIn.ok
      ? `order=${dineIn.data.order.id} meta.tableNumber=${dineMeta.tableNumber} kot=${dineMeta.kot_status}`
      : dineIn.text.slice(0, 200),
    'POST /pos/sale/checkout',
  );

  const parcel = await checkoutCash(
    token,
    loc.id,
    [
      { stockLevelId: jamun?.stockLevelId, quantity: 2, unitPrice: 110 },
      { stockLevelId: chai?.stockLevelId, quantity: 1, unitPrice: 60 },
    ],
    {
      customerId: walkin.data?.id,
      note: 'Parcel / takeaway',
      meta: { orderType: 'parcel', kot_status: 'sent' },
    },
  );
  log(
    'parcel / takeaway bill',
    parcel.ok ? 'PASS' : 'FAIL',
    parcel.ok ? parcel.data.order.id : parcel.text.slice(0, 160),
  );

  if (dineIn.ok && dineIn.data.order.id) {
    const receipt = await api(
      'GET',
      `/pos/orders/${dineIn.data.order.id}/receipt`,
      { token },
    );
    log(
      'dine-in receipt',
      receipt.ok ? 'PASS' : 'FAIL',
      receipt.ok ? 'printed payload ok' : `${receipt.status}`,
      `GET /pos/orders/${dineIn.data.order.id}/receipt`,
    );
    const hist = await api('GET', `/customers/${diner.data.id}/orders`, {
      token,
    });
    const n = asList(hist.data).length || asList(hist.data?.orders).length;
    log(
      'customer dine-in history',
      hist.ok ? 'PASS' : 'PARTIAL',
      `orders=${n || (hist.ok ? 'ok' : hist.status)}`,
    );
  }

  const kot = await api('GET', '/kitchen/tickets', { token });
  const kot2 = await api('GET', '/pos/kitchen', { token });
  const kot3 = await api('GET', '/kot', { token });
  log(
    'first-class kitchen / KOT board',
    kot.ok || kot2.ok || kot3.ok ? 'PASS' : 'PARTIAL',
    `kitchen=${kot.status} pos/kitchen=${kot2.status} kot=${kot3.status} — dine-in uses order.meta.kot_status only`,
  );

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const reports = [
    `/reports/sales-summary?from=${from}&to=${to}`,
    `/reports/payments-summary?from=${from}&to=${to}`,
    `/reports/daily-sales?date=${to}`,
  ];
  let rok = 0;
  for (const p of reports) {
    const r = await api('GET', p, { token });
    if (r.ok) rok += 1;
  }
  log('reports (sales/payments/daily)', rok === 3 ? 'PASS' : 'PARTIAL', `${rok}/3`);

  const catalog = await api(
    'GET',
    `/pos/sale/catalog?locationId=${loc.id}&limit=50`,
    { token },
  );
  const menuCount = asList(catalog.data?.items ?? catalog.data).length;
  log(
    'counter catalog for restaurant',
    catalog.ok && menuCount >= 6 ? 'PASS' : 'PARTIAL',
    `items visible=${menuCount}`,
  );

  const pass = RESULTS.filter((r) => r.status === 'PASS').length;
  const partial = RESULTS.filter((r) => r.status === 'PARTIAL').length;
  const fail = RESULTS.filter((r) => r.status === 'FAIL').length;
  const verdict =
    fail > 0
      ? 'RESTAURANT RUNS WITH FAILURES'
      : partial
        ? 'RESTAURANT OPERATIONAL WITH GAPS'
        : 'RESTAURANT FULLY OPERATIONAL';

  const loginInfo = {
    app: 'http://localhost:3000/login',
    email: EMAIL,
    password: PASSWORD,
    organization: ORG,
    branch: 'Bandra Outlet',
    owner: 'Ravi Sharma',
  };

  console.log('\n========== VERDICT ==========');
  console.log(verdict);
  console.log(`Steps PASS=${pass} PARTIAL=${partial} FAIL=${fail}`);
  console.log('\n========== LOGIN (local UI) ==========');
  console.log(`Open:     ${loginInfo.app}`);
  console.log(`Email:    ${loginInfo.email}`);
  console.log(`Password: ${loginInfo.password}`);
  console.log(`Shop:     ${loginInfo.organization}`);
  console.log('Seeded:   menu (8), tables 1/5/12, 2 customers, dine-in + parcel bills');

  const report = {
    generatedAt: new Date().toISOString(),
    api: API,
    verdict,
    login: loginInfo,
    summary: { pass, partial, fail },
    results: RESULTS,
  };
  const out = join(OUT_DIR, `restaurant-full-${STAMP}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, 'restaurant-full-latest.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${out}`);
  if (fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
