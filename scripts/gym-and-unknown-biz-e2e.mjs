/**
 * Gym operational test + unknown-business fallback.
 *
 * Questions:
 *  1) Can a gym operate on Universal POS?
 *  2) If a business arrives that we do NOT have as a profile (e.g. swimming,
 *     bakery), will the POS still run?
 *
 * Usage: node scripts/gym-and-unknown-biz-e2e.mjs
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

const RESULTS = [];
const FAILURES = [];

function log(area, name, status, detail = '', endpoint) {
  RESULTS.push({ area, name, status, detail, endpoint });
  console.log(
    `${status.padEnd(8)} [${area}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (status === 'FAIL') {
    FAILURES.push({ area, name, endpoint, detail });
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
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
  const raw = `${prefix}${STAMP}${Math.floor(Math.random() * 999)}`.replace(
    /[^A-Z0-9]/gi,
    '',
  );
  return raw.slice(0, 18).padEnd(15, '0').slice(0, 18);
}

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

async function signupAndOrg(biz, extra = {}) {
  await sleep(700);
  const email = `${biz}.${STAMP}@upos.test`;
  const signup = await api('POST', '/auth/signup', {
    body: { email, password: PASSWORD, fullName: `${biz} Owner` },
  });
  if (!signup.ok || !signup.data?.identityToken) {
    return {
      ok: false,
      step: 'signup',
      status: signup.status,
      text: signup.text,
    };
  }
  const created = await api('POST', '/auth/organizations', {
    token: signup.data.identityToken,
    body: {
      organizationName: `${biz} Shop ${STAMP}`,
      businessType: extra.businessType ?? biz,
      addressLine1: '100 Ops Street',
      state: 'Maharashtra',
      city: 'Mumbai',
      postalCode: '400001',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-08-01',
      customItemFields: extra.customItemFields,
    },
  });
  if (!created.ok || !created.data?.accessToken) {
    return {
      ok: false,
      step: 'org',
      status: created.status,
      text: created.text,
      identityToken: signup.data.identityToken,
    };
  }
  const token = created.data.accessToken;
  const boot = await api('GET', '/tenants/me/bootstrap', { token });
  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  return {
    ok: true,
    email,
    token,
    tenantId: created.data.user?.tenantId,
    loc,
    boot: boot.data,
    modes: boot.data?.commerce?.modes || [],
    caps:
      boot.data?.capabilities?.enabled ||
      boot.data?.business?.capabilities ||
      [],
    type:
      boot.data?.business?.type ||
      boot.data?.tenant?.settings?.businessType ||
      extra.businessType ||
      biz,
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
  if (!opened.ok) throw new Error(`register ${opened.status} ${opened.text}`);
  return opened.data;
}

async function createCategory(token, name) {
  const res = await api('POST', '/catalog/categories', {
    token,
    body: { name },
  });
  if (!res.ok || !res.data?.id) {
    throw new Error(`category ${res.status} ${res.text}`);
  }
  return res.data;
}

async function enableSaleMode(ctx) {
  const modes = [...new Set([...(ctx.modes || []), 'sale'])];
  const res = await api('POST', '/tenants/me/commerce-modes', {
    token: ctx.token,
    body: { modes },
  });
  if (res.ok) ctx.modes = modes;
  return res.ok;
}

async function createProduct(token, locId, opts) {
  const res = await api('POST', '/pos/sale/products', {
    token,
    body: {
      title: opts.title,
      sku: opts.sku || sku('P'),
      price: opts.price ?? 100,
      qty: opts.qty ?? 10,
      locationId: locId,
      categoryId: opts.categoryId,
      trackInventory: opts.trackInventory,
    },
  });
  if (!res.ok) throw new Error(`product ${res.status} ${res.text}`);
  const data = res.data;
  return {
    ...data,
    stockLevelId: data.stockLevelId || data.stockLevel?.id || data.id,
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
  if (!sale.ok || !sale.data?.order?.id) {
    throw new Error(`checkout ${sale.status} ${sale.text}`);
  }
  return sale.data;
}

async function createCustomer(token, name) {
  const res = await api('POST', '/customers', {
    token,
    body: { fullName: name, phone: phone() },
  });
  if (!res.ok || !res.data?.id) {
    throw new Error(`customer ${res.status} ${res.text}`);
  }
  return res.data;
}

async function reportsOk(token) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const paths = [
    `/reports/sales-summary?from=${from}&to=${to}`,
    `/reports/payments-summary?from=${from}&to=${to}`,
  ];
  let ok = 0;
  for (const p of paths) {
    const r = await api('GET', p, { token });
    if (r.ok) ok += 1;
  }
  return ok === paths.length;
}

async function testGym() {
  console.log('\n—— GYM ——');
  const ctx = await signupAndOrg('gym');
  if (!ctx.ok) {
    log('gym', 'create org', 'FAIL', `${ctx.step} ${ctx.status} ${ctx.text}`);
    return;
  }
  log(
    'gym',
    'create org + bootstrap',
    'PASS',
    `type=${ctx.type} modes=[${ctx.modes}] caps=${ctx.caps.length}`,
  );

  const hasSub = ctx.modes.includes('subscription');
  const hasMembership = ctx.caps.includes('MEMBERSHIP');
  const hasCheckIn = ctx.caps.includes('CHECK_IN');
  log(
    'gym',
    'modes/caps template',
    hasSub && hasMembership ? 'PASS' : 'PARTIAL',
    `subscription=${hasSub} MEMBERSHIP=${hasMembership} CHECK_IN=${hasCheckIn}`,
  );

  const cust = await createCustomer(ctx.token, 'Gym Member');
  log('gym', 'create member', 'PASS', cust.id);

  const cat = await createCategory(ctx.token, 'Memberships');
  const plan = await api('POST', '/subscriptions/plans', {
    token: ctx.token,
    body: {
      title: 'Monthly Gym',
      categoryId: cat.id,
      sku: sku('PLAN'),
      price: 1999,
      billingPeriodDays: 30,
    },
  });
  if (!plan.ok) {
    log(
      'gym',
      'membership plan',
      'FAIL',
      `${plan.status} ${plan.text}`,
      'POST /subscriptions/plans',
    );
    return;
  }
  log('gym', 'membership plan', 'PASS', plan.data?.id || plan.data?.productId);

  const enroll = await api('POST', '/subscriptions/enroll', {
    token: ctx.token,
    body: {
      customerId: cust.id,
      planId: plan.data?.id || plan.data?.productId,
      productId: plan.data?.productId || plan.data?.id,
      paymentMethod: 'cash',
    },
  });
  let subId = enroll.data?.id;
  let enrollOk = enroll.ok;
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
  }
  log(
    'gym',
    'enroll + pay membership',
    enrollOk ? 'PASS' : 'FAIL',
    enrollOk ? subId : enroll.text,
    'POST /subscriptions/enroll',
  );

  const checkin = await api('POST', '/subscriptions/check-in', {
    token: ctx.token,
    body: { customerId: cust.id, subscriptionId: subId },
  });
  const freeze = subId
    ? await api('POST', `/subscriptions/${subId}/freeze`, {
        token: ctx.token,
        body: {},
      })
    : { ok: false, status: 0 };
  log(
    'gym',
    'member check-in / freeze',
    checkin.ok || freeze.ok ? 'PASS' : 'PARTIAL',
    `check-in=${checkin.status}; freeze=${freeze.status} (capability advertised, dedicated APIs missing)`,
    'POST /subscriptions/check-in',
  );

  const saleOn = await enableSaleMode(ctx);
  log(
    'gym',
    'enable extra sale mode (PT / retail add-on)',
    saleOn ? 'PASS' : 'PARTIAL',
    `modes=[${ctx.modes}]`,
  );

  await ensureRegister(ctx.token, ctx.loc.id);
  const pt = await createProduct(ctx.token, ctx.loc.id, {
    title: 'PT Session',
    price: 800,
    qty: 20,
    categoryId: cat.id,
    trackInventory: false,
  });
  const sale = await checkoutCash(
    ctx.token,
    ctx.loc.id,
    [{ stockLevelId: pt.stockLevelId, quantity: 1, unitPrice: 800 }],
    { customerId: cust.id },
  );
  log('gym', 'walk-in PT sale at counter', 'PASS', sale.order.id);

  const hist = await api('GET', `/customers/${cust.id}/orders`, {
    token: ctx.token,
  });
  const historyN = asList(hist.data).length || asList(hist.data?.orders).length;
  log(
    'gym',
    'customer history',
    hist.ok ? 'PASS' : 'PARTIAL',
    `orders=${historyN || (hist.ok ? 'ok' : hist.status)}`,
  );

  const rpt = await reportsOk(ctx.token);
  log('gym', 'reports', rpt ? 'PASS' : 'PARTIAL');
}

async function testUnknownBusinesses() {
  console.log('\n—— UNKNOWN BUSINESSES (no dedicated pack) ——');

  for (const unknown of ['swimming', 'bakery', 'welding_shop']) {
    const rec = await api('POST', '/commerce/recommend-setup', {
      body: { businessType: unknown },
    });
    const mapped = rec.data?.businessType;
    log(
      'unknown',
      `recommend-setup "${unknown}"`,
      rec.ok ? 'PASS' : 'FAIL',
      rec.ok
        ? `maps to type=${mapped} modes=[${rec.data?.commerceModes}] screens=${(rec.data?.screens || []).length}`
        : `${rec.status} ${rec.text}`,
      'POST /commerce/recommend-setup',
    );
  }

  const swimmingRec = await api('POST', '/commerce/recommend-setup', {
    body: {
      businessType: 'swimming',
      sells: ['subscriptions', 'services'],
      needs: ['memberships', 'check_in', 'appointments'],
    },
  });
  log(
    'unknown',
    'swimming with sells/needs (no gym pack)',
    swimmingRec.ok ? 'PASS' : 'FAIL',
    swimmingRec.ok
      ? `type=${swimmingRec.data?.businessType} modes=[${swimmingRec.data?.commerceModes}] caps=[${swimmingRec.data?.capabilities}]`
      : swimmingRec.text,
    'POST /commerce/recommend-setup',
  );

  const reject = await signupAndOrg('swimming');
  log(
    'unknown',
    'create org as type=swimming',
    !reject.ok && reject.status === 400 ? 'PASS' : reject.ok ? 'FAIL' : 'PARTIAL',
    reject.ok
      ? 'UNEXPECTED: unknown type was accepted'
      : `correctly rejected ${reject.status}: ${(reject.text || '').slice(0, 180)}`,
    'POST /auth/organizations',
  );

  const other = await signupAndOrg('other', {
    businessType: 'other',
    customItemFields: [
      { label: 'Lane type' },
      { label: 'Session mins' },
    ],
  });
  if (!other.ok) {
    log('unknown', 'create Other (swimming shop)', 'FAIL', other.text);
    return;
  }
  log(
    'unknown',
    'create Other as swimming pool shop',
    'PASS',
    `stored type=${other.type} modes=[${other.modes}] — POS runs via Other/General, not a swimming pack`,
  );

  const cust = await createCustomer(other.token, 'Swim Guest');
  await ensureRegister(other.token, other.loc.id);
  const cat = await createCategory(other.token, 'Pool');
  const product = await createProduct(other.token, other.loc.id, {
    title: 'Day pass',
    price: 250,
    qty: 50,
    categoryId: cat.id,
  });
  const sale = await checkoutCash(
    other.token,
    other.loc.id,
    [{ stockLevelId: product.stockLevelId, quantity: 1, unitPrice: 250 }],
    { customerId: cust.id },
  );
  log('unknown', 'counter sale (Other/swimming)', 'PASS', sale.order.id);

  const orders = await api('GET', `/customers/${cust.id}/orders`, {
    token: other.token,
  });
  log(
    'unknown',
    'list orders (customer history)',
    orders.ok ? 'PASS' : 'FAIL',
    orders.ok ? `status=${orders.status}` : orders.text,
  );

  const rpt = await reportsOk(other.token);
  log('unknown', 'reports on Other shop', rpt ? 'PASS' : 'PARTIAL');

  const bakery = await signupAndOrg('general', { businessType: 'general' });
  if (!bakery.ok) {
    log('unknown', 'create General (bakery)', 'FAIL', bakery.text);
    return;
  }
  log(
    'unknown',
    'create General as bakery',
    'PASS',
    `type=${bakery.type} modes=[${bakery.modes}]`,
  );
  await ensureRegister(bakery.token, bakery.loc.id);
  const bcat = await createCategory(bakery.token, 'Baked');
  const loaf = await createProduct(bakery.token, bakery.loc.id, {
    title: 'Sourdough loaf',
    price: 120,
    qty: 30,
    categoryId: bcat.id,
  });
  const bsale = await checkoutCash(bakery.token, bakery.loc.id, [
    { stockLevelId: loaf.stockLevelId, quantity: 2, unitPrice: 120 },
  ]);
  log('unknown', 'counter sale (General/bakery)', 'PASS', bsale.order.id);
}

async function main() {
  console.log(`GYM + UNKNOWN BUSINESS E2E @ ${API}\n`);
  const health = await api('GET', '/health');
  if (!health.ok) {
    console.error('API down', health.text);
    process.exit(1);
  }
  log('system', 'API health', 'PASS', API);

  try {
    await testGym();
  } catch (e) {
    log('gym', 'crashed', 'FAIL', e.message);
  }
  try {
    await testUnknownBusinesses();
  } catch (e) {
    log('unknown', 'crashed', 'FAIL', e.message);
  }

  const pass = RESULTS.filter((r) => r.status === 'PASS').length;
  const partial = RESULTS.filter((r) => r.status === 'PARTIAL').length;
  const fail = RESULTS.filter((r) => r.status === 'FAIL').length;
  const gymSteps = RESULTS.filter((r) => r.area === 'gym');
  const gymFail = gymSteps.filter((r) => r.status === 'FAIL').length;
  const gymPartial = gymSteps.filter((r) => r.status === 'PARTIAL').length;

  let gymVerdict = 'GYM OPERATIONAL';
  if (gymFail) gymVerdict = 'GYM FAIL';
  else if (gymPartial) gymVerdict = 'GYM OPERATIONAL WITH GAPS';

  const unknownFail = RESULTS.filter(
    (r) => r.area === 'unknown' && r.status === 'FAIL',
  ).length;
  const unknownVerdict = unknownFail
    ? 'UNKNOWN BUSINESS: BLOCKED / FAIL'
    : 'UNKNOWN BUSINESS: POS RUNS VIA OTHER/GENERAL';

  console.log('\n========== VERDICT ==========');
  console.log(gymVerdict);
  console.log(unknownVerdict);
  console.log(`Steps PASS=${pass} PARTIAL=${partial} FAIL=${fail}`);
  if (FAILURES.length) {
    console.log('\n=== FAILURES ===');
    for (const f of FAILURES) {
      console.log(`- [${f.area}] ${f.name}`);
      console.log(`  ${f.endpoint || ''} ${f.detail}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    api: API,
    gymVerdict,
    unknownVerdict,
    summary: { pass, partial, fail },
    results: RESULTS,
    failures: FAILURES,
  };
  const out = join(OUT_DIR, `gym-unknown-${STAMP}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeFileSync(
    join(OUT_DIR, 'gym-unknown-latest.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(`\nReport: ${out}`);
  if (fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
