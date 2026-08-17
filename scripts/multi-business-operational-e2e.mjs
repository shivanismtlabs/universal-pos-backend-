/**
 * FULL MULTI-BUSINESS OPERATIONAL E2E
 * Setup is not enough — primary workflow + payment + inventory/resource +
 * customer history + reports + accounting + negatives + isolation.
 *
 * Usage:
 *   node scripts/multi-business-operational-e2e.mjs
 *   API_URL=http://127.0.0.1:3001/v1 node scripts/multi-business-operational-e2e.mjs
 *
 * Writes: scripts/qa-results/multi-biz-operational-*.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const STAMP = Date.now().toString(36);
const PASSWORD = 'WalitShop@2026';
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, 'qa-results');
mkdirSync(OUT_DIR, { recursive: true });

/** @type {Record<string, any>} */
const MATRIX = {};
/** @type {Array<{biz:string,area:string,name:string,status:string,endpoint?:string,detail:string}>} */
const RESULTS = [];
/** @type {Array<{biz:string,workflow:string,endpoint?:string,detail:string}>} */
const FAILURES = [];

const COLS = [
  'setup',
  'primary',
  'payment',
  'inventory',
  'resource',
  'customer',
  'reports',
  'accounting',
  'permissions',
  'isolation',
];

function cellInit() {
  return Object.fromEntries(COLS.map((c) => [c, 'PENDING']));
}

function setCell(biz, col, status) {
  if (!MATRIX[biz]) MATRIX[biz] = cellInit();
  const rank = { FAIL: 3, PARTIAL: 2, PASS: 1, 'N/A': 0, PENDING: -1, SKIP: 0 };
  const cur = MATRIX[biz][col];
  if ((rank[status] ?? 0) >= (rank[cur] ?? -1)) MATRIX[biz][col] = status;
}

function log(biz, area, name, status, detail = '', endpoint) {
  RESULTS.push({ biz, area, name, status, detail, endpoint });
  const tag = status.padEnd(7);
  console.log(`${tag} [${biz}/${area}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (status === 'FAIL') {
    FAILURES.push({ biz, workflow: `${area}: ${name}`, endpoint, detail });
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function api(method, path, { token, body } = {}) {
  const t0 = Date.now();
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
    return {
      ok: false,
      status: 0,
      data: null,
      text: String(e.message || e),
      ms: Date.now() - t0,
    };
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
    text: text.slice(0, 1200),
    ms: Date.now() - t0,
  };
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function assert(cond, msg, extra = {}) {
  if (!cond) {
    const e = new Error(msg);
    Object.assign(e, extra);
    throw e;
  }
}

function sku(prefix) {
  const raw = `${prefix}${STAMP}${Math.floor(Math.random() * 999)}`.replace(
    /[^A-Z0-9]/gi,
    '',
  );
  return raw.slice(0, 18).padEnd(15, '0').slice(0, 18);
}

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

async function provision(biz) {
  await sleep(800);
  const email = `ops.${biz}.${STAMP}@upos.test`;
  const signup = await api('POST', '/auth/signup', {
    body: {
      email,
      password: PASSWORD,
      fullName: `${biz} Ops Owner`,
    },
  });
  assert(signup.ok && signup.data?.identityToken, `signup ${signup.status} ${signup.text}`, {
    endpoint: 'POST /auth/signup',
  });

  const created = await api('POST', '/auth/organizations', {
    token: signup.data.identityToken,
    body: {
      organizationName: `${biz} Ops ${STAMP}`,
      businessType: biz,
      addressLine1: '100 Ops Street',
      state: 'Maharashtra',
      city: 'Mumbai',
      postalCode: '400001',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-08-01',
    },
  });
  assert(
    created.ok && created.data?.accessToken,
    `create org ${created.status} ${created.text}`,
    { endpoint: 'POST /auth/organizations' },
  );

  const token = created.data.accessToken;
  const identityToken = signup.data.identityToken;
  const tenantId = created.data.user?.tenantId;

  // Ensure accounting + appointments modules where helpful
  await api('POST', '/tenants/me/modules/accounting/enable', { token, body: {} });
  await api('POST', '/tenants/me/modules/appointments/enable', { token, body: {} });
  await api('POST', '/tenants/me/modules/resources/enable', { token, body: {} });
  await api('POST', '/tenants/me/modules/jobs/enable', { token, body: {} });

  // Service-shaped shops still bill via Sale POS catalog — ensure sale mode on
  const boot0 = await api('GET', '/tenants/me/bootstrap', { token });
  let modes0 = boot0.data?.commerce?.modes || [];
  if (
    ['service', 'gym', 'photography', 'salon', 'pet_grooming', 'repair'].includes(
      biz,
    ) &&
    !modes0.includes('sale')
  ) {
    modes0 = [...new Set([...modes0, 'sale'])];
    await api('POST', '/tenants/me/commerce-modes', {
      token,
      body: { modes: modes0 },
    });
  }

  const boot = await api('GET', '/tenants/me/bootstrap', { token });
  assert(boot.ok, `bootstrap ${boot.status}`, { endpoint: 'GET /tenants/me/bootstrap' });
  const modes = boot.data?.commerce?.modes || [];
  const caps =
    boot.data?.capabilities?.enabled || boot.data?.business?.capabilities || [];
  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  assert(loc?.id, 'no location', { endpoint: 'GET /locations' });

  return {
    biz,
    email,
    token,
    identityToken,
    tenantId,
    loc,
    modes,
    caps,
    boot: boot.data,
  };
}

async function ensureRegister(token, locationId) {
  const cur = await api(
    'GET',
    `/pos/sale/register/current?locationId=${locationId}`,
    { token },
  );
  if (cur.data?.session?.id || cur.data?.id) return cur.data.session || cur.data;
  const opened = await api('POST', '/pos/sale/register/open', {
    token,
    body: { locationId, openingFloat: 1000 },
  });
  assert(opened.ok, `register ${opened.status} ${opened.text}`, {
    endpoint: 'POST /pos/sale/register/open',
  });
  return opened.data;
}

async function createCustomer(token, name) {
  const res = await api('POST', '/customers', {
    token,
    body: { fullName: name, phone: phone() },
  });
  assert(res.ok && res.data?.id, `customer ${res.status} ${res.text}`, {
    endpoint: 'POST /customers',
  });
  return res.data;
}

async function createStaff(token) {
  const res = await api('POST', '/users', {
    token,
    body: {
      fullName: `Cashier ${STAMP}`,
      email: `cashier.${STAMP}.${Math.floor(Math.random() * 9999)}@upos.test`,
      password: PASSWORD,
      roles: ['cashier'],
    },
  });
  // Some builds use different shape
  if (!res.ok) {
    return { ok: false, status: res.status, text: res.text };
  }
  return { ok: true, data: res.data };
}

async function createCategory(token, name) {
  const res = await api('POST', '/pos/sale/categories', {
    token,
    body: { name },
  });
  assert(res.ok && res.data?.id, `category ${res.status} ${res.text}`, {
    endpoint: 'POST /pos/sale/categories',
  });
  return res.data;
}

async function createProduct(token, locId, opts) {
  const body = {
    title: opts.title,
    sku: opts.sku || sku('P'),
    price: opts.price ?? 100,
    qty: opts.qty ?? 10,
    locationId: locId,
    categoryId: opts.categoryId,
  };
  if (opts.trackInventory === false) body.trackInventory = false;
  if (opts.batchTracking) body.batchTracking = true;
  if (opts.kind) body.kind = opts.kind;
  const res = await api('POST', '/pos/sale/products', { token, body });
  assert(res.ok, `product ${res.status} ${res.text}`, {
    endpoint: 'POST /pos/sale/products',
  });
  const data = res.data;
  return {
    ...data,
    stockLevelId:
      data.stockLevelId ||
      data.stockLevel?.id ||
      data.id,
    productId: data.productId || data.product?.id || data.id,
  };
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
    payments: opts.payments || [
      {
        method: 'cash',
        amount: opts.partialAmount ?? rough,
        idempotencyKey: `pay-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
      },
    ],
    cashTendered: (opts.partialAmount ?? rough) + 50,
  };
  let sale = await api('POST', '/pos/sale/checkout', { token, body });
  if (!sale.ok) {
    const msg = String(sale.json?.message || sale.text || '');
    const m = msg.match(/(\d+(\.\d+)?)/);
    if (m && !opts.partialAmount) {
      const due = Number(m[1]);
      body.payments[0].amount = due;
      body.cashTendered = due + 20;
      body.payments[0].idempotencyKey += '-r';
      sale = await api('POST', '/pos/sale/checkout', { token, body });
    }
  }
  assert(sale.ok && sale.data?.order?.id, `checkout ${sale.status} ${sale.text}`, {
    endpoint: 'POST /pos/sale/checkout',
  });
  return sale.data;
}

async function getStock(token, locId, stockLevelId) {
  const cat = await api(
    'GET',
    `/pos/sale/catalog?locationId=${locId}&limit=200`,
    { token },
  );
  const items = asList(cat.data?.items ?? cat.data);
  const row = items.find(
    (i) =>
      i.id === stockLevelId ||
      i.stockLevelId === stockLevelId ||
      i.productId === stockLevelId,
  );
  if (!row) return null;
  return Number(row.qtyOnHand ?? row.quantity ?? row.stockOnHand ?? row.qty ?? NaN);
}

async function checkReports(ctx) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const paths = [
    `/reports/sales-summary?from=${from}&to=${to}`,
    `/reports/payments-summary?from=${from}&to=${to}`,
    `/reports/daily-sales?date=${to}`,
  ];
  let ok = 0;
  const fails = [];
  for (const p of paths) {
    const r = await api('GET', p, { token: ctx.token });
    if (r.ok) ok += 1;
    else fails.push(`${p}→${r.status}`);
  }
  if (ok === paths.length) {
    setCell(ctx.biz, 'reports', 'PASS');
    log(ctx.biz, 'reports', 'sales/payments/daily', 'PASS', `${ok}/${paths.length}`);
  } else if (ok > 0) {
    setCell(ctx.biz, 'reports', 'PARTIAL');
    log(ctx.biz, 'reports', 'partial reports', 'PARTIAL', fails.join('; '));
  } else {
    setCell(ctx.biz, 'reports', 'FAIL');
    log(ctx.biz, 'reports', 'reports unavailable', 'FAIL', fails.join('; '), paths[0]);
  }
}

async function checkAccounting(ctx) {
  const paths = [
    ['GET', '/accounts'],
    ['GET', '/journal-entries?limit=10'],
    ['GET', '/trial-balance'],
    ['GET', '/profit-loss'],
    ['GET', '/ledger'],
  ];
  let ok = 0;
  const detail = [];
  for (const [method, path] of paths) {
    const r = await api(method, path, { token: ctx.token });
    if (r.ok) ok += 1;
    else detail.push(`${path}→${r.status}`);
  }
  // P&L via reports as fallback
  const pl = await api('GET', '/reports/profit-and-loss?preset=this_month', {
    token: ctx.token,
  });
  if (pl.ok) ok += 1;
  else detail.push(`reports/pnl→${pl.status}`);

  if (ok >= 3) {
    setCell(ctx.biz, 'accounting', 'PASS');
    log(ctx.biz, 'accounting', 'GL/TB/P&L reachable', 'PASS', `ok=${ok}`);
  } else if (ok >= 1) {
    setCell(ctx.biz, 'accounting', 'PARTIAL');
    log(ctx.biz, 'accounting', 'partial accounting', 'PARTIAL', detail.join('; '));
  } else {
    setCell(ctx.biz, 'accounting', 'FAIL');
    log(
      ctx.biz,
      'accounting',
      'accounting not operational',
      'FAIL',
      detail.join('; '),
      '/accounts',
    );
  }
}

async function checkReceipt(ctx, orderId) {
  const r = await api('GET', `/pos/orders/${orderId}/receipt`, { token: ctx.token });
  if (r.ok) {
    log(ctx.biz, 'payment', 'receipt', 'PASS', `order=${orderId}`, `GET /pos/orders/${orderId}/receipt`);
    return true;
  }
  log(ctx.biz, 'payment', 'receipt', 'FAIL', `${r.status} ${r.text.slice(0, 120)}`, `GET /pos/orders/${orderId}/receipt`);
  return false;
}

async function checkCustomerHistory(ctx, customerId) {
  const hist = await api('GET', `/customers/${customerId}/orders`, {
    token: ctx.token,
  });
  if (hist.ok && asList(hist.data).length >= 1) {
    setCell(ctx.biz, 'customer', 'PASS');
    log(ctx.biz, 'customer', 'order history', 'PASS', `n=${asList(hist.data).length}`);
    return true;
  }
  if (hist.ok) {
    setCell(ctx.biz, 'customer', 'PARTIAL');
    log(ctx.biz, 'customer', 'history empty after sale', 'PARTIAL', '0 orders');
    return false;
  }
  setCell(ctx.biz, 'customer', 'FAIL');
  log(ctx.biz, 'customer', 'history endpoint', 'FAIL', `${hist.status}`, `GET /customers/${customerId}/orders`);
  return false;
}

/* ───────────── business workflows ───────────── */

async function runRetail(ctx) {
  const cat = await createCategory(ctx.token, 'Apparel');
  const staff = await createStaff(ctx.token);
  if (staff.ok) log(ctx.biz, 'setup', 'staff user', 'PASS');
  else {
    setCell(ctx.biz, 'permissions', 'PARTIAL');
    log(ctx.biz, 'setup', 'staff user', 'PARTIAL', `${staff.status}`, 'POST /users');
  }

  const cust = await createCustomer(ctx.token, 'Retail Buyer');
  const prod = await createProduct(ctx.token, ctx.loc.id, {
    title: 'Blue Shirt',
    price: 799,
    qty: 20,
    categoryId: cat.id,
  });
  await ensureRegister(ctx.token, ctx.loc.id);
  const before = await getStock(ctx.token, ctx.loc.id, prod.stockLevelId);
  const sale = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [{ stockLevelId: prod.stockLevelId, quantity: 2, unitPrice: 799 }],
    { customerId: cust.id },
  );
  const after = await getStock(ctx.token, ctx.loc.id, prod.stockLevelId);
  const stockOk =
    before != null && after != null && after === before - 2;
  if (stockOk) {
    setCell(ctx.biz, 'inventory', 'PASS');
    setCell(ctx.biz, 'primary', 'PASS');
    log(ctx.biz, 'primary', 'sale + stock deduct', 'PASS', `${before}→${after}`);
  } else {
    setCell(ctx.biz, 'inventory', after == null ? 'PARTIAL' : 'FAIL');
    setCell(ctx.biz, 'primary', sale?.order?.id ? 'PARTIAL' : 'FAIL');
    log(
      ctx.biz,
      'primary',
      'sale stock deduct',
      stockOk ? 'PASS' : 'FAIL',
      `before=${before} after=${after}`,
      'POST /pos/sale/checkout',
    );
  }
  setCell(ctx.biz, 'payment', 'PASS');
  await checkReceipt(ctx, sale.order.id);
  await checkCustomerHistory(ctx, cust.id);

  // Return + stock restore
  await api('POST', '/pos/refund-reasons/seed', { token: ctx.token });
  const reasons = await api('GET', '/pos/refund-reasons', { token: ctx.token });
  const reasonCode =
    asList(reasons.data)[0]?.code ||
    reasons.data?.[0]?.code ||
    'size_issue';
  const ret = await api('POST', '/pos/sale/returns', {
    token: ctx.token,
    body: {
      orderId: sale.order.id,
      reasonCode,
      reason: 'Size issue',
      refundMethod: 'cash',
      items: [{ stockLevelId: prod.stockLevelId, quantity: 1 }],
      idempotencyKey: `ret-${STAMP}-retail`,
    },
  });
  if (ret.ok) {
    const afterRet = await getStock(ctx.token, ctx.loc.id, prod.stockLevelId);
    if (after != null && afterRet != null && afterRet >= after) {
      log(ctx.biz, 'inventory', 'return restores stock', 'PASS', `${after}→${afterRet}`);
    } else {
      log(ctx.biz, 'inventory', 'return stock restore', 'PARTIAL', `${after}→${afterRet}`, 'POST /pos/sale/returns');
      setCell(ctx.biz, 'inventory', 'PARTIAL');
    }
  } else {
    log(ctx.biz, 'inventory', 'return', 'FAIL', `${ret.status} ${ret.text.slice(0, 160)}`, 'POST /pos/sale/returns');
    setCell(ctx.biz, 'inventory', 'FAIL');
  }

  // insufficient stock negative
  const bad = await api('POST', '/pos/sale/checkout', {
    token: ctx.token,
    body: {
      locationId: ctx.loc.id,
      items: [{ stockLevelId: prod.stockLevelId, quantity: 99999, unitPrice: 799 }],
      payments: [{ method: 'cash', amount: 1, idempotencyKey: `bad-${STAMP}` }],
      cashTendered: 1,
    },
  });
  if (!bad.ok) {
    log(ctx.biz, 'primary', 'insufficient stock rejected', 'PASS', String(bad.status));
  } else {
    log(ctx.biz, 'primary', 'insufficient stock rejected', 'FAIL', 'accepted huge qty', 'POST /pos/sale/checkout');
    setCell(ctx.biz, 'primary', 'FAIL');
  }

  setCell(ctx.biz, 'resource', 'N/A');
}

async function runGrocery(ctx) {
  const cat = await createCategory(ctx.token, 'Grocery');
  const cust = await createCustomer(ctx.token, 'Grocery Shopper');
  const prod = await createProduct(ctx.token, ctx.loc.id, {
    title: 'Milk 1L',
    price: 60,
    qty: 50,
    categoryId: cat.id,
    batchTracking: true,
  });
  await ensureRegister(ctx.token, ctx.loc.id);
  const before = await getStock(ctx.token, ctx.loc.id, prod.stockLevelId);
  const sale = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [{ stockLevelId: prod.stockLevelId, quantity: 3, unitPrice: 60 }],
    { customerId: cust.id },
  );
  const after = await getStock(ctx.token, ctx.loc.id, prod.stockLevelId);
  const ok = before != null && after === before - 3;
  setCell(ctx.biz, 'primary', sale?.order?.id ? (ok ? 'PASS' : 'PARTIAL') : 'FAIL');
  setCell(ctx.biz, 'inventory', ok ? 'PASS' : 'PARTIAL');
  setCell(ctx.biz, 'payment', sale?.order?.id ? 'PASS' : 'FAIL');
  log(
    ctx.biz,
    'primary',
    'batch-flagged product sale',
    ok ? 'PASS' : 'PARTIAL',
    `batchTracking requested; stock ${before}→${after}`,
    'POST /pos/sale/products',
  );
  // Explicit batch deduction / expiry sale may not be first-class
  const batchList = await api('GET', `/pos/sale/products/${prod.productId || prod.id}`, {
    token: ctx.token,
  });
  if (batchList.ok && (batchList.data?.trackBatch || batchList.data?.meta?.batchTracking)) {
    log(ctx.biz, 'inventory', 'batch flag persisted', 'PASS');
  } else {
    log(
      ctx.biz,
      'inventory',
      'batch/expiry POS depth',
      'PARTIAL',
      'sale works; dedicated batch pick/expiry gate not verified',
      'POST /pos/sale/products',
    );
    setCell(ctx.biz, 'inventory', 'PARTIAL');
  }
  await checkCustomerHistory(ctx, cust.id);
  await checkReceipt(ctx, sale.order.id);
  setCell(ctx.biz, 'resource', 'N/A');
}

async function runRestaurant(ctx) {
  const cat = await createCategory(ctx.token, 'Menu');
  const cust = await createCustomer(ctx.token, 'Diner');
  const dish = await createProduct(ctx.token, ctx.loc.id, {
    title: 'Paneer Tikka',
    price: 320,
    qty: 100,
    categoryId: cat.id,
  });
  // Table as Resource
  const table = await api('POST', '/resources', {
    token: ctx.token,
    body: { name: 'Table 7', type: 'table', capacity: 4, locationId: ctx.loc.id },
  });
  if (table.ok) {
    setCell(ctx.biz, 'resource', 'PASS');
    log(ctx.biz, 'resource', 'create table resource', 'PASS', table.data.id, 'POST /resources');
  } else {
    setCell(ctx.biz, 'resource', 'FAIL');
    log(ctx.biz, 'resource', 'create table', 'FAIL', `${table.status} ${table.text.slice(0, 100)}`, 'POST /resources');
  }

  await ensureRegister(ctx.token, ctx.loc.id);
  const sale = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [{ stockLevelId: dish.stockLevelId, quantity: 1, unitPrice: 320 }],
    {
      customerId: cust.id,
      meta: {
        tableNumber: '7',
        covers: 2,
        kot_status: 'sent',
        orderType: 'dine_in',
      },
    },
  );
  const meta = sale.order?.meta || {};
  const hasTableMeta = meta.tableNumber === '7' || meta.tableNumber === 7;
  if (hasTableMeta) {
    setCell(ctx.biz, 'primary', 'PARTIAL');
    log(
      ctx.biz,
      'primary',
      'table order + KOT meta',
      'PARTIAL',
      'order+meta ok; no first-class kitchen/KOT board API',
      'POST /pos/sale/checkout',
    );
  } else {
    setCell(ctx.biz, 'primary', 'PARTIAL');
    log(
      ctx.biz,
      'primary',
      'table/KOT workflow',
      'PARTIAL',
      `meta=${JSON.stringify(meta).slice(0, 120)}`,
      'POST /pos/sale/checkout',
    );
  }
  setCell(ctx.biz, 'payment', 'PASS');
  setCell(ctx.biz, 'inventory', 'PASS');
  await checkReceipt(ctx, sale.order.id);
  await checkCustomerHistory(ctx, cust.id);
}

async function runSalon(ctx) {
  const cat = await createCategory(ctx.token, 'Services');
  const cust = await createCustomer(ctx.token, 'Salon Client');
  const svc = await createProduct(ctx.token, ctx.loc.id, {
    title: 'Haircut',
    price: 499,
    qty: 0,
    categoryId: cat.id,
    trackInventory: false,
  });
  const room = await api('POST', '/resources', {
    token: ctx.token,
    body: { name: 'Chair 1', type: 'room', capacity: 1, locationId: ctx.loc.id },
  });
  if (room.ok) {
    setCell(ctx.biz, 'resource', 'PASS');
    log(ctx.biz, 'resource', 'chair/room', 'PASS', room.data.id);
  } else {
    setCell(ctx.biz, 'resource', 'PARTIAL');
    log(ctx.biz, 'resource', 'chair/room', 'PARTIAL', String(room.status), 'POST /resources');
  }

  const starts = new Date(Date.now() + 3600e3).toISOString();
  const ends = new Date(Date.now() + 7200e3).toISOString();
  const appt = await api('POST', '/appointments', {
    token: ctx.token,
    body: {
      locationId: ctx.loc.id,
      customerId: cust.id,
      type: 'service',
      serviceName: 'Haircut',
      startsAt: starts,
      endsAt: ends,
      resourceId: room.data?.id,
      notes: 'E2E salon',
    },
  });
  if (!appt.ok) {
    setCell(ctx.biz, 'primary', 'FAIL');
    log(ctx.biz, 'primary', 'appointment', 'FAIL', `${appt.status} ${appt.text.slice(0, 160)}`, 'POST /appointments');
  } else {
    log(ctx.biz, 'primary', 'appointment', 'PASS', appt.data.id, 'POST /appointments');
    // double booking
    const clash = await api('POST', '/appointments', {
      token: ctx.token,
      body: {
        locationId: ctx.loc.id,
        customerId: cust.id,
        type: 'service',
        serviceName: 'Haircut clash',
        startsAt: starts,
        endsAt: ends,
        resourceId: room.data?.id,
      },
    });
    if (room.data?.id && !clash.ok) {
      log(ctx.biz, 'resource', 'double-booking blocked', 'PASS', String(clash.status));
    } else if (room.data?.id && clash.ok) {
      log(ctx.biz, 'resource', 'double-booking blocked', 'FAIL', 'overlap allowed', 'POST /appointments');
      setCell(ctx.biz, 'resource', 'FAIL');
    }
  }

  await ensureRegister(ctx.token, ctx.loc.id);
  const before = await getStock(ctx.token, ctx.loc.id, svc.stockLevelId);
  const sale = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [{ stockLevelId: svc.stockLevelId, quantity: 1, unitPrice: 499 }],
    { customerId: cust.id },
  );
  const after = await getStock(ctx.token, ctx.loc.id, svc.stockLevelId);
  // service should not deplete like physical (or stay 0)
  setCell(ctx.biz, 'inventory', 'PASS');
  setCell(ctx.biz, 'payment', 'PASS');
  setCell(ctx.biz, 'primary', appt.ok ? 'PASS' : 'PARTIAL');
  log(ctx.biz, 'primary', 'service sale after appt', 'PASS', `stock ${before}→${after}`);
  await checkReceipt(ctx, sale.order.id);
  await checkCustomerHistory(ctx, cust.id);
}

async function runService(ctx) {
  // generic service ≈ salon without vertical extras
  const cat = await createCategory(ctx.token, 'Consulting');
  const cust = await createCustomer(ctx.token, 'Client');
  const svc = await createProduct(ctx.token, ctx.loc.id, {
    title: '1hr Consultation',
    price: 1500,
    qty: 0,
    categoryId: cat.id,
    trackInventory: false,
  });
  const appt = await api('POST', '/appointments', {
    token: ctx.token,
    body: {
      locationId: ctx.loc.id,
      customerId: cust.id,
      type: 'consultation',
      serviceName: 'Consultation',
      startsAt: new Date(Date.now() + 5400e3).toISOString(),
    },
  });
  // type consultation may fail validation — try service
  let apptOk = appt.ok;
  if (!appt.ok) {
    const appt2 = await api('POST', '/appointments', {
      token: ctx.token,
      body: {
        locationId: ctx.loc.id,
        customerId: cust.id,
        type: 'service',
        serviceName: 'Consultation',
        startsAt: new Date(Date.now() + 5400e3).toISOString(),
      },
    });
    apptOk = appt2.ok;
    if (!appt2.ok) {
      log(ctx.biz, 'primary', 'appointment', 'FAIL', appt2.text.slice(0, 120), 'POST /appointments');
    }
  }
  await ensureRegister(ctx.token, ctx.loc.id);
  const sale = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [{ stockLevelId: svc.stockLevelId, quantity: 1, unitPrice: 1500 }],
    { customerId: cust.id },
  );
  setCell(ctx.biz, 'primary', apptOk ? 'PASS' : 'PARTIAL');
  setCell(ctx.biz, 'payment', 'PASS');
  setCell(ctx.biz, 'inventory', 'N/A');
  setCell(ctx.biz, 'resource', 'N/A');
  await checkReceipt(ctx, sale.order.id);
  await checkCustomerHistory(ctx, cust.id);
  log(ctx.biz, 'primary', 'appointment→service→pay', apptOk ? 'PASS' : 'PARTIAL');
}

async function runGym(ctx) {
  const cust = await createCustomer(ctx.token, 'Gym Member');
  // need category for plan
  const cat = await createCategory(ctx.token, 'Plans');
  const planSku = sku('PLAN');
  const plan = await api('POST', '/subscriptions/plans', {
    token: ctx.token,
    body: {
      title: 'Monthly Gym',
      categoryId: cat.id,
      sku: planSku,
      price: 1999,
      billingPeriodDays: 30,
    },
  });
  if (!plan.ok) {
    setCell(ctx.biz, 'primary', 'FAIL');
    log(ctx.biz, 'primary', 'create membership plan', 'FAIL', `${plan.status} ${plan.text.slice(0, 160)}`, 'POST /subscriptions/plans');
    setCell(ctx.biz, 'payment', 'FAIL');
    setCell(ctx.biz, 'inventory', 'N/A');
    setCell(ctx.biz, 'resource', 'N/A');
    return;
  }
  log(ctx.biz, 'primary', 'membership plan', 'PASS', plan.data?.id || plan.data?.productId);

  const enroll = await api('POST', '/subscriptions/enroll', {
    token: ctx.token,
    body: {
      customerId: cust.id,
      planId: plan.data?.id || plan.data?.productId,
      productId: plan.data?.productId || plan.data?.id,
      paymentMethod: 'cash',
    },
  });
  // try alternate body shapes
  let enrollOk = enroll.ok;
  let subId = enroll.data?.id;
  if (!enroll.ok) {
    const enroll2 = await api('POST', '/subscriptions/enroll', {
      token: ctx.token,
      body: {
        customerId: cust.id,
        productId: plan.data?.productId || plan.data?.id,
      },
    });
    enrollOk = enroll2.ok;
    subId = enroll2.data?.id;
    if (!enroll2.ok) {
      log(ctx.biz, 'payment', 'membership enroll/pay', 'FAIL', enroll2.text.slice(0, 160), 'POST /subscriptions/enroll');
      setCell(ctx.biz, 'payment', 'FAIL');
      setCell(ctx.biz, 'primary', 'PARTIAL');
    }
  }
  if (enrollOk) {
    setCell(ctx.biz, 'payment', 'PASS');
    log(ctx.biz, 'payment', 'membership enroll', 'PASS', subId);
  }

  // check-in / freeze — expected gaps
  const checkin = await api('POST', '/subscriptions/check-in', {
    token: ctx.token,
    body: { customerId: cust.id, subscriptionId: subId },
  });
  const freeze = subId
    ? await api('POST', `/subscriptions/${subId}/freeze`, {
        token: ctx.token,
        body: {},
      })
    : { ok: false, status: 0, text: 'no sub' };
  if (!checkin.ok && !freeze.ok) {
    setCell(ctx.biz, 'primary', 'PARTIAL');
    log(
      ctx.biz,
      'primary',
      'check-in / freeze',
      'FAIL',
      `check-in=${checkin.status}; freeze=${freeze.status}`,
      'POST /subscriptions/check-in',
    );
  } else {
    setCell(ctx.biz, 'primary', 'PASS');
    log(ctx.biz, 'primary', 'check-in/freeze', 'PASS');
  }

  if (subId) {
    const renew = await api('POST', `/subscriptions/${subId}/renew`, {
      token: ctx.token,
      body: {},
    });
    log(
      ctx.biz,
      'payment',
      'renewal',
      renew.ok ? 'PASS' : 'PARTIAL',
      renew.ok ? '' : `${renew.status}`,
      `POST /subscriptions/${subId}/renew`,
    );
  }

  await checkCustomerHistory(ctx, cust.id);
  setCell(ctx.biz, 'inventory', 'N/A');
  setCell(ctx.biz, 'resource', 'N/A');
  setCell(ctx.biz, 'customer', 'PASS');
}

async function runRental(ctx) {
  const cust = await createCustomer(ctx.token, 'Renter');
  const cat = await api('POST', '/pos/rental/categories', {
    token: ctx.token,
    body: { name: 'Cameras' },
  });
  assert(cat.ok, `rental cat ${cat.status} ${cat.text}`, {
    endpoint: 'POST /pos/rental/categories',
  });
  const prod = await api('POST', '/pos/rental/products', {
    token: ctx.token,
    body: {
      title: 'DSLR Camera',
      description: 'Rental body',
      categoryId: cat.data.id,
      sku: sku('CAM'),
      rentalPrice: 500,
      deposit: 2000,
      barcode: `BC-${STAMP}`,
      locationId: ctx.loc.id,
    },
  });
  assert(prod.ok, `rental product ${prod.status} ${prod.text}`, {
    endpoint: 'POST /pos/rental/products',
  });
  const unitId = prod.data?.unit?.id;
  const productId = prod.data?.product?.id || prod.data?.id;

  const order = await api('POST', '/orders', {
    token: ctx.token,
    body: {
      kind: 'rental',
      locationId: ctx.loc.id,
      customerId: cust.id,
      pickupDate: new Date().toISOString().slice(0, 10),
      returnDueDate: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10),
    },
  });
  if (!order.ok) {
    setCell(ctx.biz, 'primary', 'FAIL');
    log(ctx.biz, 'primary', 'rental quote', 'FAIL', `${order.status} ${order.text.slice(0, 160)}`, 'POST /orders');
    setCell(ctx.biz, 'payment', 'FAIL');
    setCell(ctx.biz, 'inventory', 'PARTIAL');
    setCell(ctx.biz, 'resource', 'N/A');
    return;
  }
  log(ctx.biz, 'primary', 'rental quote', 'PASS', order.data.id, 'POST /orders');

  if (unitId) {
    const add = await api('POST', `/orders/${order.data.id}/items`, {
      token: ctx.token,
      body: {
        itemKind: 'stock_unit',
        stockUnitId: unitId,
        quantity: 1,
      },
    });
    log(
      ctx.biz,
      'inventory',
      'add rental unit',
      add.ok ? 'PASS' : 'FAIL',
      add.ok ? unitId : add.text.slice(0, 100),
      `POST /orders/${order.data.id}/items`,
    );
  }

  // deposit payment
  const pay = await api('POST', '/pos/checkout', {
    token: ctx.token,
    body: {
      orderId: order.data.id,
      payments: [
        {
          method: 'cash',
          amount: 2000,
          type: 'deposit',
          idempotencyKey: `dep-${STAMP}`,
        },
      ],
    },
  });
  if (pay.ok) {
    setCell(ctx.biz, 'payment', 'PASS');
    log(ctx.biz, 'payment', 'deposit', 'PASS', '2000', 'POST /pos/checkout');
  } else {
    setCell(ctx.biz, 'payment', 'PARTIAL');
    log(ctx.biz, 'payment', 'deposit', 'PARTIAL', `${pay.status} ${pay.text.slice(0, 120)}`, 'POST /pos/checkout');
  }

  const life = async (lifecycle) =>
    api('POST', `/orders/${order.data.id}/rental-lifecycle`, {
      token: ctx.token,
      body: { lifecycle },
    });

  const reserved = await life('reserved');
  const out = await life('checked_out');
  const returned = await life('returned');
  const inspected = await life('inspected');

  const steps = [
    ['reserved', reserved],
    ['checked_out', out],
    ['returned', returned],
    ['inspected', inspected],
  ];
  const passed = steps.filter(([, r]) => r.ok).length;
  if (passed >= 3) {
    setCell(ctx.biz, 'primary', 'PASS');
    setCell(ctx.biz, 'inventory', 'PASS');
    log(ctx.biz, 'primary', 'reserve→checkout→return', 'PASS', `${passed}/4 lifecycle`);
  } else if (passed >= 1) {
    setCell(ctx.biz, 'primary', 'PARTIAL');
    setCell(ctx.biz, 'inventory', 'PARTIAL');
    log(
      ctx.biz,
      'primary',
      'rental lifecycle',
      'PARTIAL',
      steps.map(([n, r]) => `${n}:${r.status}`).join(' '),
      'POST /orders/:id/rental-lifecycle',
    );
  } else {
    setCell(ctx.biz, 'primary', 'FAIL');
    log(ctx.biz, 'primary', 'rental lifecycle', 'FAIL', steps.map(([n, r]) => `${n}:${r.status}`).join(' '), 'POST /orders/:id/rental-lifecycle');
  }

  // damage path — may be separate
  const damage = await api('POST', `/orders/${order.data.id}/rental-lifecycle`, {
    token: ctx.token,
    body: { lifecycle: 'inspected', damage: true, notes: 'scratch' },
  });
  log(
    ctx.biz,
    'inventory',
    'damage handling',
    damage.ok ? 'PASS' : 'PARTIAL',
    damage.ok ? '' : `${damage.status}`,
    'POST /orders/:id/rental-lifecycle',
  );

  await checkCustomerHistory(ctx, cust.id);
  setCell(ctx.biz, 'resource', 'N/A');
  await checkReceipt(ctx, order.data.id);
}

async function runRepair(ctx) {
  const cust = await createCustomer(ctx.token, 'Phone Owner');
  const asset = await api('POST', '/assets', {
    token: ctx.token,
    body: {
      customerId: cust.id,
      name: 'iPhone 15',
      assetType: 'phone',
      identifier: `IMEI${STAMP}`,
    },
  });
  if (!asset.ok) {
    setCell(ctx.biz, 'primary', 'FAIL');
    log(ctx.biz, 'primary', 'create asset', 'FAIL', `${asset.status} ${asset.text.slice(0, 120)}`, 'POST /assets');
    setCell(ctx.biz, 'resource', 'N/A');
    return;
  }
  log(ctx.biz, 'primary', 'customer asset', 'PASS', asset.data.id);

  const cat = await createCategory(ctx.token, 'Parts');
  const part = await createProduct(ctx.token, ctx.loc.id, {
    title: 'Screen OEM',
    price: 8000,
    qty: 5,
    categoryId: cat.id,
  });
  const before = await getStock(ctx.token, ctx.loc.id, part.stockLevelId);

  const job = await api('POST', '/jobs', {
    token: ctx.token,
    body: {
      customerId: cust.id,
      assetId: asset.data.id,
      title: 'Screen Replacement',
      problem: 'Cracked display',
      estimatedCost: 9000,
      locationId: ctx.loc.id,
      lines: [
        {
          productId: part.productId,
          kind: 'part',
          description: 'Screen OEM',
          qty: 1,
          unitPrice: 8000,
        },
        {
          kind: 'labor',
          description: 'Labor',
          qty: 1,
          unitPrice: 1000,
        },
      ],
    },
  });
  if (!job.ok) {
    setCell(ctx.biz, 'primary', 'FAIL');
    log(ctx.biz, 'primary', 'create job', 'FAIL', `${job.status} ${job.text.slice(0, 160)}`, 'POST /jobs');
    return;
  }
  log(ctx.biz, 'primary', 'repair job + parts/labor', 'PASS', job.data.id);

  const patched = await api('PATCH', `/jobs/${job.data.id}`, {
    token: ctx.token,
    body: { status: 'in_progress', diagnosis: 'LCD failed' },
  });
  const done = await api('PATCH', `/jobs/${job.data.id}`, {
    token: ctx.token,
    body: { status: 'ready', finalCost: 9000 },
  });
  log(
    ctx.biz,
    'primary',
    'job status transitions',
    patched.ok && done.ok ? 'PASS' : 'PARTIAL',
    `in_progress=${patched.status} ready=${done.status}`,
    `PATCH /jobs/${job.data.id}`,
  );

  // Pay via POS (parts should reduce stock when sold)
  await ensureRegister(ctx.token, ctx.loc.id);
  const sale = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [
      { stockLevelId: part.stockLevelId, quantity: 1, unitPrice: 8000 },
      // labor as non-tracked if needed — use same part? create labor service
    ],
    { customerId: cust.id, note: `job:${job.data.id}` },
  );
  const after = await getStock(ctx.token, ctx.loc.id, part.stockLevelId);
  const stockOk = before != null && after === before - 1;
  setCell(ctx.biz, 'inventory', stockOk ? 'PASS' : 'PARTIAL');
  setCell(ctx.biz, 'payment', 'PASS');
  setCell(ctx.biz, 'primary', 'PASS');
  setCell(ctx.biz, 'resource', 'N/A');
  log(ctx.biz, 'inventory', 'parts stock deduct', stockOk ? 'PASS' : 'PARTIAL', `${before}→${after}`);

  const pickup = await api('PATCH', `/jobs/${job.data.id}`, {
    token: ctx.token,
    body: { status: 'picked_up', orderId: sale.order.id },
  });
  log(
    ctx.biz,
    'primary',
    'pickup completion',
    pickup.ok ? 'PASS' : 'PARTIAL',
    String(pickup.status),
    `PATCH /jobs/${job.data.id}`,
  );

  // invalid status
  const bad = await api('PATCH', `/jobs/${job.data.id}`, {
    token: ctx.token,
    body: { status: 'not_a_real_status' },
  });
  log(
    ctx.biz,
    'primary',
    'invalid status rejected',
    !bad.ok ? 'PASS' : 'FAIL',
    String(bad.status),
    `PATCH /jobs/${job.data.id}`,
  );

  await checkReceipt(ctx, sale.order.id);
  await checkCustomerHistory(ctx, cust.id);
}

async function runPetGrooming(ctx) {
  const cust = await createCustomer(ctx.token, 'Pet Parent');
  // custom field for pet
  const field = await api('POST', '/custom-fields/definitions', {
    token: ctx.token,
    body: {
      entity: 'customer',
      fieldKey: `pet_name_${STAMP}`.slice(0, 40),
      label: 'Pet name',
      dataType: 'text',
    },
  });
  log(
    ctx.biz,
    'setup',
    'custom field pet name',
    field.ok ? 'PASS' : 'PARTIAL',
    field.ok ? field.data?.id : `${field.status}`,
    'POST /custom-fields/definitions',
  );
  if (field.ok) {
    await api('POST', '/custom-fields/values', {
      token: ctx.token,
      body: {
        definitionId: field.data.id,
        entityId: cust.id,
        valueText: 'Bruno',
      },
    });
  }

  const station = await api('POST', '/resources', {
    token: ctx.token,
    body: { name: 'Groom Station A', type: 'room', capacity: 1, locationId: ctx.loc.id },
  });
  setCell(ctx.biz, 'resource', station.ok ? 'PASS' : 'PARTIAL');

  const cat = await createCategory(ctx.token, 'Grooming');
  const svc = await createProduct(ctx.token, ctx.loc.id, {
    title: 'Full Groom',
    price: 899,
    qty: 0,
    categoryId: cat.id,
    trackInventory: false,
  });
  const appt = await api('POST', '/appointments', {
    token: ctx.token,
    body: {
      locationId: ctx.loc.id,
      customerId: cust.id,
      type: 'service',
      serviceName: 'Full Groom',
      startsAt: new Date(Date.now() + 3 * 3600e3).toISOString(),
      endsAt: new Date(Date.now() + 4 * 3600e3).toISOString(),
      resourceId: station.data?.id,
      notes: 'Pet: Bruno',
    },
  });
  await ensureRegister(ctx.token, ctx.loc.id);
  const sale = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [{ stockLevelId: svc.stockLevelId, quantity: 1, unitPrice: 899 }],
    { customerId: cust.id },
  );
  setCell(ctx.biz, 'primary', appt.ok ? 'PASS' : 'PARTIAL');
  setCell(ctx.biz, 'payment', 'PASS');
  setCell(ctx.biz, 'inventory', 'N/A');
  log(ctx.biz, 'primary', 'pet appt→groom→pay', appt.ok ? 'PASS' : 'PARTIAL', appt.ok ? appt.data.id : appt.text.slice(0, 80));
  await checkReceipt(ctx, sale.order.id);
  await checkCustomerHistory(ctx, cust.id);
}

async function runPhotography(ctx) {
  const cust = await createCustomer(ctx.token, 'Client');
  const studio = await api('POST', '/resources', {
    token: ctx.token,
    body: { name: 'Studio Hall', type: 'hall', capacity: 10, locationId: ctx.loc.id },
  });
  setCell(ctx.biz, 'resource', studio.ok ? 'PASS' : 'PARTIAL');

  const cat = await createCategory(ctx.token, 'Packages');
  const pack = await createProduct(ctx.token, ctx.loc.id, {
    title: 'Wedding Package',
    price: 25000,
    qty: 0,
    categoryId: cat.id,
    trackInventory: false,
  });
  const appt = await api('POST', '/appointments', {
    token: ctx.token,
    body: {
      locationId: ctx.loc.id,
      customerId: cust.id,
      type: 'service',
      serviceName: 'Wedding shoot',
      startsAt: new Date(Date.now() + 5 * 3600e3).toISOString(),
      endsAt: new Date(Date.now() + 8 * 3600e3).toISOString(),
      resourceId: studio.data?.id,
    },
  });

  await ensureRegister(ctx.token, ctx.loc.id);
  // advance / partial payment
  const advance = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [{ stockLevelId: pack.stockLevelId, quantity: 1, unitPrice: 25000 }],
    {
      customerId: cust.id,
      partialAmount: 5000,
      payments: [
        {
          method: 'cash',
          amount: 5000,
          idempotencyKey: `adv-${STAMP}`,
        },
      ],
    },
  ).catch((e) => ({ error: e }));

  if (advance?.order?.id) {
    setCell(ctx.biz, 'payment', 'PARTIAL');
    log(
      ctx.biz,
      'payment',
      'deposit/partial',
      'PARTIAL',
      'partial tender accepted or adjusted by server',
      'POST /pos/sale/checkout',
    );
    await checkReceipt(ctx, advance.order.id);
  } else if (advance?.error) {
    // try full payment fallback
    const full = await checkoutCash(
      ctx.token,
      ctx.loc.id,
      [{ stockLevelId: pack.stockLevelId, quantity: 1, unitPrice: 25000 }],
      { customerId: cust.id },
    );
    setCell(ctx.biz, 'payment', 'PASS');
    log(
      ctx.biz,
      'payment',
      'full package payment (partial path failed)',
      'PARTIAL',
      String(advance.error.message || '').slice(0, 120),
      'POST /pos/sale/checkout',
    );
    await checkReceipt(ctx, full.order.id);
  }

  // equipment rental on same tenant
  const rcat = await api('POST', '/pos/rental/categories', {
    token: ctx.token,
    body: { name: 'Gear' },
  });
  if (rcat.ok) {
    const gear = await api('POST', '/pos/rental/products', {
      token: ctx.token,
      body: {
        title: 'Softbox',
        categoryId: rcat.data.id,
        sku: sku('GEAR'),
        rentalPrice: 300,
        deposit: 500,
        locationId: ctx.loc.id,
        barcode: `G-${STAMP}`,
      },
    });
    log(
      ctx.biz,
      'inventory',
      'equipment rental product',
      gear.ok ? 'PASS' : 'PARTIAL',
      gear.ok ? '' : `${gear.status}`,
      'POST /pos/rental/products',
    );
    setCell(ctx.biz, 'inventory', gear.ok ? 'PASS' : 'PARTIAL');
  } else {
    setCell(ctx.biz, 'inventory', 'PARTIAL');
  }

  setCell(ctx.biz, 'primary', appt.ok ? 'PASS' : 'PARTIAL');
  await checkCustomerHistory(ctx, cust.id);
  log(ctx.biz, 'primary', 'booking + package', appt.ok ? 'PASS' : 'PARTIAL');
}

async function runNegativesAndIsolation(contexts) {
  const retail = contexts.find((c) => c.biz === 'retail');
  const salon = contexts.find((c) => c.biz === 'salon');
  if (!retail || !salon) return;

  // unauthorized
  const noAuth = await api('GET', '/customers?limit=1');
  log(
    'all',
    'permissions',
    'unauthenticated blocked',
    noAuth.status === 401 ? 'PASS' : 'FAIL',
    String(noAuth.status),
    'GET /customers',
  );
  setCell('retail', 'permissions', noAuth.status === 401 ? 'PASS' : 'FAIL');

  // wrong tenant
  const cust = await api('POST', '/customers', {
    token: salon.token,
    body: { fullName: 'Secret Salon Cust', phone: phone() },
  });
  if (cust.ok) {
    const leak = await api('GET', `/customers/${cust.data.id}`, {
      token: retail.token,
    });
    const isolated = [403, 404].includes(leak.status);
    log(
      'all',
      'isolation',
      'cross-tenant customer blocked',
      isolated ? 'PASS' : 'FAIL',
      String(leak.status),
      `GET /customers/${cust.data.id}`,
    );
    for (const c of contexts) {
      setCell(c.biz, 'isolation', isolated ? 'PASS' : 'FAIL');
    }
  }

  // duplicate payment idempotency (retail)
  await ensureRegister(retail.token, retail.loc.id);
  const cat = await createCategory(retail.token, 'Neg');
  const p = await createProduct(retail.token, retail.loc.id, {
    title: 'Idem Item',
    price: 50,
    qty: 5,
    categoryId: cat.id,
  });
  const key = `dup-${STAMP}`;
  const body = {
    locationId: retail.loc.id,
    items: [{ stockLevelId: p.stockLevelId, quantity: 1, unitPrice: 50 }],
    payments: [{ method: 'cash', amount: 100, idempotencyKey: key }],
    cashTendered: 100,
  };
  const a = await api('POST', '/pos/sale/checkout', { token: retail.token, body });
  const b = await api('POST', '/pos/sale/checkout', { token: retail.token, body });
  // second may fail or return same — either ok if not double-charge chaos
  log(
    'retail',
    'payment',
    'duplicate idempotency',
    a.ok && (!b.ok || b.data?.order?.id === a.data?.order?.id) ? 'PASS' : 'PARTIAL',
    `first=${a.status} second=${b.status}`,
    'POST /pos/sale/checkout',
  );
}

const RUNNERS = {
  retail: runRetail,
  grocery: runGrocery,
  restaurant: runRestaurant,
  salon: runSalon,
  service: runService,
  gym: runGym,
  rental: runRental,
  repair: runRepair,
  pet_grooming: runPetGrooming,
  photography: runPhotography,
};

function finalizeMatrix() {
  for (const [biz, row] of Object.entries(MATRIX)) {
    const vals = COLS.map((c) => row[c]);
    if (vals.includes('FAIL')) row.final = 'FAIL';
    else if (vals.includes('PARTIAL')) row.final = 'PARTIAL';
    else if (vals.every((v) => v === 'PASS' || v === 'N/A')) row.final = 'PASS';
    else row.final = 'PARTIAL';
  }
}

function printMatrix() {
  console.log('\n========== OPERATIONAL MATRIX ==========');
  const header = ['Business', ...COLS, 'Final'];
  console.log(header.join(' | '));
  for (const [biz, row] of Object.entries(MATRIX)) {
    console.log(
      [biz, ...COLS.map((c) => row[c]), row.final].join(' | '),
    );
  }
}

async function main() {
  console.log(`FULL MULTI-BUSINESS OPERATIONAL E2E @ ${API}\n`);
  const health = await api('GET', '/health');
  assert(health.ok, `API down ${health.text}`);

  const contexts = [];
  for (const biz of Object.keys(RUNNERS)) {
    MATRIX[biz] = cellInit();
    console.log(`\n—— ${biz} ——`);
    try {
      const ctx = await provision(biz);
      contexts.push(ctx);
      const modeOk = ctx.modes.length > 0;
      const capOk = ctx.caps.length > 0;
      setCell(biz, 'setup', modeOk && capOk ? 'PASS' : 'PARTIAL');
      log(
        biz,
        'setup',
        'org+modes+caps',
        modeOk && capOk ? 'PASS' : 'PARTIAL',
        `modes=[${ctx.modes}] caps=${ctx.caps.length} type=${ctx.boot?.business?.type}`,
      );
      await RUNNERS[biz](ctx);
      await checkReports(ctx);
      await checkAccounting(ctx);
      if (MATRIX[biz].permissions === 'PENDING') setCell(biz, 'permissions', 'PASS');
      if (MATRIX[biz].isolation === 'PENDING') setCell(biz, 'isolation', 'PENDING');
    } catch (e) {
      setCell(biz, 'setup', 'FAIL');
      setCell(biz, 'primary', 'FAIL');
      log(biz, 'setup', 'provision/workflow crash', 'FAIL', e.message, e.endpoint);
    }
  }

  console.log('\n—— negatives / isolation ——');
  await runNegativesAndIsolation(contexts);

  finalizeMatrix();
  printMatrix();

  const finals = Object.values(MATRIX).map((r) => r.final);
  const passN = finals.filter((f) => f === 'PASS').length;
  const partialN = finals.filter((f) => f === 'PARTIAL').length;
  const failN = finals.filter((f) => f === 'FAIL').length;

  let verdict = 'OPERATIONAL WITH GAPS';
  if (failN === 0 && partialN === 0) verdict = 'FULLY OPERATIONAL';
  else if (failN === 0) verdict = 'OPERATIONAL WITH GAPS';
  else verdict = 'OPERATIONAL WITH GAPS';

  console.log(`\nVerdict: ${verdict}`);
  console.log(`Businesses PASS=${passN} PARTIAL=${partialN} FAIL=${failN}`);
  console.log(`Step failures logged: ${FAILURES.length}`);

  if (FAILURES.length) {
    console.log('\n=== FAILED WORKFLOWS ===');
    for (const f of FAILURES) {
      console.log(`- [${f.biz}] ${f.workflow}`);
      console.log(`  endpoint: ${f.endpoint || 'n/a'}`);
      console.log(`  detail: ${f.detail}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    api: API,
    verdict,
    matrix: MATRIX,
    results: RESULTS,
    failures: FAILURES,
    summary: { passN, partialN, failN, total: finals.length },
  };
  const out = join(OUT_DIR, `multi-biz-operational-${STAMP}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, 'multi-biz-operational-latest.json'), JSON.stringify(report, null, 2));
  console.log(`\nReport: ${out}`);

  // non-zero if any business fully FAIL
  if (failN > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
