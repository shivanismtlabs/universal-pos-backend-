/**
 * Load The Pool Store (Valdosta) onto a live API — no DB wipe.
 *
 *   API_URL=http://13.126.105.138:3001/v1 node scripts/load-pool-store-production.mjs
 */
const API = process.env.API_URL ?? 'http://13.126.105.138:3001/v1';
const EMAIL = process.env.POOL_EMAIL ?? 'owner@pool.demo';
const PASSWORD = process.env.POOL_PASSWORD ?? 'WalitShop@2026';
const CASHIER_EMAIL = process.env.POOL_CASHIER ?? 'cashier@pool.demo';
const SLUG = process.env.POOL_SLUG ?? 'pool-store';
const APP =
  process.env.FE_URL ??
  (API.includes('13.126.105.138')
    ? 'http://13.126.105.138:3000/login'
    : 'http://localhost:3000/login');

const CATEGORIES = [
  'Chlorine & Shock',
  'Algaecides',
  'Stain Treatment',
  'Balance & Clarifiers',
  'Pool Maintenance Chemicals',
  'Spa Chemicals',
  'Spa Fragrances',
  'Automatic Pool Cleaners',
  'Pumps & Motors',
  'Pool & Spa Filters',
  'Heaters',
  'Salt Systems',
  'Automation Control',
  'Filter Media & Grids',
  'Pool & Spa Lights',
  'Replacement Parts',
  'Pool Maintenance',
  'Pool Decks',
  'Pool Covers',
  'Above Ground Pools',
  'Spas & Hot Tubs',
  'Saunas',
  'Floats',
  'Toys & Games',
  'Grills',
  'Firepits',
  'Grill Accessories',
  'Furniture',
  'Patio Accessories',
  'Clearance',
  'Service',
];

const PRODUCTS = [
  { category: 'Chlorine & Shock', name: 'Chlorine granules 25 lb', sku: 'CHL-GRAN-25', price: 89.99, qty: 40 },
  { category: 'Chlorine & Shock', name: 'Chlorine tablets 3 in 25 lb', sku: 'CHL-TAB-25', price: 94.99, qty: 35 },
  { category: 'Chlorine & Shock', name: 'Liquid shock 1 gal', sku: 'CHL-SHOCK-1G', price: 12.99, qty: 80 },
  { category: 'Algaecides', name: 'Algaecide 1 qt', sku: 'ALG-1QT', price: 18.99, qty: 45 },
  { category: 'Algaecides', name: 'Mustard algae treatment', sku: 'ALG-MUST', price: 24.99, qty: 28 },
  { category: 'Stain Treatment', name: 'Metal stain remover', sku: 'STAIN-MET', price: 22.49, qty: 30 },
  { category: 'Stain Treatment', name: 'Scale prevent 1 qt', sku: 'STAIN-SCALE', price: 19.99, qty: 26 },
  { category: 'Balance & Clarifiers', name: 'pH increaser 5 lb', sku: 'PH-INC-5', price: 14.49, qty: 60 },
  { category: 'Balance & Clarifiers', name: 'pH decreaser 7 lb', sku: 'PH-DEC-7', price: 15.99, qty: 55 },
  { category: 'Balance & Clarifiers', name: 'Alkalinity increaser 5 lb', sku: 'ALK-INC-5', price: 13.99, qty: 50 },
  { category: 'Balance & Clarifiers', name: 'Stabilizer 4 lb', sku: 'CYA-4', price: 24.99, qty: 30 },
  { category: 'Balance & Clarifiers', name: 'Water clarifier 1 qt', sku: 'CLAR-1QT', price: 11.99, qty: 48 },
  { category: 'Pool Maintenance Chemicals', name: 'Enzyme cleaner 1 qt', sku: 'MAINT-ENZ', price: 16.99, qty: 32 },
  { category: 'Spa Chemicals', name: 'Spa bromine tabs', sku: 'SPA-BR-TABS', price: 29.99, qty: 40 },
  { category: 'Spa Chemicals', name: 'Spa foam down', sku: 'SPA-FOAM', price: 11.99, qty: 35 },
  { category: 'Spa Chemicals', name: 'Spa test strips 50ct', sku: 'SPA-TEST-50', price: 8.49, qty: 70 },
  { category: 'Spa Fragrances', name: 'Spa fragrance eucalyptus', sku: 'SPA-FRAG-EU', price: 9.99, qty: 50 },
  { category: 'Automatic Pool Cleaners', name: 'Pressure cleaner entry', sku: 'CLN-PRESS-E', price: 399, qty: 5 },
  { category: 'Automatic Pool Cleaners', name: 'Robotic cleaner entry', sku: 'CLN-ROBO-E', price: 499, qty: 4 },
  { category: 'Pumps & Motors', name: '1.5 HP pool pump', sku: 'PUMP-15HP', price: 389, qty: 6 },
  { category: 'Pumps & Motors', name: 'Pump basket', sku: 'PUMP-BASKET', price: 17.99, qty: 22 },
  { category: 'Pool & Spa Filters', name: 'Cartridge filter C-4950', sku: 'CART-C4950', price: 54.99, qty: 15 },
  { category: 'Heaters', name: 'Heater pad', sku: 'HEAT-PAD', price: 49.99, qty: 10 },
  { category: 'Salt Systems', name: 'Salt cell compatible', sku: 'SALT-CELL', price: 429, qty: 5 },
  { category: 'Salt Systems', name: 'Salt test strips', sku: 'SALT-TEST', price: 12.99, qty: 40 },
  { category: 'Automation Control', name: 'Pool timer switch', sku: 'AUTO-TIMER', price: 89.99, qty: 8 },
  { category: 'Filter Media & Grids', name: 'Sand filter media 50 lb', sku: 'SAND-50', price: 19.99, qty: 28 },
  { category: 'Pool & Spa Lights', name: 'LED pool light niche', sku: 'LIGHT-LED', price: 189, qty: 8 },
  { category: 'Replacement Parts', name: 'O-ring assortment kit', sku: 'ORING-KIT', price: 14.99, qty: 35 },
  { category: 'Pool Maintenance', name: 'Wall brush 18 in', sku: 'BRUSH-18', price: 22.99, qty: 25 },
  { category: 'Pool Maintenance', name: 'Leaf skimmer net', sku: 'SKIM-NET', price: 16.99, qty: 40 },
  { category: 'Pool Maintenance', name: 'Vacuum head weighted', sku: 'VAC-HEAD', price: 34.99, qty: 20 },
  { category: 'Pool Maintenance', name: 'Telescopic pole 8-24 ft', sku: 'POLE-824', price: 49.99, qty: 18 },
  { category: 'Pool Maintenance', name: 'Pool test kit liquid', sku: 'TEST-KIT-LQ', price: 21.99, qty: 32 },
  { category: 'Pool Decks', name: 'Deck anchor set', sku: 'DECK-ANC', price: 24.99, qty: 20 },
  { category: 'Pool Covers', name: 'Winter cover 18x36', sku: 'COV-W1836', price: 129, qty: 8 },
  { category: 'Pool Covers', name: 'Solar blanket 16 ft', sku: 'COV-SOL16', price: 89, qty: 10 },
  { category: 'Above Ground Pools', name: 'Above-ground liner 18 ft', sku: 'AGP-LINER18', price: 349, qty: 3 },
  { category: 'Spas & Hot Tubs', name: 'Spa cover lifter', sku: 'SPA-LIFT', price: 179, qty: 5 },
  { category: 'Saunas', name: 'Sauna bucket & ladle set', sku: 'SAUNA-SET', price: 39.99, qty: 12 },
  { category: 'Floats', name: 'Lounge float adult', sku: 'FLOAT-ADULT', price: 34.99, qty: 25 },
  { category: 'Floats', name: 'Noodle float 3-pack', sku: 'TOY-NOODLE', price: 19.99, qty: 30 },
  { category: 'Toys & Games', name: 'Dive ring set 4pc', sku: 'TOY-RINGS', price: 12.99, qty: 40 },
  { category: 'Grills', name: 'Propane grill cover large', sku: 'GRILL-COV-L', price: 39.99, qty: 14 },
  { category: 'Firepits', name: 'Fire pit bowl 26 in', sku: 'FIRE-26', price: 149, qty: 7 },
  { category: 'Grill Accessories', name: 'Grill tool set 5pc', sku: 'GRILL-TOOL', price: 29.99, qty: 18 },
  { category: 'Furniture', name: 'Patio chair set pair', sku: 'PATIO-CHAIR', price: 159, qty: 9 },
  { category: 'Patio Accessories', name: 'Outdoor patio heater', sku: 'PATIO-HEAT', price: 199.99, qty: 6 },
  { category: 'Clearance', name: 'Seasonal clearance mix', sku: 'CLR-MIX', price: 9.99, qty: 20 },
  { category: 'Service', name: 'Walk-in water test', sku: 'SVC-H2O-TEST', price: 5, qty: 0, kind: 'service' },
  { category: 'Service', name: 'On-site service call', sku: 'SVC-CALL', price: 89, qty: 0, kind: 'service' },
  { category: 'Service', name: 'Install / repair labor (hour)', sku: 'SVC-LABOR-HR', price: 125, qty: 0, kind: 'service' },
  { category: 'Service', name: 'Salt conversion consult', sku: 'SVC-SALT-CV', price: 75, qty: 0, kind: 'service' },
];

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
    text: text.slice(0, 1600),
  };
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.organizations)) return payload.organizations;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function enterShop(authData) {
  if (authData?.accessToken) {
    return { token: authData.accessToken, how: 'direct' };
  }
  const identityToken = authData?.identityToken;
  if (!identityToken) return { token: null, how: 'none' };
  const listed = await api('GET', '/auth/organizations', { token: identityToken });
  const orgs = asList(listed.data?.organizations ?? listed.data);
  const match =
    orgs.find((o) => String(o.slug || o.tenantSlug || '') === SLUG) ||
    orgs.find((o) => /pool store/i.test(String(o.name || o.organizationName || ''))) ||
    orgs[0];
  if (match?.tenantId) {
    const selected = await api('POST', '/auth/select-organization', {
      token: identityToken,
      body: { tenantId: match.tenantId },
    });
    if (selected.ok && selected.data?.accessToken) {
      return { token: selected.data.accessToken, how: 'select_org' };
    }
  }
  const created = await api('POST', '/auth/organizations', {
    token: identityToken,
    body: {
      organizationName: 'The Pool Store',
      businessType: 'retail',
      businessLabel: 'Pool, spa & backyard retail',
      addressLine1: '3363 North Valdosta Road',
      city: 'Valdosta',
      state: 'Georgia',
      postalCode: '31602',
      countryCode: 'US',
      currencyCode: 'USD',
      locale: 'en-US',
      phone: '+12292476440',
      storeName: 'Valdosta Flagship',
      inventoryStartDate: '2026-01-01',
      fiscalYearStart: 'January',
    },
  });
  if (created.ok && created.data?.accessToken) {
    return { token: created.data.accessToken, how: 'create_org' };
  }
  return { token: null, how: 'failed', detail: created.text };
}

async function loginOrRegister() {
  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD, tenantSlug: SLUG },
  });
  let entered = await enterShop(login.data);
  if (entered.token) return { ...entered, created: false };

  entered = await enterShop(login.data);
  if (entered.token) return { ...entered, created: false };

  const loginPlain = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  entered = await enterShop(loginPlain.data);
  if (entered.token) return { ...entered, created: false };

  const registered = await api('POST', '/auth/register-tenant', {
    body: {
      tenantName: 'The Pool Store',
      tenantSlug: SLUG,
      storeName: 'Valdosta Flagship',
      adminFullName: 'Pool Store Owner',
      adminEmail: EMAIL,
      adminPassword: PASSWORD,
      adminPhone: '+12292476440',
    },
  });
  entered = await enterShop(registered.data);
  if (entered.token) return { ...entered, created: true, register: registered.status };

  const signup = await api('POST', '/auth/signup', {
    body: {
      email: EMAIL,
      password: PASSWORD,
      fullName: 'Pool Store Owner',
      phone: '+12292476440',
    },
  });
  entered = await enterShop(signup.data);
  if (entered.token) return { ...entered, created: true, signup: signup.status };

  return {
    token: null,
    how: 'failed',
    detail: `login=${login.status} ${login.text.slice(0, 180)} | register=${registered.status} ${registered.text.slice(0, 180)} | signup=${signup.status} ${signup.text.slice(0, 180)}`,
  };
}

async function main() {
  console.log(`Load The Pool Store → ${API}\n`);
  const health = await api('GET', '/health');
  if (!health.ok) {
    console.error('API down', health.status, health.text);
    process.exit(1);
  }
  console.log('health   PASS');

  const session = await loginOrRegister();
  if (!session.token) {
    console.error('auth FAIL', session.detail || session.how);
    process.exit(1);
  }
  const token = session.token;
  console.log(`auth     PASS  ${EMAIL} via ${session.how} created=${!!session.created}`);

  await api('PATCH', '/tenants/me', { token, body: { name: 'The Pool Store' } });
  await api('POST', '/tenants/me/business-config', {
    token,
    body: { businessType: 'retail', applyDefaultModes: true },
  });
  await api('POST', '/tenants/me/commerce-modes', {
    token,
    body: { modes: ['sale', 'service'] },
  });

  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  if (!loc?.id) {
    console.error('location FAIL', locs.text);
    process.exit(1);
  }
  await api('PATCH', `/locations/${loc.id}`, {
    token,
    body: {
      name: 'Valdosta Flagship',
      address: '3363 North Valdosta Road, Valdosta, GA 31602',
      regionCode: 'GA',
      phone: '+12292476440',
    },
  });
  console.log(`location PASS  ${loc.id}`);

  const existingCats = asList((await api('GET', '/pos/sale/categories', { token })).data);
  const cats = {};
  for (const c of existingCats) cats[c.name] = c;
  let catCreated = 0;
  for (const name of CATEGORIES) {
    if (cats[name]?.id) continue;
    const res = await api('POST', '/pos/sale/categories', { token, body: { name } });
    if (res.ok) {
      cats[name] = res.data;
      catCreated += 1;
    } else {
      console.log(`category FAIL  ${name}  ${res.status} ${res.text.slice(0, 120)}`);
    }
  }
  console.log(`cats     PASS  total=${Object.keys(cats).length} created=${catCreated}`);

  const existingProducts = asList(
    (await api('GET', `/pos/sale/products?locationId=${loc.id}`, { token })).data,
  );
  const bySku = new Set(
    existingProducts.map((p) => String(p.sku || p.skuCode || '').toUpperCase()),
  );
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of PRODUCTS) {
    if (bySku.has(p.sku.toUpperCase())) {
      skipped += 1;
      continue;
    }
    const isService = p.kind === 'service';
    const res = await api('POST', '/pos/sale/products', {
      token,
      body: {
        title: p.name,
        sku: p.sku,
        price: Math.max(Number(p.price) || 0, 0.01),
        qty: isService ? 0 : p.qty,
        locationId: loc.id,
        categoryId: cats[p.category]?.id,
        sellUnit: 'pcs',
        ...(isService ? { trackInventory: false, itemType: 'service' } : {}),
      },
    });
    if (res.ok) {
      created += 1;
      bySku.add(p.sku.toUpperCase());
    } else {
      failed += 1;
      console.log(`item FAIL  ${p.sku}  ${res.status} ${res.text.slice(0, 160)}`);
    }
  }
  console.log(`items    created=${created} skipped=${skipped} failed=${failed} want=${PRODUCTS.length}`);

  const cashier = await api('POST', '/auth/register-user', {
    body: {
      tenantSlug: SLUG,
      fullName: 'Pool Cashier',
      email: CASHIER_EMAIL,
      password: PASSWORD,
      phone: '+12292476441',
    },
  });
  const cashierOk = cashier.ok || cashier.status === 409;
  console.log(
    `cashier  ${cashierOk ? 'PASS' : 'PARTIAL'}  ${CASHIER_EMAIL} ${cashier.status} ${cashier.ok ? '' : cashier.text.slice(0, 140)}`,
  );

  const listed = asList(
    (await api('GET', `/pos/sale/products?locationId=${loc.id}`, { token })).data,
  );

  console.log('\n========== PRODUCTION LOGIN ==========');
  console.log(`App:      ${APP}`);
  console.log(`API:      ${API}`);
  console.log(`Shop:     The Pool Store (${SLUG})`);
  console.log(`Owner:    ${EMAIL}`);
  console.log(`Cashier:  ${CASHIER_EMAIL}`);
  console.log(`Password: ${PASSWORD}`);
  console.log(`Catalog:  ${listed.length} items on Valdosta Flagship`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
