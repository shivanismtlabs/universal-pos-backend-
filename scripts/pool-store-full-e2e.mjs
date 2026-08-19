/**
 * Pool / spa retail + service — not a listed POS pack (like The Pool Store mix:
 * chemicals, equipment, supplies, backyard, repairs). Universal Core + Other.
 *
 *   node scripts/pool-store-full-e2e.mjs
 *   API_URL=http://13.126.105.138:3001/v1 node scripts/pool-store-full-e2e.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const STAMP = Date.now().toString(36);
const EMAIL = process.env.POOL_EMAIL ?? `pool.demo.${STAMP}@upos.test`;
const PASSWORD = process.env.POOL_PASSWORD ?? 'PoolStore@2026';
const ORG = process.env.POOL_ORG ?? `Northside Pool & Spa ${STAMP}`;
const APP_LOGIN =
  process.env.FE_URL ??
  (API.includes('13.126.105.138')
    ? 'http://13.126.105.138:3000/login'
    : 'http://localhost:3000/login');
const __dir = dirname(fileURLToPath(import.meta.url));
const IMG_DIR = join(__dir, 'assets', 'pool-store');
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

function imageDataUrl(fileName) {
  const path = join(IMG_DIR, fileName);
  if (!existsSync(path)) return null;
  const b64 = readFileSync(path).toString('base64');
  return `data:image/png;base64,${b64}`;
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
      businessLabel: 'Pool & spa retail + service',
      addressLine1: '3363 Store Road',
      city: 'Valdosta',
      state: 'Georgia',
      postalCode: '31602',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-08-01',
      storeName: 'Showroom',
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
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      currencyCode: 'INR',
      storeName: 'Showroom',
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
  console.log(`POOL STORE E2E (unlisted retail+service) @ ${API}\n`);
  const health = await api('GET', '/health');
  if (!health.ok) {
    console.error('API down', health.text);
    process.exit(1);
  }
  log('API health', 'PASS', API);

  const rec = await api('POST', '/commerce/recommend-setup', {
    body: {
      businessType: 'pool_store',
      sells: ['products', 'services'],
      needs: ['inventory', 'repairs'],
    },
  });
  log(
    'recommend-setup "pool_store" (not a pack)',
    rec.ok ? 'PASS' : 'PARTIAL',
    rec.ok
      ? `maps to ${rec.data?.businessType} modes=[${rec.data?.commerceModes}]`
      : `${rec.status}`,
  );

  const signup = await api('POST', '/auth/signup', {
    body: {
      email: EMAIL,
      password: PASSWORD,
      fullName: 'Dana Pooler',
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
  await api('POST', '/tenants/me/commerce-modes', {
    token,
    body: { modes: ['sale', 'service'] },
  });
  log(
    'Other profile + sale/service modes',
    cfg.ok ? 'PASS' : 'PARTIAL',
    cfg.ok ? 'type=other' : `${cfg.status}`,
  );

  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  if (!loc?.id) {
    log('location', 'FAIL', 'none');
    process.exit(1);
  }
  log('location', 'PASS', loc.name || loc.id);

  const catNames = [
    'Chlorine & shock',
    'Water care',
    'Pool equipment',
    'Pool supplies',
    'Backyard living',
    'Service',
  ];
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
    {
      cat: 'Chlorine & shock',
      title: 'Chlorine shock 5 kg',
      price: 1899,
      qty: 80,
      image: 'pool-chlorine-shock.png',
    },
    {
      cat: 'Water care',
      title: 'Algaecide 1 L',
      price: 649,
      qty: 60,
      image: 'pool-algaecide.png',
    },
    {
      cat: 'Pool equipment',
      title: 'Variable-speed pump',
      price: 24990,
      qty: 8,
      image: 'pool-variable-pump.png',
    },
    {
      cat: 'Pool equipment',
      title: 'Robotic pool cleaner',
      price: 45990,
      qty: 5,
      image: 'pool-robotic-cleaner.png',
    },
    {
      cat: 'Pool supplies',
      title: 'Winter mesh cover 16x32',
      price: 8999,
      qty: 12,
      image: 'pool-winter-cover.png',
    },
    {
      cat: 'Backyard living',
      title: 'Patio grill',
      price: 32990,
      qty: 6,
      image: 'pool-patio-grill.png',
    },
    {
      cat: 'Service',
      title: 'Seasonal pool opening',
      price: 4999,
      qty: 0,
      trackInventory: false,
      itemType: 'service',
    },
    {
      cat: 'Service',
      title: 'Leak check visit',
      price: 2499,
      qty: 0,
      trackInventory: false,
      itemType: 'service',
    },
  ];

  const products = {};
  for (const item of catalogItems) {
    const res = await api('POST', '/pos/sale/products', {
      token,
      body: {
        title: item.title,
        sku: sku('POL', Object.keys(products).length),
        price: item.price,
        qty: item.qty,
        locationId: loc.id,
        categoryId: cats[item.cat]?.id,
        ...(item.trackInventory === false
          ? { trackInventory: false, itemType: 'service' }
          : { sellUnit: item.title.includes('kg') ? 'kg' : item.title.includes('L') ? 'L' : 'pcs' }),
      },
    });
    if (!res.ok) {
      log(`item ${item.title}`, 'FAIL', res.text.slice(0, 140));
      continue;
    }
    const stockLevelId =
      res.data.stockLevelId || res.data.stockLevel?.id || res.data.id;
    products[item.title] = { stockLevelId, price: item.price };
    if (item.image) {
      const imageBase64 = imageDataUrl(item.image);
      if (!imageBase64) {
        log(`image ${item.title}`, 'FAIL', `missing ${item.image}`);
      } else {
        const up = await api('POST', `/pos/sale/products/${stockLevelId}/image`, {
          token,
          body: { imageBase64 },
        });
        const photo =
          up.data?.photoUrl || up.data?.image || up.data?.images?.[0];
        log(
          `item ${item.title}`,
          up.ok && photo ? 'PASS' : up.ok ? 'PARTIAL' : 'FAIL',
          up.ok && photo
            ? `₹${item.price} + photo`
            : `${up.status} ${up.text.slice(0, 80)}`,
        );
      }
    } else {
      log(`item ${item.title}`, 'PASS', `₹${item.price} service`);
    }
  }

  const guest = await api('POST', '/customers', {
    token,
    body: { fullName: 'Chris Homeowner', phone: phone() },
  });
  log(
    'customer',
    guest.ok ? 'PASS' : 'FAIL',
    guest.ok ? guest.data.id : guest.text.slice(0, 80),
  );

  const cur = await api(
    'GET',
    `/pos/sale/register/current?locationId=${loc.id}`,
    { token },
  );
  if (!(cur.data?.session?.id || cur.data?.id)) {
    const opened = await api('POST', '/pos/sale/register/open', {
      token,
      body: { locationId: loc.id, openingFloat: 5000 },
    });
    log(
      'open register',
      opened.ok ? 'PASS' : 'FAIL',
      opened.ok ? '' : opened.text.slice(0, 100),
    );
  } else {
    log('open register', 'PASS', 'already open');
  }

  const shock = products['Chlorine shock 5 kg'];
  const algae = products['Algaecide 1 L'];
  const grill = products['Patio grill'];
  const opening = products['Seasonal pool opening'];
  const retailLines = [shock, algae, grill]
    .filter((p) => p?.stockLevelId)
    .map((p) => ({
      stockLevelId: p.stockLevelId,
      quantity: 1,
      unitPrice: p.price,
    }));
  const retail = await checkoutCash(token, loc.id, retailLines, {
    customerId: guest.data?.id,
    note: 'Walk-in chemicals + grill',
  });
  log(
    'counter sale (chemicals + backyard)',
    retail.ok ? 'PASS' : 'FAIL',
    retail.ok ? retail.data.order.id : retail.text.slice(0, 180),
  );

  if (opening?.stockLevelId) {
    const svc = await checkoutCash(
      token,
      loc.id,
      [
        {
          stockLevelId: opening.stockLevelId,
          quantity: 1,
          unitPrice: opening.price,
        },
      ],
      {
        customerId: guest.data?.id,
        note: 'Seasonal opening visit',
      },
    );
    log(
      'service sale (pool opening)',
      svc.ok ? 'PASS' : 'FAIL',
      svc.ok ? svc.data.order.id : svc.text.slice(0, 180),
    );
  }

  if (retail.ok && retail.data.order?.id) {
    const receipt = await api(
      'GET',
      `/pos/orders/${retail.data.order.id}/receipt`,
      { token },
    );
    log(
      'receipt',
      receipt.ok ? 'PASS' : 'PARTIAL',
      receipt.ok ? 'ok' : String(receipt.status),
    );
  }

  const listedCat = await api(
    'GET',
    `/pos/sale/catalog?locationId=${loc.id}&limit=50`,
    { token },
  );
  const items = asList(listedCat.data?.items ?? listedCat.data);
  const withPhoto = items.filter((i) => i.photoUrl || i.image).length;
  log(
    'counter catalog with images',
    listedCat.ok && withPhoto >= 4 ? 'PASS' : listedCat.ok ? 'PARTIAL' : 'FAIL',
    `items=${items.length} photos=${withPhoto}`,
  );

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  let rok = 0;
  for (const p of [
    `/reports/sales-summary?from=${from}&to=${to}`,
    `/reports/payments-summary?from=${from}&to=${to}`,
  ]) {
    if ((await api('GET', p, { token })).ok) rok += 1;
  }
  log('reports', rok === 2 ? 'PASS' : 'PARTIAL', `${rok}/2`);

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
    csvOk ? 'ok' : `${csv.status}`,
  );

  const passN = RESULTS.filter((r) => r.status === 'PASS').length;
  const partialN = RESULTS.filter((r) => r.status === 'PARTIAL').length;
  const failN = RESULTS.filter((r) => r.status === 'FAIL').length;
  const verdict =
    failN > 0
      ? 'POOL STORE RUNS WITH FAILURES'
      : partialN
        ? 'POOL STORE OPERATIONAL WITH GAPS'
        : 'POOL STORE FULLY OPERATIONAL';

  console.log('\n========== VERDICT ==========');
  console.log(verdict);
  console.log(`Steps PASS=${passN} PARTIAL=${partialN} FAIL=${failN}`);
  console.log('\n========== LOGIN ==========');
  console.log(`Open:     ${APP_LOGIN}`);
  console.log(`Email:    ${EMAIL}`);
  console.log(`Password: ${PASSWORD}`);
  console.log(`Shop:     ${ORG}`);
  console.log(
    'Note:    Pool & spa retail is NOT a listed type. POS ran as Other / Universal Core (sale + service). Photos are original catalog shots, not copied from thepoolstore.net.',
  );

  writeFileSync(
    join(OUT_DIR, `pool-store-${STAMP}.json`),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        api: API,
        verdict,
        login: {
          app: APP_LOGIN,
          email: EMAIL,
          password: PASSWORD,
          organization: ORG,
        },
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
