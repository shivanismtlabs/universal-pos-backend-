/**
 * Full salon: signup → org → services/chairs/clients → appointment → bill.
 *
 *   node scripts/salon-full-e2e.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const STAMP = Date.now().toString(36);
const EMAIL = process.env.SALON_EMAIL ?? `salon.demo.${STAMP}@upos.test`;
const PASSWORD = process.env.SALON_PASSWORD ?? 'SalonDemo@2026';
const ORG = process.env.SALON_ORG ?? `Glow Studio Salon ${STAMP}`;
const APP_LOGIN =
  process.env.FE_URL ??
  (API.includes('13.126.105.138')
    ? 'http://13.126.105.138:3000/login'
    : 'http://localhost:3000/login');
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

let skuSeq = 0;
function sku(prefix) {
  skuSeq += 1;
  return `${prefix}${STAMP}${skuSeq}${Math.floor(Math.random() * 99)}`
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 18);
}

function phone() {
  return `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
}

async function enterShop(authData) {
  if (authData?.accessToken && process.env.SALON_REUSE === '1') {
    return { token: authData.accessToken, how: 'shop' };
  }
  const identityToken = authData?.identityToken;
  if (!identityToken) {
    if (authData?.accessToken) {
      return { token: authData.accessToken, how: 'shop' };
    }
    return { token: null, how: 'none' };
  }
  const created = await api('POST', '/auth/organizations', {
    token: identityToken,
    body: {
      organizationName: ORG,
      businessType: 'salon',
      addressLine1: '44 Linking Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400050',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-08-01',
      storeName: 'Bandra Studio',
    },
  });
  if (created.ok && created.data?.accessToken) {
    return { token: created.data.accessToken, how: 'create_org' };
  }
  const listed = await api('GET', '/auth/organizations', {
    token: identityToken,
  });
  const orgs = asList(listed.data?.organizations ?? listed.data);
  const salon = orgs.find((o) =>
    String(o.name || o.slug || '').toLowerCase().includes('salon'),
  );
  const pick = salon || orgs[0];
  if (pick?.tenantId) {
    const selected = await api('POST', '/auth/select-organization', {
      token: identityToken,
      body: { tenantId: pick.tenantId },
    });
    if (selected.ok && selected.data?.accessToken) {
      return { token: selected.data.accessToken, how: 'select_org' };
    }
  }
  return { token: null, how: 'failed', detail: created.text };
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
  console.log(`SALON FULL E2E @ ${API}\n`);
  const health = await api('GET', '/health');
  if (!health.ok) {
    console.error('API down', health.text);
    process.exit(1);
  }
  log('API health', 'PASS', API);

  let token = null;
  if (process.env.SALON_EMAIL) {
    const loginExisting = await api('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
    });
    const entered = await enterShop(loginExisting.data);
    if (!entered.token) {
      log(
        'login existing',
        'FAIL',
        `${entered.how} ${loginExisting.text.slice(0, 180)}`,
      );
      process.exit(1);
    }
    token = entered.token;
    log('login existing salon user', 'PASS', `${EMAIL} via ${entered.how}`);
  } else {
    const signup = await api('POST', '/auth/signup', {
      body: { email: EMAIL, password: PASSWORD, fullName: 'Meera Kapoor' },
    });
    if (!signup.ok) {
      log('signup', 'FAIL', `${signup.status} ${signup.text.slice(0, 220)}`);
      process.exit(1);
    }
    if (signup.data?.accessToken) {
      token = signup.data.accessToken;
      log('signup (prod auto-shop)', 'PASS', EMAIL);
    } else if (signup.data?.identityToken) {
      log('signup', 'PASS', EMAIL);
      const created = await api('POST', '/auth/organizations', {
        token: signup.data.identityToken,
        body: {
          organizationName: ORG,
          businessType: 'salon',
          addressLine1: '44 Linking Road',
          city: 'Mumbai',
          state: 'Maharashtra',
          postalCode: '400050',
          currencyCode: 'INR',
          fiscalYearStart: 'April',
          inventoryStartDate: '2026-08-01',
          storeName: 'Bandra Studio',
        },
      });
      if (!created.ok || !created.data?.accessToken) {
        log(
          'create salon org',
          'FAIL',
          `${created.status} ${created.text.slice(0, 220)}`,
        );
        process.exit(1);
      }
      token = created.data.accessToken;
      log('create salon org', 'PASS', ORG);
    } else {
      log(
        'signup',
        'FAIL',
        `no token keys=${Object.keys(signup.data || {}).join(',')}`,
      );
      process.exit(1);
    }
  }

  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  if (login.ok && login.data?.accessToken && !token) {
    token = login.data.accessToken;
  }
  log(
    'login with email+password',
    login.ok ? 'PASS' : 'FAIL',
    login.ok ? 'session ok' : `${login.status} ${login.text.slice(0, 180)}`,
  );

  const named = await api('PATCH', '/tenants/me', {
    token,
    body: { name: ORG },
  });
  log(
    'rename shop',
    named.ok ? 'PASS' : 'PARTIAL',
    named.ok ? ORG : `${named.status}`,
  );

  const cfg = await api('POST', '/tenants/me/business-config', {
    token,
    body: {
      businessType: 'salon',
      applyDefaultModes: true,
    },
  });
  log(
    'apply salon business-config',
    cfg.ok ? 'PASS' : 'PARTIAL',
    cfg.ok
      ? `type=${cfg.data?.businessType || 'salon'}`
      : `${cfg.status} ${cfg.text.slice(0, 160)}`,
  );

  const boot = await api('GET', '/tenants/me/bootstrap', { token });
  let modes = boot.data?.commerce?.modes || [];
  const caps =
    boot.data?.capabilities?.enabled || boot.data?.business?.capabilities || [];
  const type =
    boot.data?.business?.type || boot.data?.tenant?.settings?.businessType;
  if (!modes.includes('sale')) {
    modes = [...new Set([...modes, 'sale'])];
    await api('POST', '/tenants/me/commerce-modes', {
      token,
      body: { modes },
    });
  }
  log(
    'bootstrap salon profile',
    type === 'salon' ? 'PASS' : 'PARTIAL',
    `type=${type} modes=[${modes}] caps=${caps.length}`,
  );
  const expectedCaps = ['BOOKING', 'STAFF_ASSIGNMENT', 'RESOURCE', 'MEMBERSHIP'];
  const missingCaps = expectedCaps.filter((c) => !caps.includes(c));
  log(
    'salon capabilities',
    missingCaps.length ? 'PARTIAL' : 'PASS',
    missingCaps.length ? `missing ${missingCaps}` : expectedCaps.join(','),
  );

  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  if (!loc?.id) {
    log('location', 'FAIL', 'no studio location');
    process.exit(1);
  }
  log('location', 'PASS', loc.name || loc.id);

  await api('POST', '/tenants/me/modules/resources/enable', { token, body: {} });
  await api('POST', '/tenants/me/modules/appointments/enable', {
    token,
    body: {},
  });

  const catNames = ['Hair', 'Skin', 'Nails', 'Retail'];
  const cats = {};
  for (const name of catNames) {
    const res = await api('POST', '/pos/sale/categories', {
      token,
      body: { name },
    });
    if (!res.ok) {
      log(`category ${name}`, 'FAIL', res.text);
    } else {
      cats[name] = res.data;
      log(`category ${name}`, 'PASS', res.data.id);
    }
  }

  const services = [
    { cat: 'Hair', title: 'Women Haircut', price: 799, track: false },
    { cat: 'Hair', title: 'Hair Color', price: 2499, track: false },
    { cat: 'Hair', title: 'Blow Dry', price: 499, track: false },
    { cat: 'Skin', title: 'Classic Facial', price: 1299, track: false },
    { cat: 'Skin', title: 'Cleanup', price: 699, track: false },
    { cat: 'Nails', title: 'Manicure', price: 599, track: false },
    { cat: 'Nails', title: 'Pedicure', price: 799, track: false },
    { cat: 'Retail', title: 'Keratin Shampoo 250ml', price: 450, track: true, qty: 24 },
  ];
  const products = {};
  for (const item of services) {
    const res = await api('POST', '/pos/sale/products', {
      token,
      body: {
        title: item.title,
        sku: sku('SLN'),
        price: item.price,
        qty: item.track ? item.qty ?? 10 : 1,
        locationId: loc.id,
        categoryId: cats[item.cat]?.id,
        trackInventory: Boolean(item.track),
        itemType: item.track ? 'goods' : 'service',
      },
    });
    if (!res.ok) {
      log(`service ${item.title}`, 'FAIL', res.text.slice(0, 160));
      continue;
    }
    const data = res.data;
    products[item.title] = {
      ...data,
      price: item.price,
      stockLevelId: data.stockLevelId || data.stockLevel?.id || data.id,
    };
    log(`catalog ${item.title}`, 'PASS', `₹${item.price}`);
  }

  const chairs = [];
  for (const name of ['Chair 1', 'Chair 2', 'Spa Room']) {
    const res = await api('POST', '/resources', {
      token,
      body: {
        name,
        type: name.includes('Room') ? 'room' : 'equipment',
        capacity: 1,
        locationId: loc.id,
      },
    });
    if (res.ok) {
      chairs.push(res.data);
      log(`resource ${name}`, 'PASS', res.data.id, 'POST /resources');
    } else {
      log(`resource ${name}`, 'FAIL', `${res.status} ${res.text.slice(0, 120)}`);
    }
  }

  const client = await api('POST', '/customers', {
    token,
    body: { fullName: 'Priya Nair', phone: phone() },
  });
  const client2 = await api('POST', '/customers', {
    token,
    body: { fullName: 'Sana Khan', phone: phone() },
  });
  log(
    'clients',
    client.ok && client2.ok ? 'PASS' : 'FAIL',
    client.ok ? client.data.id : client.text,
  );

  const staff = await api('POST', '/users', {
    token,
    body: {
      fullName: 'Aisha Stylist',
      email: `stylist.${STAMP}@upos.test`,
      password: PASSWORD,
      roleCode: 'cashier',
    },
  });
  log(
    'create stylist staff',
    staff.ok ? 'PASS' : 'PARTIAL',
    staff.ok ? staff.data?.id : `${staff.status} ${staff.text.slice(0, 140)}`,
  );

  const starts = new Date(Date.now() + 3600e3).toISOString();
  const ends = new Date(Date.now() + 7200e3).toISOString();
  const chairId = chairs[0]?.id;
  const appt = await api('POST', '/appointments', {
    token,
    body: {
      locationId: loc.id,
      customerId: client.data?.id,
      type: 'service',
      serviceName: 'Women Haircut',
      startsAt: starts,
      endsAt: ends,
      resourceId: chairId,
      notes: 'First visit — layers',
    },
  });
  log(
    'book haircut appointment',
    appt.ok ? 'PASS' : 'FAIL',
    appt.ok ? appt.data.id : `${appt.status} ${appt.text.slice(0, 180)}`,
    'POST /appointments',
  );

  if (appt.ok && chairId) {
    const clash = await api('POST', '/appointments', {
      token,
      body: {
        locationId: loc.id,
        customerId: client2.data?.id,
        type: 'service',
        serviceName: 'Blow Dry',
        startsAt: starts,
        endsAt: ends,
        resourceId: chairId,
      },
    });
    log(
      'double-book Chair 1 blocked',
      !clash.ok ? 'PASS' : 'FAIL',
      clash.ok ? 'overlap allowed' : String(clash.status),
    );
  }

  const facialStart = new Date(Date.now() + 10800e3).toISOString();
  const facialEnd = new Date(Date.now() + 14400e3).toISOString();
  const facial = await api('POST', '/appointments', {
    token,
    body: {
      locationId: loc.id,
      customerId: client2.data?.id,
      type: 'service',
      serviceName: 'Classic Facial',
      startsAt: facialStart,
      endsAt: facialEnd,
      resourceId: chairs[2]?.id || chairs[1]?.id,
    },
  });
  log(
    'book facial appointment',
    facial.ok ? 'PASS' : 'PARTIAL',
    facial.ok ? facial.data.id : `${facial.status}`,
  );

  const regCur = await api(
    'GET',
    `/pos/sale/register/current?locationId=${loc.id}`,
    { token },
  );
  if (!(regCur.data?.session?.id || regCur.data?.id)) {
    const opened = await api('POST', '/pos/sale/register/open', {
      token,
      body: { locationId: loc.id, openingFloat: 1500 },
    });
    log(
      'open register',
      opened.ok ? 'PASS' : 'FAIL',
      opened.ok ? '' : opened.text.slice(0, 120),
    );
  } else {
    log('open register', 'PASS', 'already open');
  }

  const haircut = products['Women Haircut'];
  const shampoo = products['Keratin Shampoo 250ml'];
  const manicure = products['Manicure'];

  const serviceBill = await checkoutCash(
    token,
    loc.id,
    [
      { stockLevelId: haircut?.stockLevelId, quantity: 1, unitPrice: 799 },
      { stockLevelId: shampoo?.stockLevelId, quantity: 1, unitPrice: 450 },
    ],
    {
      customerId: client.data?.id,
      note: 'Haircut + take-home shampoo',
      meta: { appointmentId: appt.data?.id, chair: 'Chair 1' },
    },
  );
  log(
    'bill haircut + retail',
    serviceBill.ok ? 'PASS' : 'FAIL',
    serviceBill.ok ? serviceBill.data.order.id : serviceBill.text.slice(0, 180),
    'POST /pos/sale/checkout',
  );

  const walkin = await checkoutCash(
    token,
    loc.id,
    [{ stockLevelId: manicure?.stockLevelId, quantity: 1, unitPrice: 599 }],
    {
      customerId: client2.data?.id,
      note: 'Walk-in manicure',
    },
  );
  log(
    'walk-in manicure bill',
    walkin.ok ? 'PASS' : 'FAIL',
    walkin.ok ? walkin.data.order.id : walkin.text.slice(0, 160),
  );

  if (serviceBill.ok && serviceBill.data.order.id) {
    const receipt = await api(
      'GET',
      `/pos/orders/${serviceBill.data.order.id}/receipt`,
      { token },
    );
    log(
      'haircut receipt',
      receipt.ok ? 'PASS' : 'FAIL',
      receipt.ok ? 'ok' : String(receipt.status),
    );
    const hist = await api('GET', `/customers/${client.data.id}/orders`, {
      token,
    });
    const n = asList(hist.data).length || asList(hist.data?.orders).length;
    log(
      'client history',
      hist.ok ? 'PASS' : 'PARTIAL',
      `orders=${n || (hist.ok ? 'ok' : hist.status)}`,
    );
  }

  const appts = await api('GET', '/appointments?limit=20', { token });
  log(
    'list appointments',
    appts.ok ? 'PASS' : 'PARTIAL',
    appts.ok ? `n=${asList(appts.data).length}` : String(appts.status),
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
  log('reports', rok === 3 ? 'PASS' : 'PARTIAL', `${rok}/3`);

  const catalog = await api(
    'GET',
    `/pos/sale/catalog?locationId=${loc.id}&limit=50`,
    { token },
  );
  const nItems = asList(catalog.data?.items ?? catalog.data).length;
  log(
    'counter catalog',
    catalog.ok && nItems >= 6 ? 'PASS' : 'PARTIAL',
    `items=${nItems}`,
  );

  const pass = RESULTS.filter((r) => r.status === 'PASS').length;
  const partial = RESULTS.filter((r) => r.status === 'PARTIAL').length;
  const fail = RESULTS.filter((r) => r.status === 'FAIL').length;
  const verdict =
    fail > 0
      ? 'SALON RUNS WITH FAILURES'
      : partial
        ? 'SALON OPERATIONAL WITH GAPS'
        : 'SALON FULLY OPERATIONAL';

  const loginInfo = {
    app: APP_LOGIN,
    email: EMAIL,
    password: PASSWORD,
    organization: ORG,
    branch: 'Bandra Studio',
    owner: 'Meera Kapoor',
  };

  console.log('\n========== VERDICT ==========');
  console.log(verdict);
  console.log(`Steps PASS=${pass} PARTIAL=${partial} FAIL=${fail}`);
  console.log('\n========== LOGIN (local UI) ==========');
  console.log(`Open:     ${loginInfo.app}`);
  console.log(`Email:    ${loginInfo.email}`);
  console.log(`Password: ${loginInfo.password}`);
  console.log(`Shop:     ${loginInfo.organization}`);
  console.log(
    'Seeded:   7 services + shampoo, 3 chairs/rooms, 2 clients, appointments, 2 bills',
  );

  const report = {
    generatedAt: new Date().toISOString(),
    api: API,
    verdict,
    login: loginInfo,
    summary: { pass, partial, fail },
    results: RESULTS,
  };
  writeFileSync(
    join(OUT_DIR, `salon-full-${STAMP}.json`),
    JSON.stringify(report, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, 'salon-full-latest.json'),
    JSON.stringify(report, null, 2),
  );
  if (fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
