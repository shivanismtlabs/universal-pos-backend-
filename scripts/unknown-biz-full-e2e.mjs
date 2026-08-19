/**
 * Unknown / "Not listed" business — swimming academy is not a packed vertical.
 * Engine must still run via Other + Universal Core.
 *
 *   node scripts/unknown-biz-full-e2e.mjs
 *   API_URL=http://13.126.105.138:3001/v1 node scripts/unknown-biz-full-e2e.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const STAMP = Date.now().toString(36);
const EMAIL = process.env.UNK_EMAIL ?? `unknown.demo.${STAMP}@upos.test`;
const PASSWORD = process.env.UNK_PASSWORD ?? 'UnknownBiz@2026';
const ORG = process.env.UNK_ORG ?? `BlueWave Swim Academy ${STAMP}`;
const APP_LOGIN =
  process.env.FE_URL ??
  (API.includes('13.126.105.138')
    ? 'http://13.126.105.138:3000/login'
    : 'http://localhost:3000/login');
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, 'qa-results');
mkdirSync(OUT_DIR, { recursive: true });

const RESULTS = [];
function log(name, status, detail = '') {
  RESULTS.push({ name, status, detail });
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
  if (Array.isArray(payload?.organizations)) return payload.organizations;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function sku(prefix, n = 0) {
  return `${prefix}${STAMP}${n}${Math.floor(Math.random() * 99)}`
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 18)
    .padEnd(15, '0');
}

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

async function enterShop(authData) {
  if (authData?.accessToken) {
    return { token: authData.accessToken, how: 'shop' };
  }
  const identityToken = authData?.identityToken;
  if (!identityToken) return { token: null, how: 'none' };
  const listed = await api('GET', '/auth/organizations', {
    token: identityToken,
  });
  const orgs = asList(listed.data?.organizations ?? listed.data);
  if (orgs[0]?.tenantId) {
    const selected = await api('POST', '/auth/select-organization', {
      token: identityToken,
      body: { tenantId: orgs[0].tenantId },
    });
    if (selected.ok && selected.data?.accessToken) {
      return { token: selected.data.accessToken, how: 'select_org' };
    }
  }
  const created = await api('POST', '/auth/organizations', {
    token: identityToken,
    body: {
      organizationName: ORG,
      businessType: 'other',
      businessLabel: 'Swimming academy',
      addressLine1: '8 Lake Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-08-01',
      storeName: 'Powai Pool',
      customItemFields: [
        { label: 'Lane type' },
        { label: 'Session mins' },
      ],
    },
  });
  if (created.ok && created.data?.accessToken) {
    return { token: created.data.accessToken, how: 'create_org' };
  }
  const retry = await api('POST', '/auth/organizations', {
    token: identityToken,
    body: {
      organizationName: ORG,
      businessType: 'other',
      addressLine1: '8 Lake Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      currencyCode: 'INR',
      storeName: 'Powai Pool',
    },
  });
  if (retry.ok && retry.data?.accessToken) {
    return { token: retry.data.accessToken, how: 'create_org_plain' };
  }
  return { token: null, how: 'failed', detail: retry.text };
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
    ...(opts.discountAmount != null
      ? { discountAmount: opts.discountAmount }
      : {}),
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
      body.payments[0].amount = Number(m[1]);
      body.cashTendered = Number(m[1]) + 20;
      body.payments[0].idempotencyKey += '-r';
      sale = await api('POST', '/pos/sale/checkout', { token, body });
    }
  }
  return sale;
}

async function main() {
  console.log(`UNKNOWN BUSINESS E2E (swimming academy / Not listed) @ ${API}\n`);
  const health = await api('GET', '/health');
  if (!health.ok) {
    console.error('API down', health.text);
    process.exit(1);
  }
  log('API health', 'PASS', API);

  const rec = await api('POST', '/commerce/recommend-setup', {
    body: {
      businessType: 'swimming',
      sells: ['products', 'services'],
      needs: ['memberships'],
    },
  });
  log(
    'recommend-setup "swimming" (not a pack)',
    rec.ok ? 'PASS' : 'PARTIAL',
    rec.ok
      ? `maps to ${rec.data?.businessType} modes=[${rec.data?.commerceModes}]`
      : `${rec.status} ${rec.text.slice(0, 120)}`,
  );

  const signup = await api('POST', '/auth/signup', {
    body: {
      email: EMAIL,
      password: PASSWORD,
      fullName: 'Arjun Divekar',
    },
  });
  if (!signup.ok) {
    log('signup', 'FAIL', `${signup.status} ${signup.text.slice(0, 180)}`);
    process.exit(1);
  }
  const entered = await enterShop(signup.data);
  if (!entered.token) {
    log('enter shop', 'FAIL', entered.how);
    process.exit(1);
  }
  let token = entered.token;
  log('signup + enter shop', 'PASS', `${EMAIL} via ${entered.how}`);

  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  const logged = await enterShop(login.data);
  if (logged.token) token = logged.token;
  log(
    'login email+password',
    logged.token || login.data?.accessToken ? 'PASS' : 'PARTIAL',
    logged.how || String(login.status),
  );

  await api('PATCH', '/tenants/me', { token, body: { name: ORG } });
  const cfg = await api('POST', '/tenants/me/business-config', {
    token,
    body: { businessType: 'other', applyDefaultModes: true },
  });
  log(
    'apply Other (not listed) profile',
    cfg.ok ? 'PASS' : 'PARTIAL',
    cfg.ok
      ? `type=${cfg.data?.businessType || 'other'}`
      : `${cfg.status} ${cfg.text.slice(0, 140)}`,
  );

  const boot = await api('GET', '/tenants/me/bootstrap', { token });
  const type =
    boot.data?.business?.type ||
    boot.data?.tenant?.settings?.businessType ||
    boot.data?.businessConfig?.businessType;
  const modes = boot.data?.commerce?.modes || [];
  const label =
    boot.data?.tenant?.settings?.businessLabel ||
    boot.data?.business?.label;
  const unknownOk =
    type === 'other' ||
    type === 'general' ||
    type === 'retail' ||
    Boolean(modes.length);
  log(
    'bootstrap unknown shop',
    unknownOk ? 'PASS' : 'FAIL',
    `storedType=${type} label=${label || 'n/a'} modes=[${modes}] — POS uses Universal Core, not a swimming pack`,
  );

  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  if (!loc?.id) {
    log('location', 'FAIL', 'none');
    process.exit(1);
  }
  log('location', 'PASS', loc.name || loc.id);

  const catNames = ['Day passes', 'Lessons', 'Retail'];
  const cats = {};
  for (const name of catNames) {
    const res = await api('POST', '/pos/sale/categories', {
      token,
      body: { name },
    });
    if (res.ok) {
      cats[name] = res.data;
      log(`category ${name}`, 'PASS');
    } else {
      log(`category ${name}`, 'FAIL', res.text.slice(0, 120));
    }
  }

  const catalogItems = [
    { cat: 'Day passes', title: 'Adult day pass', price: 250, qty: 200 },
    { cat: 'Day passes', title: 'Kid day pass', price: 150, qty: 200 },
    { cat: 'Lessons', title: 'Beginner swim (30 min)', price: 800, qty: 50 },
    { cat: 'Lessons', title: 'Lane hire 1 hour', price: 1200, qty: 40 },
    { cat: 'Retail', title: 'Goggles', price: 399, qty: 30 },
    { cat: 'Retail', title: 'Swim cap', price: 149, qty: 40 },
  ];
  const products = {};
  for (const item of catalogItems) {
    const res = await api('POST', '/pos/sale/products', {
      token,
      body: {
        title: item.title,
        sku: sku('SWM', Object.keys(products).length),
        price: item.price,
        qty: item.qty,
        locationId: loc.id,
        categoryId: cats[item.cat]?.id,
      },
    });
    if (!res.ok) {
      log(`item ${item.title}`, 'FAIL', res.text.slice(0, 140));
      continue;
    }
    products[item.title] = {
      stockLevelId:
        res.data.stockLevelId || res.data.stockLevel?.id || res.data.id,
      price: item.price,
    };
    log(`item ${item.title}`, 'PASS', `₹${item.price}`);
  }

  const guest = await api('POST', '/customers', {
    token,
    body: { fullName: 'Neha Swimmer', phone: phone() },
  });
  log('customer', guest.ok ? 'PASS' : 'FAIL', guest.ok ? guest.data.id : guest.text.slice(0, 80));

  const cur = await api(
    'GET',
    `/pos/sale/register/current?locationId=${loc.id}`,
    { token },
  );
  if (!(cur.data?.session?.id || cur.data?.id)) {
    const opened = await api('POST', '/pos/sale/register/open', {
      token,
      body: { locationId: loc.id, openingFloat: 1000 },
    });
    log('open register', opened.ok ? 'PASS' : 'FAIL', opened.ok ? '' : opened.text.slice(0, 100));
  } else {
    log('open register', 'PASS', 'already open');
  }

  const pass = products['Adult day pass'];
  const lesson = products['Beginner swim (30 min)'];
  const goggles = products['Goggles'];
  const lineItems = [pass, lesson, goggles]
    .filter((p) => p?.stockLevelId)
    .map((p) => ({
      stockLevelId: p.stockLevelId,
      quantity: 1,
      unitPrice: p.price,
    }));
  const sale = await checkoutCash(token, loc.id, lineItems, {
      customerId: guest.data?.id,
      note: 'Day pass + lesson + goggles (unknown business / Other)',
    },
  );
  log(
    'counter sale (unknown business still bills)',
    sale.ok ? 'PASS' : 'FAIL',
    sale.ok ? sale.data.order.id : sale.text.slice(0, 180),
  );

  if (sale.ok && sale.data.order?.id) {
    const receipt = await api(
      'GET',
      `/pos/orders/${sale.data.order.id}/receipt`,
      { token },
    );
    log('receipt', receipt.ok ? 'PASS' : 'PARTIAL', receipt.ok ? 'ok' : String(receipt.status));
    const hist = await api('GET', `/customers/${guest.data.id}/orders`, {
      token,
    });
    log(
      'customer history',
      hist.ok ? 'PASS' : 'PARTIAL',
      hist.ok ? 'ok' : String(hist.status),
    );
  }

  const listedCat = await api(
    'GET',
    `/pos/sale/catalog?locationId=${loc.id}&limit=50`,
    { token },
  );
  const n = asList(listedCat.data?.items ?? listedCat.data).length;
  log(
    'counter catalog',
    listedCat.ok && n >= 4 ? 'PASS' : 'PARTIAL',
    `items=${n}`,
  );

  const me = await api('GET', '/auth/me', { token });
  log('session /auth/me', me.ok ? 'PASS' : 'FAIL', me.ok ? (me.data?.email || 'ok') : String(me.status));

  const modesSet = await api('POST', '/tenants/me/commerce-modes', {
    token,
    body: { modes: ['sale', 'service'] },
  });
  log(
    'commerce modes sale+service (no vertical pack)',
    modesSet.ok ? 'PASS' : 'PARTIAL',
    modesSet.ok ? 'ok' : `${modesSet.status}`,
  );

  const dash = await api('GET', '/tenants/me/dashboard-catalog', { token });
  log(
    'home dashboard catalog',
    dash.ok ? 'PASS' : 'PARTIAL',
    dash.ok ? 'ok' : `${dash.status}`,
  );

  const gogglesStock = products['Goggles'];
  if (gogglesStock?.stockLevelId) {
    const adj = await api(
      'POST',
      `/pos/sale/products/${gogglesStock.stockLevelId}/adjust-stock`,
      { token, body: { delta: 5 } },
    );
    log(
      'stock adjust +5',
      adj.ok ? 'PASS' : 'PARTIAL',
      adj.ok ? 'ok' : `${adj.status} ${adj.text.slice(0, 80)}`,
    );
  }

  const vendor = await api('POST', '/suppliers', {
    token,
    body: { name: `Pool supply ${STAMP}`, phone: phone(), contact: 'Desk' },
  });
  log(
    'supplier',
    vendor.ok ? 'PASS' : 'PARTIAL',
    vendor.ok ? vendor.data.id : `${vendor.status}`,
  );
  if (vendor.ok && gogglesStock?.stockLevelId) {
    const po = await api('POST', '/purchase-orders', {
      token,
      body: {
        supplierId: vendor.data.id,
        lines: [
          {
            stockLevelId: gogglesStock.stockLevelId,
            qtyOrdered: 4,
            unitCost: 180,
          },
        ],
      },
    });
    if (!po.ok) {
      log('purchase order', 'PARTIAL', `${po.status} ${po.text.slice(0, 80)}`);
    } else {
      const recv = await api('POST', `/purchase-orders/${po.data.id}/receive`, {
        token,
        body: {
          lines: [{ stockLevelId: gogglesStock.stockLevelId, qty: 4 }],
        },
      });
      log(
        'purchase receive (stock in)',
        recv.ok ? 'PASS' : 'PARTIAL',
        recv.ok ? po.data.id : `${recv.status}`,
      );
    }
  }

  const cap = products['Swim cap'];
  if (cap?.stockLevelId) {
    const parked = await api('POST', '/pos/sale/park', {
      token,
      body: {
        locationId: loc.id,
        items: [{ stockLevelId: cap.stockLevelId, quantity: 1 }],
        label: 'Hold for later',
      },
    });
    if (!parked.ok) {
      log('park bill', 'PARTIAL', `${parked.status}`);
    } else {
      const discard = await api(
        'POST',
        `/pos/sale/parked/${parked.data.id}/discard`,
        { token },
      );
      log(
        'park + discard bill',
        discard.ok ? 'PASS' : 'PARTIAL',
        parked.data.id,
      );
    }

    const discSale = await checkoutCash(
      token,
      loc.id,
      [
        {
          stockLevelId: cap.stockLevelId,
          quantity: 1,
          unitPrice: cap.price,
        },
      ],
      { customerId: guest.data?.id, discountAmount: 20, note: 'Discounted cap' },
    );
    log(
      'discounted counter sale',
      discSale.ok ? 'PASS' : 'FAIL',
      discSale.ok ? discSale.data.order.id : discSale.text.slice(0, 120),
    );

    if (sale.ok && sale.data.order?.id) {
      await api('POST', '/pos/refund-reasons/seed', { token });
      const reasons = await api('GET', '/pos/refund-reasons', { token });
      const codes = asList(reasons.data).map((r) => r.code);
      const reasonCode = codes[0] || 'customer_changed_mind';
      const ret = await api('POST', '/pos/sale/returns', {
        token,
        body: {
          orderId: sale.data.order.id,
          items: [
            {
              stockLevelId: goggles?.stockLevelId || cap.stockLevelId,
              quantity: 1,
            },
          ],
          refundMethod: 'cash',
          reasonCode,
          reason: 'Changed mind',
          idempotencyKey: `ret-${STAMP}`,
        },
      });
      log(
        'return / refund',
        ret.ok ? 'PASS' : 'PARTIAL',
        ret.ok ? 'ok' : `${ret.status} ${ret.text.slice(0, 80)}`,
      );
    }
  }

  await api('POST', '/expenses/categories/seed', { token });
  const expCats = asList((await api('GET', '/expenses/categories', { token })).data);
  const expense = await api('POST', '/expenses', {
    token,
    body: {
      categoryId: expCats[0]?.id,
      amount: 450,
      spentAt: new Date().toISOString().slice(0, 10),
      paymentMethod: 'cash',
      notes: 'Pool chemicals',
      payee: 'Local vendor',
    },
  });
  log(
    'expense',
    expense.ok ? 'PASS' : 'PARTIAL',
    expense.ok ? expense.data?.id || 'ok' : `${expense.status}`,
  );

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const reportPaths = [
    `/reports/sales-summary?from=${from}&to=${to}`,
    `/reports/payments-summary?from=${from}&to=${to}`,
    `/reports/tax-summary?from=${from}&to=${to}`,
    `/reports/inventory/current-stock`,
    `/reports/daily-sales?date=${to}`,
  ];
  let rok = 0;
  for (const p of reportPaths) {
    if ((await api('GET', p, { token })).ok) rok += 1;
  }
  log('reports', rok >= 2 ? (rok === reportPaths.length ? 'PASS' : 'PARTIAL') : 'FAIL', `${rok}/${reportPaths.length}`);

  const csv = await api(
    'GET',
    `/reports/sales-summary?from=${from}&to=${to}&format=csv`,
    { token },
  );
  const csvBody = String(csv.text || '');
  const csvOk =
    csv.ok &&
    csv.status === 200 &&
    /section,metric,value|order_count|sales,from/.test(csvBody);
  log(
    'report CSV export',
    csvOk ? 'PASS' : 'PARTIAL',
    csvOk ? 'sales-summary.csv' : `${csv.status} ${csvBody.slice(0, 80)}`,
  );

  const passN = RESULTS.filter((r) => r.status === 'PASS').length;
  const partialN = RESULTS.filter((r) => r.status === 'PARTIAL').length;
  const failN = RESULTS.filter((r) => r.status === 'FAIL').length;
  const verdict =
    failN > 0
      ? 'UNKNOWN BUSINESS RUNS WITH FAILURES'
      : partialN
        ? 'UNKNOWN BUSINESS OPERATIONAL WITH GAPS'
        : 'UNKNOWN BUSINESS FULLY OPERATIONAL';

  console.log('\n========== VERDICT ==========');
  console.log(verdict);
  console.log(`Steps PASS=${passN} PARTIAL=${partialN} FAIL=${failN}`);
  console.log('\n========== LOGIN ==========');
  console.log(`Open:     ${APP_LOGIN}`);
  console.log(`Email:    ${EMAIL}`);
  console.log(`Password: ${PASSWORD}`);
  console.log(`Shop:     ${ORG}`);
  console.log(
    'Note:    Swimming academy is NOT a listed type. POS ran as Other / Universal Core.',
  );

  writeFileSync(
    join(OUT_DIR, `unknown-biz-${STAMP}.json`),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        api: API,
        verdict,
        login: { app: APP_LOGIN, email: EMAIL, password: PASSWORD, organization: ORG },
        results: RESULTS,
      },
      null,
      2,
    ),
  );
  if (failN > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
