/**
 * Enrich Northside Pool & Spa with the rest of a pool/spa shop’s work:
 * chemicals departments, equipment, backyard, install/repair jobs,
 * field appointments, app coupons, gift card, pay-bill balance.
 *
 * Maps https://thepoolstore.net nav → Universal Core (Other), not a pool-only app.
 *
 *   API_URL=http://13.126.105.138:3001/v1 node scripts/pool-store-enrich.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://13.126.105.138:3001/v1';
const EMAIL = process.env.POOL_EMAIL ?? 'pool.demo.mswxr70n@upos.test';
const PASSWORD = process.env.POOL_PASSWORD ?? 'PoolStore@2026';
const STAMP = Date.now().toString(36);
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, 'qa-results');
mkdirSync(OUT, { recursive: true });

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
    text: text.slice(0, 900),
  };
}

function asList(p) {
  if (Array.isArray(p)) return p;
  if (Array.isArray(p?.items)) return p.items;
  if (Array.isArray(p?.organizations)) return p.organizations;
  if (Array.isArray(p?.data)) return p.data;
  if (Array.isArray(p?.customers)) return p.customers;
  return [];
}

function sku(n) {
  return `POLX${STAMP}${n}`.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 18).padEnd(15, '0');
}

async function login() {
  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  if (login.data?.accessToken) return login.data.accessToken;
  const idt = login.data?.identityToken;
  if (!idt) return null;
  const listed = await api('GET', '/auth/organizations', { token: idt });
  const org = asList(listed.data?.organizations ?? listed.data)[0];
  const sel = await api('POST', '/auth/select-organization', {
    token: idt,
    body: { tenantId: org?.tenantId },
  });
  return sel.data?.accessToken || null;
}

async function main() {
  console.log(`POOL STORE ENRICH (website nav → Universal Core) @ ${API}\n`);
  const token = await login();
  if (!token) {
    log('login', 'FAIL');
    process.exit(1);
  }
  log('login', 'PASS', EMAIL);

  const caps = await api('POST', '/tenants/me/capabilities', {
    token,
    body: {
      capabilities: [
        'INVENTORY',
        'BARCODE',
        'BOOKING',
        'RESOURCE',
        'REPAIR_JOB',
        'ASSET',
        'STAFF_ASSIGNMENT',
        'LOYALTY',
        'PARTIAL_PAYMENT',
        'CUSTOM_FIELDS',
        'DELIVERY',
      ],
    },
  });
  log(
    'capabilities (jobs, bookings, loyalty, pay-later)',
    caps.ok ? 'PASS' : 'PARTIAL',
    caps.ok ? 'ok' : `${caps.status}`,
  );

  await api('POST', '/tenants/me/commerce-modes', {
    token,
    body: { modes: ['sale', 'service'] },
  });
  for (const code of ['jobs', 'appointments', 'resources']) {
    const m = await api('POST', `/tenants/me/modules/${code}/enable`, {
      token,
      body: {},
    });
    log(
      `module ${code}`,
      m.ok || m.status === 409 ? 'PASS' : 'PARTIAL',
      m.ok ? 'enabled' : `${m.status}`,
    );
  }

  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  log('location', loc?.id ? 'PASS' : 'FAIL', loc?.name || '');

  const existingCats = asList(
    (await api('GET', '/pos/sale/categories', { token })).data,
  );
  const cats = {};
  for (const c of existingCats) cats[c.name] = c;
  for (const name of [
    'Stain treatment',
    'Balance & clarifiers',
    'Spa chemicals',
    'Heaters',
    'Salt systems',
    'Filters',
    'Automation',
    'Lights',
    'Replacement parts',
    'Toys & floats',
    'Fire pits',
    'Spas & hot tubs',
    'Patio furniture',
    'Above-ground pools',
    'Clearance',
  ]) {
    if (cats[name]?.id) {
      log(`category ${name}`, 'PASS', 'exists');
      continue;
    }
    const res = await api('POST', '/pos/sale/categories', {
      token,
      body: { name },
    });
    if (res.ok) cats[name] = res.data;
    log(`category ${name}`, res.ok ? 'PASS' : 'FAIL', res.ok ? '' : res.text.slice(0, 80));
  }

  const existingTitles = new Set(
    asList(
      (
        await api('GET', `/pos/sale/products?locationId=${loc.id}&limit=200`, {
          token,
        })
      ).data,
    ).map((p) => String(p.title || p.name || '')),
  );

  const extraItems = [
    { cat: 'Stain treatment', title: 'Metal stain treatment 1 L', price: 899, qty: 24 },
    { cat: 'Balance & clarifiers', title: 'pH minus 2 kg', price: 549, qty: 40 },
    { cat: 'Spa chemicals', title: 'Spa shock 1 kg', price: 799, qty: 30 },
    { cat: 'Heaters', title: 'Heat pump 50k BTU', price: 89990, qty: 3 },
    { cat: 'Salt systems', title: 'Salt cell replacement', price: 18990, qty: 6 },
    { cat: 'Filters', title: 'Cartridge filter 150 sq ft', price: 12990, qty: 8 },
    { cat: 'Automation', title: 'Pool control timer', price: 4990, qty: 10 },
    { cat: 'Lights', title: 'LED pool light', price: 6490, qty: 12 },
    { cat: 'Replacement parts', title: 'Pump seal kit', price: 1299, qty: 25 },
    { cat: 'Toys & floats', title: 'Lounge float', price: 2499, qty: 20 },
    { cat: 'Fire pits', title: 'Propane fire bowl', price: 18990, qty: 4 },
    { cat: 'Spas & hot tubs', title: '4-person spa (floor)', price: 249000, qty: 2 },
    { cat: 'Patio furniture', title: 'Patio lounge chair', price: 7990, qty: 10 },
    { cat: 'Above-ground pools', title: '15 ft round pool kit', price: 89900, qty: 2 },
    { cat: 'Clearance', title: 'Clearance shock 5 kg', price: 999, qty: 15 },
    {
      cat: 'Service',
      title: 'Pump installation',
      price: 6500,
      qty: 0,
      trackInventory: false,
    },
    {
      cat: 'Service',
      title: 'Heater installation',
      price: 8900,
      qty: 0,
      trackInventory: false,
    },
    {
      cat: 'Service',
      title: 'Filter repair visit',
      price: 3200,
      qty: 0,
      trackInventory: false,
    },
    {
      cat: 'Service',
      title: 'Water test (in store)',
      price: 0.01,
      qty: 0,
      trackInventory: false,
    },
    {
      cat: 'Service',
      title: 'Seasonal pool closing',
      price: 5499,
      qty: 0,
      trackInventory: false,
    },
    {
      cat: 'Service',
      title: 'Salt conversion consult',
      price: 1999,
      qty: 0,
      trackInventory: false,
    },
  ];

  const created = {};
  let n = 0;
  for (const item of extraItems) {
    if (existingTitles.has(item.title)) {
      log(`item ${item.title}`, 'PASS', 'exists');
      continue;
    }
    const catId = cats[item.cat]?.id;
    const res = await api('POST', '/pos/sale/products', {
      token,
      body: {
        title: item.title,
        sku: sku(n++),
        price: item.price < 1 ? 1 : item.price,
        qty: item.qty,
        locationId: loc.id,
        ...(catId ? { categoryId: catId } : {}),
        ...(item.trackInventory === false
          ? { trackInventory: false, itemType: 'service' }
          : {}),
      },
    });
    if (res.ok) {
      created[item.title] =
        res.data.stockLevelId || res.data.stockLevel?.id || res.data.id;
    }
    log(
      `item ${item.title}`,
      res.ok ? 'PASS' : 'FAIL',
      res.ok ? `₹${item.price}` : res.text.slice(0, 90),
    );
  }

  let customers = asList((await api('GET', '/customers?limit=50', { token })).data);
  let chris = customers.find((c) => /homeowner/i.test(c.fullName || c.name || ''));
  if (!chris) {
    const c = await api('POST', '/customers', {
      token,
      body: { fullName: 'Chris Homeowner', phone: `9${Date.now().toString().slice(-9)}` },
    });
    chris = c.data;
  }
  const bill = await api('POST', '/customers', {
    token,
    body: {
      fullName: 'Riley Account',
      phone: `8${Date.now().toString().slice(-9)}`,
      email: `riley.bill.${STAMP}@upos.test`,
    },
  });
  const billCust = bill.ok ? bill.data : chris;
  log('customers', chris?.id && billCust?.id ? 'PASS' : 'PARTIAL', 'homeowner + pay-bill account');

  const van = await api('POST', '/resources', {
    token,
    body: {
      name: 'Service van A',
      type: 'vehicle',
      locationId: loc.id,
      capacity: 2,
    },
  });
  log(
    'resource Service van A',
    van.ok ? 'PASS' : 'PARTIAL',
    van.ok ? van.data?.id : `${van.status}`,
  );
  const bay = await api('POST', '/resources', {
    token,
    body: { name: 'Tech bay 1', type: 'bay', locationId: loc.id, capacity: 1 },
  });
  log(
    'resource Tech bay 1',
    bay.ok ? 'PASS' : 'PARTIAL',
    bay.ok ? bay.data?.id : `${bay.status}`,
  );

  const poolAsset = await api('POST', '/assets', {
    token,
    body: {
      customerId: chris.id,
      name: 'Backyard pool 16x32',
      assetType: 'pool',
      identifier: 'VAL-POOL-001',
      meta: { sanitizer: 'chlorine', gallons: 18000 },
    },
  });
  log(
    'customer asset (pool)',
    poolAsset.ok ? 'PASS' : 'PARTIAL',
    poolAsset.ok ? poolAsset.data?.id : `${poolAsset.status}`,
  );

  const repair = await api('POST', '/jobs', {
    token,
    body: {
      customerId: chris.id,
      assetId: poolAsset.data?.id,
      locationId: loc.id,
      title: 'Equipment repair — pump noisy',
      problem: 'Circulation pump rattles on start (website: Equipment Repair / Pumps)',
      estimatedCost: 4500,
      dueAt: new Date(Date.now() + 2 * 864e5).toISOString(),
      resourceId: van.data?.id,
      lines: [
        { kind: 'labor', description: 'Diagnose + labor', qty: 1, unitPrice: 3200 },
        { kind: 'part', description: 'Pump seal kit', qty: 1, unitPrice: 1299 },
      ],
      meta: { requestType: 'repair', equipment: 'pumps' },
    },
  });
  log(
    'job pump repair',
    repair.ok ? 'PASS' : 'PARTIAL',
    repair.ok ? repair.data?.id : `${repair.status} ${repair.text.slice(0, 80)}`,
  );

  const install = await api('POST', '/jobs', {
    token,
    body: {
      customerId: chris.id,
      assetId: poolAsset.data?.id,
      locationId: loc.id,
      title: 'Equipment install — heat pump',
      problem: 'New heat pump install (website: Equipment Installation / Heaters)',
      estimatedCost: 99000,
      resourceId: van.data?.id,
      lines: [
        { kind: 'labor', description: 'Heater installation', qty: 1, unitPrice: 8900 },
      ],
      meta: { requestType: 'install', equipment: 'heaters' },
    },
  });
  log(
    'job heater install',
    install.ok ? 'PASS' : 'PARTIAL',
    install.ok ? install.data?.id : `${install.status}`,
  );

  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const appt = await api('POST', '/appointments', {
    token,
    body: {
      locationId: loc.id,
      customerId: chris.id,
      type: 'service',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
      resourceId: van.data?.id,
      notes: 'In-store / on-site water test (green pool consult)',
      serviceName: 'Water test (in store)',
    },
  });
  log(
    'appointment water test',
    appt.ok ? 'PASS' : 'PARTIAL',
    appt.ok ? appt.data?.id : `${appt.status} ${appt.text.slice(0, 80)}`,
  );

  const loy = await api('PATCH', '/loyalty/settings', {
    token,
    body: { enabled: true, earnPerCurrency: 1, currencyPerPoint: 1 },
  });
  log('loyalty / app points', loy.ok ? 'PASS' : 'PARTIAL', loy.ok ? 'on' : `${loy.status}`);
  const coup = await api('POST', '/loyalty/coupons', {
    token,
    body: {
      code: 'APP15',
      description: 'App coupon (website: Get coupons in the app)',
      discountType: 'percent',
      discountValue: 15,
      minOrderAmount: 500,
    },
  });
  log(
    'coupon APP15',
    coup.ok ? 'PASS' : 'PARTIAL',
    coup.ok ? '15% off' : `${coup.status}`,
  );
  const card = await api('POST', '/loyalty/gift-cards', {
    token,
    body: {
      code: `GC-POOL-${STAMP.slice(-6).toUpperCase()}`,
      initialValue: 2500,
      customerId: chris.id,
      note: 'Store credit / gift',
    },
  });
  log(
    'gift card',
    card.ok ? 'PASS' : 'PARTIAL',
    card.ok ? card.data?.code || 'ok' : `${card.status}`,
  );

  const listed = asList(
    (await api('GET', `/pos/sale/products?locationId=${loc.id}&limit=200`, { token })).data,
  );
  const shock = listed.find((p) => /chlorine shock/i.test(p.title || ''));
  const cur = await api('GET', `/pos/sale/register/current?locationId=${loc.id}`, { token });
  if (!(cur.data?.session?.id || cur.data?.id)) {
    await api('POST', '/pos/sale/register/open', {
      token,
      body: { locationId: loc.id, openingFloat: 5000 },
    });
  }
  if (shock?.id && billCust?.id) {
    const due = Number(shock.price || shock.sellPrice || 1899);
    const sale = await api('POST', '/pos/sale/checkout', {
      token,
      body: {
        locationId: loc.id,
        customerId: billCust.id,
        note: 'Pay-bill path: balance left on account',
        allowPartial: true,
        items: [
          {
            stockLevelId: shock.id,
            quantity: 1,
            unitPrice: due,
          },
        ],
        payments: [
          {
            method: 'cash',
            amount: Math.round(due * 0.4),
            idempotencyKey: `paybill-${STAMP}`,
          },
        ],
      },
    });
    log(
      'pay-bill (partial / outstanding)',
      sale.ok ? 'PASS' : 'PARTIAL',
      sale.ok
        ? `order=${sale.data?.order?.id} balance`
        : `${sale.status} ${sale.text.slice(0, 80)}`,
    );
  }

  const listedAfter = asList(
    (
      await api('GET', `/pos/sale/catalog?locationId=${loc.id}&limit=80`, { token })
    ).data,
  );
  log(
    'catalog depth',
    listedAfter.length >= 12 ? 'PASS' : 'PARTIAL',
    `counter items=${listedAfter.length}`,
  );

  const passN = RESULTS.filter((r) => r.status === 'PASS').length;
  const partialN = RESULTS.filter((r) => r.status === 'PARTIAL').length;
  const failN = RESULTS.filter((r) => r.status === 'FAIL').length;
  console.log('\n========== VERDICT ==========');
  console.log(`PASS=${passN} PARTIAL=${partialN} FAIL=${failN}`);
  console.log('\nWebsite nav → POS (same login)');
  console.log('  Chemicals / equipment / backyard → Inventory Items + Counter');
  console.log('  Installation & Repairs form     → Jobs (+ customer Assets)');
  console.log('  Technician / van                 → Resources');
  console.log('  Schedule a visit / water test    → Appointments');
  console.log('  Get coupons in the app           → Customers & Perks / Loyalty (APP15)');
  console.log('  Pay My Bill                      → Orders with balance / Customers');
  console.log('  Mobile shopping app              → not in this POS phase (P3)');
  console.log(`\nOpen: http://13.126.105.138:3000/login`);
  console.log(`Email: ${EMAIL}`);
  console.log(`Password: ${PASSWORD}`);

  writeFileSync(
    join(OUT, `pool-store-enrich-${STAMP}.json`),
    JSON.stringify({ api: API, email: EMAIL, results: RESULTS }, null, 2),
  );
  if (failN) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
