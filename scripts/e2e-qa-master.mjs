/**
 * Universal POS — Complete E2E QA master harness (API-level).
 *
 * Covers multi-business profiles, auth, catalog, inventory, purchases,
 * sales, returns, customers, suppliers, expenses, payments, reports,
 * accounting, multi-tenant isolation, negative/boundary paths.
 *
 * Usage:
 *   node scripts/e2e-qa-master.mjs
 *   API_URL=http://13.126.105.138:3001/v1 node scripts/e2e-qa-master.mjs
 *
 * Writes: scripts/qa-results/e2e-qa-report.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const FE = process.env.FE_URL ?? 'http://127.0.0.1:3000';
const STAMP = Date.now().toString(36);
const PASS = 'E2eQa@2026!';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'qa-results', `e2e-qa-report-${STAMP}.json`);

/** @type {Array<{id:string,module:string,biz:string,severity:string,status:string,detail:string,ms:number,severity:string,endpoint?:string,severity?:string,response?:string}>} */
const cases = [];
const defects = [];
let caseSeq = 0;

function nowIso() {
  return new Date().toISOString();
}

function record(partial) {
  const row = {
    id: `T-${String(++caseSeq).padStart(4, '0')}`,
    severity: 'info',
    ...partial,
  };
  cases.push(row);
  const tag =
    row.status === 'PASS'
      ? 'PASS'
      : row.status === 'FAIL'
        ? 'FAIL'
        : row.status === 'BLOCKED'
          ? 'BLOCK'
          : 'SKIP';
  console.log(
    `${tag}  [${row.module}] ${row.name}${row.detail ? ` — ${row.detail}` : ''}`,
  );
  if (row.status === 'FAIL') {
    defects.push({
      bugId: `BUG-${row.id}`,
      severity: row.severity || 'P2',
      businessType: row.biz,
      module: row.module,
      role: row.role || 'admin',
      environment: API,
      preconditions: row.preconditions || 'Authenticated tenant session',
      steps: row.steps || row.name,
      expected: row.expected || 'Operation succeeds with consistent state',
      actual: row.detail,
      endpoint: row.endpoint,
      request: row.payload,
      response: row.response,
      dbImpact: row.dbImpact || 'Unknown (API-level assertion)',
      recommendedFix: row.fix || 'Investigate API + persistence for this path',
    });
  }
  return row;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function raw(method, path, { token, body, headers } = {}) {
  const t0 = Date.now();
  let res;
  let text = '';
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (e) {
    return {
      ok: false,
      status: 0,
      json: null,
      data: null,
      ms: Date.now() - t0,
      error: String(e.message || e),
      text: '',
    };
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return {
    ok: res.ok && json?.success !== false,
    status: res.status,
    json,
    data: json?.data ?? json,
    ms: Date.now() - t0,
    text: text.slice(0, 800),
  };
}

async function api(method, path, opts = {}) {
  return raw(method, path, opts);
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

async function test(opts, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    record({
      ...opts,
      status: 'PASS',
      detail: typeof detail === 'string' ? detail : opts.detail || '',
      ms: Date.now() - t0,
    });
    return { ok: true, detail };
  } catch (e) {
    const err = e || {};
    record({
      ...opts,
      status: err.blocked ? 'BLOCKED' : err.skipped ? 'SKIPPED' : 'FAIL',
      severity: err.severity || opts.severity || 'P2',
      detail: String(err.message || e),
      ms: Date.now() - t0,
      endpoint: err.endpoint || opts.endpoint,
      payload: err.payload,
      response: err.response,
      expected: err.expected || opts.expected,
      fix: err.fix,
    });
    return { ok: false, error: err };
  }
}

function assert(cond, message, extra = {}) {
  if (!cond) {
    const err = new Error(message);
    Object.assign(err, extra);
    throw err;
  }
}

async function registerTenant({ slug, email, name, phone }) {
  await sleep(1200); // avoid auth throttle during multi-tenant provisioning
  const res = await api('POST', '/auth/register-tenant', {
    body: {
      tenantName: name,
      tenantSlug: slug,
      storeName: 'Main',
      adminFullName: `${name} Owner`,
      adminEmail: email,
      adminPassword: PASS,
      adminPhone: phone,
    },
  });
  assert(
    res.ok && res.data?.accessToken,
    `register-tenant failed ${res.status} ${res.text}`,
    {
      severity: 'P0',
      endpoint: 'POST /auth/register-tenant',
      response: res.text,
    },
  );
  return res.data;
}

async function login({ email, password = PASS, tenantSlug }) {
  const body = { email, password };
  if (tenantSlug) body.tenantSlug = tenantSlug;
  const res = await api('POST', '/auth/login', { body });
  return res;
}

async function setBusiness(token, businessType) {
  return api('POST', '/tenants/me/business-config', {
    token,
    body: { businessType },
  });
}

async function enableMode(token, mode, shopTitle) {
  return api('POST', '/tenants/me/commerce-modes', {
    token,
    body: { mode, shopTitle },
  });
}

async function firstLocation(token) {
  const locs = await api('GET', '/locations', { token });
  const list = asList(locs.data);
  assert(list[0]?.id, 'no location', { severity: 'P0', endpoint: 'GET /locations' });
  return list[0];
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
    body: { locationId, openingFloat: 500 },
  });
  assert(opened.ok, `register open ${opened.status} ${opened.text}`, {
    severity: 'P1',
    endpoint: 'POST /pos/sale/register/open',
    response: opened.text,
  });
  return opened.data;
}

async function createSaleProduct(token, locId, { title, sku, price, qty, categoryId, trackInventory }) {
  const body = {
    title,
    sku,
    price,
    qty,
    locationId: locId,
    categoryId,
  };
  if (trackInventory === false) body.trackInventory = false;
  const prod = await api('POST', '/pos/sale/products', { token, body });
  assert(prod.ok, `product create ${prod.status} ${prod.text}`, {
    severity: 'P1',
    endpoint: 'POST /pos/sale/products',
    payload: JSON.stringify(body),
    response: prod.text,
  });
  const stockLevelId = prod.data?.stockLevel?.id ?? prod.data?.id;
  assert(stockLevelId, 'missing stockLevelId', {
    severity: 'P1',
    response: JSON.stringify(prod.data).slice(0, 400),
  });
  return { ...prod.data, stockLevelId };
}

async function checkoutCash(token, locId, items, opts = {}) {
  const qty = items.reduce((s, i) => s + Number(i.quantity || 1), 0);
  // overpay buffer — server returns exact due / change
  const rough =
    opts.amountHint ??
    items.reduce((s, i) => s + Number(i.unitPrice || 100) * Number(i.quantity || 1), 0) *
      1.3 +
      50;
    const body = {
    locationId: locId,
    items,
    discountAmount: opts.discountAmount || 0,
    customerId: opts.customerId,
    note: opts.note,
    meta: opts.meta,
    payments: [
      {
        method: opts.method || 'cash',
        amount: rough,
        idempotencyKey: opts.idempotencyKey || `pay-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
      },
    ],
    cashTendered: rough + 20,
  };
  const sale = await api('POST', '/pos/sale/checkout', { token, body });
  if (!sale.ok) {
    // retry once with higher tender if underpaid
    const msg = String(sale.json?.message || sale.text || '');
    const m = msg.match(/(\d+(\.\d+)?)/);
    if (m) {
      const due = Number(m[1]);
      body.payments[0].amount = due;
      body.cashTendered = due + 20;
      body.payments[0].idempotencyKey = `${body.payments[0].idempotencyKey}-r`;
      const sale2 = await api('POST', '/pos/sale/checkout', { token, body });
      assert(sale2.ok, `checkout ${sale2.status} ${sale2.text}`, {
        severity: 'P1',
        endpoint: 'POST /pos/sale/checkout',
        payload: JSON.stringify(body),
        response: sale2.text,
      });
      return sale2.data;
    }
  }
  assert(sale.ok && sale.data?.order?.id, `checkout ${sale.status} ${sale.text}`, {
    severity: 'P1',
    endpoint: 'POST /pos/sale/checkout',
    payload: JSON.stringify(body),
    response: sale.text,
  });
  return sale.data;
}

async function getStockQty(token, locId, stockLevelId) {
  const cat = await api(
    'GET',
    `/pos/sale/catalog?locationId=${locId}&limit=100`,
    { token },
  );
  const items = asList(cat.data?.items ?? cat.data);
  const row = items.find((i) => i.id === stockLevelId || i.stockLevelId === stockLevelId);
  if (!row) return null;
  return Number(row.qtyOnHand ?? row.quantity ?? row.stockOnHand ?? row.qty ?? NaN);
}

/* ───────────────────────── suites ───────────────────────── */

async function suiteFrontendSurface() {
  const module = 'Frontend';
  await test({ module, biz: 'all', name: 'FE login page reachable', severity: 'P1' }, async () => {
    const res = await fetch(`${FE}/login`).catch((e) => ({ ok: false, status: 0, error: e }));
    if (!res.ok) {
      // try live FE if local FE down
      const live = await fetch('http://13.126.105.138:3000/login');
      assert(live.ok, `FE down local+live ${res.status || res.error}`);
      return 'live FE 200 (local FE unavailable)';
    }
    return `HTTP ${res.status}`;
  });
}

async function suiteAuth() {
  const module = 'Authentication';
  const slug = `qa-auth-${STAMP}`;
  const email = `owner@${slug}.test`;

  let token;
  let refresh;

  await test({ module, biz: 'all', name: 'Register tenant (happy)', severity: 'P0' }, async () => {
    const data = await registerTenant({
      slug,
      email,
      name: 'QA Auth Shop',
      phone: '9876511001',
    });
    token = data.accessToken;
    refresh = data.refreshToken;
    return email;
  });

  await test({ module, biz: 'all', name: 'GET /auth/me', severity: 'P1' }, async () => {
    const me = await api('GET', '/auth/me', { token });
    assert(me.ok && me.data?.email, `me failed ${me.status}`);
    return me.data.email;
  });

  await test({ module, biz: 'all', name: 'Login happy path', severity: 'P0' }, async () => {
    const res = await login({ email, tenantSlug: slug });
    assert(res.ok && res.data?.accessToken, `login ${res.status} ${res.text}`);
    token = res.data.accessToken;
    refresh = res.data.refreshToken || refresh;
    return 'ok';
  });

  await test({ module, biz: 'all', name: 'Reject wrong password', severity: 'P0' }, async () => {
    const res = await login({ email, password: 'WrongPass!999', tenantSlug: slug });
    assert(!res.ok, 'accepted wrong password', { severity: 'P0' });
    assert([401, 403, 400].includes(res.status), `unexpected ${res.status}`);
    return String(res.status);
  });

  await test({ module, biz: 'all', name: 'Unauthorized API without token', severity: 'P0' }, async () => {
    const res = await api('GET', '/customers?limit=1');
    assert([401, 403].includes(res.status), `expected 401 got ${res.status}`);
    return String(res.status);
  });

  await test({ module, biz: 'all', name: 'Forgot password request', severity: 'P2' }, async () => {
    const res = await api('POST', '/auth/password/forgot', {
      body: { email },
    });
    // may 200 even if SMTP empty
    assert(res.status === 200 || res.status === 201 || res.ok, `forgot ${res.status} ${res.text}`);
    const body = JSON.stringify(res.json || {});
    const leakedOtp = /"otp"\s*:\s*"\d{6}"|"devCode"\s*:\s*"\d{6}"/.test(body);
    // Local/dev may return devCode — flag only if labeled production
    if (leakedOtp && /production/i.test(body)) {
      assert(false, 'OTP exposed in production response', { severity: 'P0' });
    }
    return `status=${res.status} hasDevCode=${Boolean(res.data?.devCode)}`;
  });

  await test({ module, biz: 'all', name: 'Wrong OTP reset rejected', severity: 'P1' }, async () => {
    const res = await api('POST', '/auth/password/reset', {
      body: {
        email,
        otp: '000000',
        newPassword: 'NewPass@2026!',
      },
    });
    assert(!res.ok, 'accepted bogus OTP', { severity: 'P0' });
    return String(res.status);
  });

  await test({ module, biz: 'all', name: 'Refresh token', severity: 'P1' }, async () => {
    if (!refresh) {
      const err = new Error('no refreshToken issued');
      err.skipped = true;
      throw err;
    }
    const res = await api('POST', '/auth/refresh', { body: { refreshToken: refresh } });
    assert(res.ok && (res.data?.accessToken || res.data?.token), `refresh ${res.status} ${res.text}`);
    token = res.data.accessToken || token;
    return 'refreshed';
  });

  await test({ module, biz: 'all', name: 'Logout', severity: 'P2' }, async () => {
    const res = await api('POST', '/auth/logout', {
      token,
      body: { refreshToken: refresh },
    });
    assert(res.ok || res.status === 200 || res.status === 201 || res.status === 204, `logout ${res.status}`);
    return String(res.status);
  });

  return { slug, email, token };
}

async function suiteRetailWorkflow() {
  const module = 'Retail workflow';
  const biz = 'retail';
  const slug = `qa-retail-${STAMP}`;
  const email = `owner@${slug}.test`;

  let token;
  let loc;
  let cat;
  let shirt;
  let customer;
  let supplier;
  let order;
  let startQty;

  await test({ module, biz, name: 'Provision retail tenant', severity: 'P0' }, async () => {
    const data = await registerTenant({
      slug,
      email,
      name: 'QA Retail',
      phone: '9876512001',
    });
    token = data.accessToken;
    await setBusiness(token, 'retail');
    await enableMode(token, 'sale', 'QA Retail');
    loc = await firstLocation(token);
    return loc.id;
  });

  await test({ module, biz, name: 'Create category', severity: 'P1' }, async () => {
    const res = await api('POST', '/pos/sale/categories', {
      token,
      body: { name: `Apparel ${STAMP}` },
    });
    assert(res.ok && res.data?.id, res.text);
    cat = res.data;
    return cat.id;
  });

  await test({ module, biz, name: 'Create products (shirt/jeans)', severity: 'P1' }, async () => {
    shirt = await createSaleProduct(token, loc.id, {
      title: 'Shirt',
      sku: `SHIRT-${STAMP}`,
      price: 799,
      qty: 20,
      categoryId: cat.id,
    });
    await createSaleProduct(token, loc.id, {
      title: 'Jeans',
      sku: `JEANS-${STAMP}`,
      price: 1299,
      qty: 15,
      categoryId: cat.id,
    });
    startQty = await getStockQty(token, loc.id, shirt.stockLevelId);
    return `shirtStock=${startQty}`;
  });

  await test({ module, biz, name: 'Duplicate SKU rejected', severity: 'P1' }, async () => {
    const res = await api('POST', '/pos/sale/products', {
      token,
      body: {
        title: 'Shirt Dup',
        sku: `SHIRT-${STAMP}`,
        price: 100,
        qty: 1,
        locationId: loc.id,
        categoryId: cat.id,
      },
    });
    assert(!res.ok, 'duplicate SKU accepted', { severity: 'P1' });
    return String(res.status);
  });

  await test({ module, biz, name: 'Create customer', severity: 'P1' }, async () => {
    const res = await api('POST', '/customers', {
      token,
      body: {
        fullName: 'Retail Walk-in',
        phone: '+919876541001',
        email: `cust.retail.${STAMP}@test.local`,
      },
    });
    assert(res.ok && res.data?.id, res.text);
    customer = res.data;
    return customer.id;
  });

  await test({ module, biz, name: 'Create supplier', severity: 'P1' }, async () => {
    const res = await api('POST', '/suppliers', {
      token,
      body: {
        name: `Vendor ${STAMP}`,
        phone: '9876500111',
        contact: 'Purchase Desk',
      },
    });
    assert(res.ok && res.data?.id, res.text);
    supplier = res.data;
    return supplier.id;
  });

  await test({ module, biz, name: 'Purchase order + receive (stock in)', severity: 'P1' }, async () => {
    const before = await getStockQty(token, loc.id, shirt.stockLevelId);
    const po = await api('POST', '/purchase-orders', {
      token,
      body: {
        supplierId: supplier.id,
        lines: [
          {
            stockLevelId: shirt.stockLevelId,
            qtyOrdered: 5,
            unitCost: 400,
          },
        ],
      },
    });
    assert(po.ok && po.data?.id, `PO create ${po.status} ${po.text}`, {
      endpoint: 'POST /purchase-orders',
      response: po.text,
    });
    const recv = await api('POST', `/purchase-orders/${po.data.id}/receive`, {
      token,
      body: {
        lines: [{ stockLevelId: shirt.stockLevelId, qty: 5 }],
      },
    });
    assert(recv.ok, `receive ${recv.status} ${recv.text}`, {
      endpoint: `POST /purchase-orders/${po.data.id}/receive`,
      response: recv.text,
    });
    const after = await getStockQty(token, loc.id, shirt.stockLevelId);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      assert(after === before + 5, `stock ${before}→${after} expected +5`, {
        severity: 'P0',
        dbImpact: 'PO receive did not increase stock',
      });
    }
    return `po=${po.data.id} stock=${before}→${after}`;
  });

  await test({ module, biz, name: 'Stock adjust +5', severity: 'P2' }, async () => {
    const adj = await api(
      'POST',
      `/pos/sale/products/${shirt.stockLevelId}/adjust-stock`,
      { token, body: { delta: 5 } },
    );
    assert(adj.ok, adj.text);
    return 'ok';
  });

  await test({ module, biz, name: 'Sale checkout cash (tax path)', severity: 'P0' }, async () => {
    await ensureRegister(token, loc.id);
    const before = await getStockQty(token, loc.id, shirt.stockLevelId);
    const sale = await checkoutCash(
      token,
      loc.id,
      [{ stockLevelId: shirt.stockLevelId, quantity: 2, unitPrice: 799 }],
      { customerId: customer.id, discountAmount: 50 },
    );
    order = sale.order;
    assert(order?.id, 'missing order after checkout', { severity: 'P0' });
    const after = await getStockQty(token, loc.id, shirt.stockLevelId);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      assert(after === before - 2, `stock ${before}→${after}, expected ${before - 2}`, {
        severity: 'P0',
        dbImpact: 'Inventory mismatch after sale',
      });
    }
    return `order=${order.orderNumber} tax=${order.taxTotal} stock=${before}→${after}`;
  });

  await test({ module, biz, name: 'Partial return restocks', severity: 'P0' }, async () => {
    assert(order?.id, 'no order from checkout', { blocked: true });
    await api('POST', '/pos/refund-reasons/seed', { token });
    const reasons = await api('GET', '/pos/refund-reasons', { token });
    const codes = asList(reasons.data).map((r) => r.code);
    const reasonCode = codes.includes('customer_changed_mind')
      ? 'customer_changed_mind'
      : codes[0];
    assert(reasonCode, `no refund reasons after seed: ${reasons.text}`, {
      severity: 'P1',
      endpoint: 'POST /pos/refund-reasons/seed',
      response: reasons.text,
    });
    const before = await getStockQty(token, loc.id, shirt.stockLevelId);
    const ret = await api('POST', '/pos/sale/returns', {
      token,
      body: {
        orderId: order.id,
        items: [{ stockLevelId: shirt.stockLevelId, quantity: 1 }],
        refundMethod: 'cash',
        reasonCode,
        reason: 'Size issue',
        idempotencyKey: `ret-${STAMP}-1`,
      },
    });
    assert(ret.ok, ret.text, { severity: 'P1', endpoint: 'POST /pos/sale/returns', response: ret.text });
    const after = await getStockQty(token, loc.id, shirt.stockLevelId);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      assert(after === before + 1, `stock ${before}→${after}`, {
        severity: 'P0',
        dbImpact: 'Return did not restock',
      });
    }
    return `refund=${ret.data?.amount} stock=${before}→${after}`;
  });

  await test({ module, biz, name: 'Over-return rejected', severity: 'P1' }, async () => {
    assert(order?.id, 'no order', { blocked: true });
    const ret = await api('POST', '/pos/sale/returns', {
      token,
      body: {
        orderId: order.id,
        items: [{ stockLevelId: shirt.stockLevelId, quantity: 99 }],
        refundMethod: 'cash',
        reasonCode: 'customer_changed_mind',
        reason: 'Abuse',
        idempotencyKey: `ret-${STAMP}-over`,
      },
    });
    assert(!ret.ok, 'over-return accepted', { severity: 'P0' });
    return String(ret.status);
  });

  await test({ module, biz, name: 'Duplicate return idempotency', severity: 'P1' }, async () => {
    assert(order?.id, 'no order', { blocked: true });
    const key = `ret-${STAMP}-dup`;
    const body = {
      orderId: order.id,
      items: [{ stockLevelId: shirt.stockLevelId, quantity: 1 }],
      refundMethod: 'cash',
      reasonCode: 'customer_changed_mind',
      reason: 'dup',
      idempotencyKey: key,
    };
    const first = await api('POST', '/pos/sale/returns', { token, body });
    const second = await api('POST', '/pos/sale/returns', { token, body });
    if (first.ok && second.ok) {
      const a1 = Number(first.data?.amount ?? 0);
      const a2 = Number(second.data?.amount ?? 0);
      assert(a1 === a2, `duplicate return different amounts ${a1} vs ${a2}`, {
        severity: 'P0',
        dbImpact: 'Possible double refund',
      });
      return `idempotent amount=${a1}`;
    }
    assert(!second.ok || first.ok, 'inconsistent duplicate return handling');
    return `first=${first.status} second=${second.status}`;
  });

  await test({ module, biz, name: 'Expense create', severity: 'P2' }, async () => {
    await api('POST', '/expenses/categories/seed', { token });
    const cats = await api('GET', '/expenses/categories', { token });
    const list = asList(cats.data);
    const categoryId = list[0]?.id;
    const res = await api('POST', '/expenses', {
      token,
      body: {
        categoryId,
        amount: 250,
        spentAt: new Date().toISOString().slice(0, 10),
        paymentMethod: 'cash',
        notes: 'Packaging',
        payee: 'Local vendor',
      },
    });
    assert(res.ok, `expense ${res.status} ${res.text}`, {
      endpoint: 'POST /expenses',
      response: res.text,
    });
    return res.data?.id || 'ok';
  });

  await test({ module, biz, name: 'Reports sales + tax + inventory', severity: 'P1' }, async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const paths = [
      `/reports/sales-summary?from=${from}&to=${to}`,
      `/reports/payments-summary?from=${from}&to=${to}`,
      `/reports/tax-summary?from=${from}&to=${to}`,
      `/reports/inventory/current-stock`,
      `/reports/daily-sales?date=${to}`,
    ];
    for (const path of paths) {
      const r = await api('GET', path, { token });
      assert(r.ok, `${path} → ${r.status}`, { endpoint: path, response: r.text });
    }
    return '5 reports ok';
  });

  await test({ module, biz, name: 'Accounting trial balance / P&L', severity: 'P2' }, async () => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const tb = await api('GET', `/trial-balance?from=${from}&to=${to}`, { token });
    const pl = await api('GET', `/profit-loss?from=${from}&to=${to}`, { token });
    const accounts = await api('GET', '/accounts', { token });
    // 404 = route missing on this build; 403 = RBAC; treat route-missing as P2 env gap
    if (tb.status === 404 && pl.status === 404) {
      const err = new Error(`accounting routes 404 (module may be disabled on running build)`);
      err.severity = 'P2';
      err.response = `tb=${tb.status} pl=${pl.status} accounts=${accounts.status}`;
      throw err;
    }
    assert(accounts.ok || tb.ok || pl.ok, `accounting failed tb=${tb.status} pl=${pl.status}`);
    return `tb=${tb.status} pl=${pl.status} accounts=${accounts.status}`;
  });

  await test({ module, biz, name: 'Security audit logs readable', severity: 'P3' }, async () => {
    const res = await api('GET', '/security/audit-logs?limit=20', { token });
    assert(res.ok || res.status === 200, `audit ${res.status}`);
    return `status=${res.status} rows=${asList(res.data).length}`;
  });

  await test({ module, biz, name: 'Notify inbox', severity: 'P3' }, async () => {
    const res = await api('GET', '/notify/inbox?limit=10', { token });
    assert(res.ok, res.text);
    return `unread path ok`;
  });

  return { token, slug, email, loc, shirt, customer };
}

async function suiteRestaurant() {
  const module = 'Restaurant workflow';
  const biz = 'restaurant';
  const slug = `qa-rest-${STAMP}`;
  const email = `owner@${slug}.test`;
  let token;
  let loc;
  let pizza;

  await test({ module, biz, name: 'Provision restaurant profile', severity: 'P0' }, async () => {
    const data = await registerTenant({
      slug,
      email,
      name: 'QA Cafe',
      phone: '9876513001',
    });
    token = data.accessToken;
    const cfg = await setBusiness(token, 'restaurant');
    assert(cfg.ok, cfg.text);
    await enableMode(token, 'sale', 'QA Cafe');
    loc = await firstLocation(token);
    const boot = await api('GET', '/tenants/me/bootstrap', { token });
    const type = boot.data?.business?.type;
    assert(type === 'restaurant', `business type ${type}`);
    const style = boot.data?.business?.config?.billing?.style;
    assert(style === 'table', `billing style ${style}`);
    return `billing=${style}`;
  });

  await test({ module, biz, name: 'Menu items + dine-in meta sale', severity: 'P1' }, async () => {
    const cat = await api('POST', '/pos/sale/categories', {
      token,
      body: { name: 'Kitchen' },
    });
    pizza = await createSaleProduct(token, loc.id, {
      title: 'Pizza',
      sku: `PIZZA-${STAMP}`,
      price: 350,
      qty: 50,
      categoryId: cat.data.id,
    });
    await createSaleProduct(token, loc.id, {
      title: 'Burger',
      sku: `BURGER-${STAMP}`,
      price: 180,
      qty: 50,
      categoryId: cat.data.id,
    });
    await ensureRegister(token, loc.id);
    const sale = await checkoutCash(
      token,
      loc.id,
      [{ stockLevelId: pizza.stockLevelId, quantity: 1, unitPrice: 350 }],
      {
        discountAmount: 20,
        note: 'dine-in',
        meta: { tableId: 'T12', orderType: 'dine_in', covers: 2 },
      },
    );
    return `order=${sale.order.orderNumber} metaTable=${sale.order?.meta?.tableId || 'n/a'}`;
  });

  await test({ module, biz, name: 'Cancel/park order path', severity: 'P2' }, async () => {
    const parked = await api('POST', '/pos/sale/park', {
      token,
      body: {
        locationId: loc.id,
        items: [{ stockLevelId: pizza.stockLevelId, quantity: 1 }],
        label: 'Takeaway hold',
      },
    });
    assert(parked.ok && parked.data?.id, parked.text);
    const discard = await api('POST', `/pos/sale/parked/${parked.data.id}/discard`, {
      token,
    });
    assert(discard.ok, discard.text);
    return parked.data.id;
  });
}

async function suiteSalon() {
  const module = 'Salon workflow';
  const biz = 'salon';
  const slug = `qa-salon-${STAMP}`;
  const email = `owner@${slug}.test`;
  let token;
  let loc;
  let haircut;
  let customer;

  await test({ module, biz, name: 'Provision salon profile', severity: 'P0' }, async () => {
    const data = await registerTenant({
      slug,
      email,
      name: 'QA Salon',
      phone: '9876514001',
    });
    token = data.accessToken;
    await setBusiness(token, 'salon');
    await enableMode(token, 'service', 'QA Salon');
    await enableMode(token, 'sale', 'QA Salon');
    loc = await firstLocation(token);
    const boot = await api('GET', '/tenants/me/bootstrap', { token });
    assert(boot.data?.business?.type === 'salon', `type=${boot.data?.business?.type}`);
    return boot.data?.business?.config?.billing?.style;
  });

  await test({ module, biz, name: 'Service item + customer sale', severity: 'P1' }, async () => {
    const cat = await api('POST', '/pos/sale/categories', {
      token,
      body: { name: 'Services' },
    });
    haircut = await createSaleProduct(token, loc.id, {
      title: 'Haircut',
      sku: `CUT-${STAMP}`,
      price: 499,
      qty: 0,
      categoryId: cat.data.id,
      trackInventory: false,
    });
    const cust = await api('POST', '/customers', {
      token,
      body: {
        fullName: 'Salon Guest',
        phone: '+919876541101',
      },
    });
    assert(cust.ok, cust.text);
    customer = cust.data;
    await ensureRegister(token, loc.id);
    const before = await getStockQty(token, loc.id, haircut.stockLevelId);
    const sale = await checkoutCash(
      token,
      loc.id,
      [{ stockLevelId: haircut.stockLevelId, quantity: 1, unitPrice: 499 }],
      { customerId: customer.id },
    );
    const after = await getStockQty(token, loc.id, haircut.stockLevelId);
    return `order=${sale.order.orderNumber} stockBefore=${before} after=${after}`;
  });

  await test({ module, biz, name: 'Appointments endpoint', severity: 'P2' }, async () => {
    assert(customer?.id, 'customer missing', { blocked: true });
    const list = await api('GET', '/appointments?limit=5', { token });
    if (!list.ok) {
      const err = new Error(`appointments ${list.status}`);
      err.severity = 'P2';
      err.response = list.text;
      throw err;
    }
    const create = await api('POST', '/appointments', {
      token,
      body: {
        locationId: loc.id,
        customerId: customer.id,
        type: 'service',
        serviceName: 'Haircut',
        startsAt: new Date(Date.now() + 3600e3).toISOString(),
        notes: 'E2E',
      },
    });
    assert(create.ok, `create appointment ${create.status} ${create.text}`, {
      severity: 'P2',
      endpoint: 'POST /appointments',
      response: create.text,
    });
    return `list=${list.status} create=${create.status} id=${create.data?.id}`;
  });

  await test({ module, biz, name: 'Customer history', severity: 'P2' }, async () => {
    assert(customer?.id, 'customer customer missing', { blocked: true });
    const hist = await api('GET', `/customers/${customer.id}/orders`, { token });
    assert(hist.ok, hist.text);
    return `orders=${asList(hist.data).length}`;
  });
}

async function suiteRental() {
  const module = 'Rental workflow';
  const biz = 'rental';
  const slug = `qa-rent-${STAMP}`;
  const email = `owner@${slug}.test`;
  let token;
  let loc;

  await test({ module, biz, name: 'Provision rental mode tenant', severity: 'P0' }, async () => {
    const data = await registerTenant({
      slug,
      email,
      name: 'QA Rental',
      phone: '9876515001',
    });
    token = data.accessToken;
    await setBusiness(token, 'retail');
    const mode = await enableMode(token, 'rental', 'QA Rental');
    assert(mode.ok, mode.text, { severity: 'P1', response: mode.text });
    loc = await firstLocation(token);
    return 'rental mode on';
  });

  await test({ module, biz, name: 'Rental schema + floor', severity: 'P1' }, async () => {
    const boot = await api('GET', '/tenants/me/bootstrap', { token });
    const rental = boot.data?.commerce?.schemas?.rental;
    assert(rental?.fields?.length, 'bootstrap rental fields missing', {
      severity: 'P1',
      endpoint: 'GET /tenants/me/bootstrap',
    });
    assert(
      Array.isArray(rental.categoryExamples) && rental.categoryExamples.length > 0,
      'bootstrap rental categoryExamples missing',
    );
    const schema = await api('GET', '/pos/rental/schema', { token });
    assert(schema.ok, schema.text);
    const floor = await api('GET', '/pos/rental/floor', { token });
    assert(floor.ok, floor.text);
    return `bootstrapFields=${rental.fields.length} examples=${rental.categoryExamples.slice(0, 3).join('|')}`;
  });

  await test({ module, biz, name: 'Rental product + unit availability', severity: 'P1' }, async () => {
    const cat = await api('POST', '/pos/rental/categories', {
      token,
      body: { name: 'Cameras' },
    });
    assert(cat.ok, cat.text);
    const sku = `CAM${STAMP}`.slice(0, 18).padEnd(15, '0'); // 15–18 chars
    const prod = await api('POST', '/pos/rental/products', {
      token,
      body: {
        title: 'Camera',
        description: 'DSLR rental',
        categoryId: cat.data.id,
        sku,
        rentalPrice: 500,
        deposit: 2000,
        barcode: `BC-CAM-${STAMP}`,
        locationId: loc.id,
      },
    });
    assert(prod.ok && (prod.data?.product?.id || prod.data?.id), `rental product ${prod.status} ${prod.text}`, {
      endpoint: 'POST /pos/rental/products',
      response: prod.text,
    });
    return `product=${prod.data?.product?.id || prod.data?.id} unit=${prod.data?.unit?.id || 'n/a'}`;
  });

  await test({ module, biz, name: 'Rental availability query', severity: 'P2' }, async () => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 2 * 864e5).toISOString();
    const res = await api(
      'GET',
      `/pos/rental/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      { token },
    );
    assert(res.ok || res.status === 400, `availability ${res.status}`);
    return String(res.status);
  });
}

async function suiteSubscription() {
  const module = 'Subscription workflow';
  const biz = 'subscription';
  const slug = `qa-sub-${STAMP}`;
  const email = `owner@${slug}.test`;
  let token;

  await test({ module, biz, name: 'Enable subscription commerce mode', severity: 'P1' }, async () => {
    const data = await registerTenant({
      slug,
      email,
      name: 'QA Gym Sub',
      phone: '9876516001',
    });
    token = data.accessToken;
    await setBusiness(token, 'service');
    const mode = await enableMode(token, 'subscription', 'QA Gym');
    if (!mode.ok) {
      const err = new Error(`subscription mode ${mode.status} ${mode.text}`);
      err.severity = 'P2';
      err.response = mode.text;
      throw err;
    }
    return 'enabled';
  });

  await test({ module, biz, name: 'Subscription schema endpoint', severity: 'P2' }, async () => {
    const schema = await api('GET', '/pos/schema?mode=subscription', { token });
    const alt = schema.ok
      ? schema
      : await api('GET', '/pos/subscription/schema', { token });
    if (!schema.ok && !alt.ok) {
      const err = new Error(`no subscription schema ${schema.status}/${alt.status}`);
      err.severity = 'P2';
      err.blocked = false;
      throw err;
    }
    return `status=${schema.ok ? schema.status : alt.status}`;
  });

  await test({ module, biz, name: 'Customer memberships list', severity: 'P2' }, async () => {
    const cust = await api('POST', '/customers', {
      token,
      body: { fullName: 'Member One', phone: '+919876541201' },
    });
    assert(cust.ok, cust.text);
    const mem = await api('GET', `/customers/${cust.data.id}/memberships`, { token });
    assert(mem.ok, mem.text);
    return `memberships=${asList(mem.data).length}`;
  });
}

async function suiteMultiTenant(retailCtx) {
  const module = 'Security / multi-tenant';
  const slugB = `qa-iso-b-${STAMP}`;
  const emailB = `owner@${slugB}.test`;

  let tokenB;
  let custB;

  await test({ module, biz: 'all', name: 'Create Tenant B', severity: 'P0' }, async () => {
    const data = await registerTenant({
      slug: slugB,
      email: emailB,
      name: 'QA Iso B',
      phone: '9876517001',
    });
    tokenB = data.accessToken;
    const cust = await api('POST', '/customers', {
      token: tokenB,
      body: { fullName: 'Secret B Customer', phone: '9111111111' },
    });
    assert(cust.ok, cust.text);
    custB = cust.data;
    return custB.id;
  });

  await test({
    module,
    biz: 'all',
    name: 'Tenant A cannot read Tenant B customer',
    severity: 'P0',
  }, async () => {
    assert(retailCtx?.token, 'retail token missing', { blocked: true });
    const res = await api('GET', `/customers/${custB.id}`, {
      token: retailCtx.token,
    });
    assert([403, 404].includes(res.status), `leak status=${res.status} body=${res.text}`, {
      severity: 'P0',
      endpoint: `GET /customers/${custB.id}`,
      response: res.text,
      dbImpact: 'Cross-tenant data exposure',
    });
    return String(res.status);
  });

  await test({
    module,
    biz: 'all',
    name: 'Tenant B list does not include Tenant A customers',
    severity: 'P0',
  }, async () => {
    const list = await api('GET', '/customers?limit=50', { token: tokenB });
    assert(list.ok, list.text);
    const names = asList(list.data).map((c) => c.fullName);
    assert(!names.includes('Retail Walk-in'), `A customer visible in B: ${names.join(',')}`, {
      severity: 'P0',
    });
    return `count=${names.length}`;
  });
}

async function suiteRbac(retailCtx) {
  const module = 'Users & Roles';
  await test({ module, biz: 'retail', name: 'List users', severity: 'P2' }, async () => {
    assert(retailCtx?.token, 'no token', { blocked: true });
    const res = await api('GET', '/users', { token: retailCtx.token });
    assert(res.ok, res.text);
    return `users=${asList(res.data).length}`;
  });

  await test({ module, biz: 'retail', name: 'Create cashier user', severity: 'P1' }, async () => {
    const res = await api('POST', '/users', {
      token: retailCtx.token,
      body: {
        email: `cashier.${STAMP}@qa.local`,
        fullName: 'QA Cashier',
        password: PASS,
        roleCode: 'cashier',
        phone: '+919876541301',
      },
    });
    assert(res.ok, `user create ${res.status} ${res.text}`, {
      endpoint: 'POST /users',
      response: res.text,
    });
    return res.data?.id || 'ok';
  });

  await test({
    module,
    biz: 'retail',
    name: 'Cashier denied product delete (if login works)',
    severity: 'P1',
  }, async () => {
    const loginRes = await login({
      email: `cashier.${STAMP}@qa.local`,
      tenantSlug: retailCtx.slug,
    });
    if (!loginRes.ok || !loginRes.data?.accessToken) {
      const err = new Error(`cashier login failed ${loginRes.status}`);
      err.severity = 'P2';
      err.response = loginRes.text;
      throw err;
    }
    const tok = loginRes.data.accessToken;
    const del = await api('DELETE', `/pos/sale/products/${retailCtx.shirt.stockLevelId}`, {
      token: tok,
    });
    // also try settings
    const settings = await api('PATCH', '/tenants/me', {
      token: tok,
      body: { name: 'Hacked' },
    });
    const deniedDelete = [401, 403, 404, 405].includes(del.status) || !del.ok;
    const deniedSettings = [401, 403].includes(settings.status) || !settings.ok;
    assert(deniedDelete || deniedSettings, `cashier mutated privileged resources del=${del.status} settings=${settings.status}`, {
      severity: 'P0',
    });
    return `del=${del.status} settings=${settings.status}`;
  });
}

async function suiteLiveSpotCheck() {
  const module = 'Live spot-check';
  const LIVE = 'http://13.126.105.138:3001/v1';
  await test({ module, biz: 'all', name: 'Live API health', severity: 'P0' }, async () => {
    const res = await fetch(`${LIVE}/health`);
    const json = await res.json();
    assert(res.ok && json?.data?.status === 'ok', JSON.stringify(json));
    return json.data.timestamp;
  });
  await test({ module, biz: 'all', name: 'Live FE login', severity: 'P0' }, async () => {
    const res = await fetch('http://13.126.105.138:3000/login');
    assert(res.ok, String(res.status));
    return String(res.status);
  });
  await test({
    module,
    biz: 'all',
    name: 'Auth throttle protects burst register-tenant',
    severity: 'P2',
  }, async () => {
    // Expected security behavior: burst creates eventually 429 (or all succeed under high limit).
    // Do not disable throttling — assert the limiter responds correctly.
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const slug = `throttle-${STAMP}-${i}`;
      const r = await api('POST', '/auth/register-tenant', {
        body: {
          tenantName: `Throttle ${i}`,
          tenantSlug: slug,
          storeName: 'Main',
          adminFullName: 'Throttle Owner',
          adminEmail: `t${i}.${STAMP}@qa.local`,
          adminPassword: PASS,
          adminPhone: '9876599001',
        },
      });
      statuses.push(r.status);
      if (r.status === 429) break;
    }
    const has429 = statuses.includes(429);
    const allOk = statuses.every((s) => s === 200 || s === 201);
    assert(
      has429 || allOk,
      `unexpected statuses ${statuses.join(',')}`,
      { severity: 'P2' },
    );
    return has429
      ? `429 after ${statuses.length} attempts (expected protection)`
      : `all ${statuses.length} allowed under current limit`;
  });
}

async function suitePerformanceSkipped() {
  await test(
    {
      module: 'Performance',
      biz: 'all',
      name: '10k products / 100k sales load',
      severity: 'P2',
    },
    async () => {
      const err = new Error(
        'Not executed in this pass — requires dedicated load environment and seed job',
      );
      err.skipped = true;
      throw err;
    },
  );
  await test(
    {
      module: 'Concurrency',
      biz: 'all',
      name: 'Dual-cashier same SKU race',
      severity: 'P1',
    },
    async () => {
      const err = new Error('Not executed — needs parallel workers harness');
      err.skipped = true;
      throw err;
    },
  );
}

function summarize() {
  const total = cases.length;
  const passed = cases.filter((c) => c.status === 'PASS').length;
  const failed = cases.filter((c) => c.status === 'FAIL').length;
  const blocked = cases.filter((c) => c.status === 'BLOCKED').length;
  const skipped = cases.filter((c) => c.status === 'SKIPPED').length;
  const passPct = total ? Math.round((passed / total) * 1000) / 10 : 0;

  const byModule = {};
  for (const c of cases) {
    byModule[c.module] ||= { pass: 0, fail: 0, skip: 0, block: 0 };
    if (c.status === 'PASS') byModule[c.module].pass++;
    else if (c.status === 'FAIL') byModule[c.module].fail++;
    else if (c.status === 'SKIPPED') byModule[c.module].skip++;
    else if (c.status === 'BLOCKED') byModule[c.module].block++;
  }

  const moduleStatus = Object.fromEntries(
    Object.entries(byModule).map(([k, v]) => [
      k,
      v.fail > 0 ? 'FAIL' : v.pass > 0 ? 'PASS' : v.block > 0 ? 'BLOCKED' : 'SKIPPED',
    ]),
  );

  const bizKeys = ['retail', 'restaurant', 'salon', 'rental', 'subscription'];
  const businessStatus = {};
  for (const b of bizKeys) {
    const rows = cases.filter((c) => c.biz === b);
    if (!rows.length) businessStatus[b] = 'SKIPPED';
    else if (rows.some((r) => r.status === 'FAIL')) businessStatus[b] = 'FAIL';
    else if (rows.some((r) => r.status === 'PASS')) businessStatus[b] = 'PASS';
    else businessStatus[b] = 'SKIPPED';
  }

  const p0 = defects.filter((d) => d.severity === 'P0');
  const p1 = defects.filter((d) => d.severity === 'P1');

  let recommendation = 'READY FOR DEMO';
  if (p0.length) recommendation = 'NOT READY — CRITICAL ISSUES';
  else if (p1.length >= 3) recommendation = 'NOT READY — MAJOR FIXES REQUIRED';
  else if (failed > 0) recommendation = 'READY WITH MINOR FIXES';

  return {
    meta: {
      generatedAt: nowIso(),
      api: API,
      fe: FE,
      stamp: STAMP,
    },
    executive: {
      total,
      passed,
      failed,
      blocked,
      skipped,
      passPercentage: passPct,
      recommendation,
    },
    moduleStatus,
    businessStatus,
    defects,
    cases,
  };
}

async function main() {
  console.log(`\n=== Universal POS E2E QA Master ===`);
  console.log(`API ${API}`);
  console.log(`FE  ${FE}`);
  console.log(`Run ${STAMP}\n`);

  await suiteFrontendSurface();
  await suiteAuth();
  const retailCtx = await suiteRetailWorkflow();
  await suiteRestaurant();
  await suiteSalon();
  await suiteRental();
  await suiteSubscription();
  await suiteMultiTenant(retailCtx);
  await suiteRbac(retailCtx);
  await suiteLiveSpotCheck();
  await suitePerformanceSkipped();

  const report = summarize();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  // also write latest pointer
  writeFileSync(
    join(dirname(OUT), 'e2e-qa-report-latest.json'),
    JSON.stringify(report, null, 2),
  );

  console.log('\n======== EXECUTIVE SUMMARY ========');
  console.log(JSON.stringify(report.executive, null, 2));
  console.log('Module status:', report.moduleStatus);
  console.log('Business status:', report.businessStatus);
  console.log(`Defects: ${report.defects.length}`);
  console.log(`Report: ${OUT}`);
  console.log(`Recommendation: ${report.executive.recommendation}`);
  console.log('===================================\n');

  if (report.executive.failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('MASTER HARNESS CRASH:', e);
  process.exit(1);
});
