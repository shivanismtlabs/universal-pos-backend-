/**
 * Finish Glow Studio Salon on older production API (no /resources, no checkout meta).
 */
const API = process.env.API_URL ?? 'http://13.126.105.138:3001/v1';
const EMAIL = process.env.SALON_EMAIL ?? 'salon.demo.mswuu7gg@upos.test';
const PASSWORD = process.env.SALON_PASSWORD ?? 'SalonDemo@2026';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
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
    text: text.slice(0, 400),
  };
}

function asList(p) {
  if (Array.isArray(p)) return p;
  if (Array.isArray(p?.items)) return p.items;
  if (Array.isArray(p?.organizations)) return p.organizations;
  if (Array.isArray(p?.data)) return p.data;
  return [];
}

async function main() {
  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  let token = login.data?.accessToken;
  if (!token && login.data?.identityToken) {
    const listed = await api('GET', '/auth/organizations', {
      token: login.data.identityToken,
    });
    const orgs = asList(listed.data);
    const tenantId = orgs[0]?.tenantId;
    const sel = await api('POST', '/auth/select-organization', {
      token: login.data.identityToken,
      body: { tenantId },
    });
    token = sel.data?.accessToken;
  }
  if (!token) {
    console.error('No shop token', login.text);
    process.exit(1);
  }
  console.log('SHOP  logged in');

  const cfg = await api('POST', '/tenants/me/business-config', {
    token,
    body: { businessType: 'salon', applyDefaultModes: true },
  });
  console.log(
    cfg.ok ? 'PASS' : 'PARTIAL',
    'salon profile',
    cfg.ok ? '' : `${cfg.status} ${cfg.text}`,
  );

  const modes = await api('POST', '/tenants/me/commerce-modes', {
    token,
    body: { modes: ['sale', 'service'] },
  });
  console.log(
    modes.ok ? 'PASS' : 'PARTIAL',
    'commerce modes',
    modes.ok ? '' : `${modes.status}`,
  );

  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  const customers = await api('GET', '/customers?limit=20', { token });
  const cust = asList(customers.data)[0];
  const cat = await api(
    'GET',
    `/pos/sale/catalog?locationId=${loc.id}&limit=50`,
    { token },
  );
  const items = asList(cat.data?.items ?? cat.data);
  const haircut = items.find((i) => /haircut/i.test(i.title || i.name || ''));
  const shampoo = items.find((i) => /shampoo/i.test(i.title || i.name || ''));
  console.log('CATALOG', items.map((i) => i.title || i.name).filter(Boolean).join(', '));

  const starts = new Date(Date.now() + 3600e3).toISOString();
  const ends = new Date(Date.now() + 7200e3).toISOString();
  const appt = await api('POST', '/appointments', {
    token,
    body: {
      locationId: loc.id,
      storeId: loc.id,
      customerId: cust?.id,
      type: 'consultation',
      aptType: 'consultation',
      startsAt: starts,
      endsAt: ends,
      notes: 'Haircut booking',
    },
  });
  console.log(
    appt.ok ? 'PASS' : 'FAIL',
    'appointment',
    appt.ok ? appt.data?.id : `${appt.status} ${appt.text}`,
  );

  const cur = await api(
    'GET',
    `/pos/sale/register/current?locationId=${loc.id}`,
    { token },
  );
  if (!(cur.data?.session?.id || cur.data?.id)) {
    await api('POST', '/pos/sale/register/open', {
      token,
      body: { locationId: loc.id, openingFloat: 1500 },
    });
  }

  const stock = (row) =>
    row?.stockLevelId || row?.stockLevel?.id || row?.id;
  const rough = 2000;
  const body = {
    locationId: loc.id,
    customerId: cust?.id,
    note: 'Haircut + shampoo',
    items: [
      { stockLevelId: stock(haircut), quantity: 1, unitPrice: 799 },
      { stockLevelId: stock(shampoo), quantity: 1, unitPrice: 450 },
    ],
    payments: [
      {
        method: 'cash',
        amount: rough,
        idempotencyKey: `salon-prod-${Date.now()}`,
      },
    ],
    cashTendered: rough + 50,
  };
  let sale = await api('POST', '/pos/sale/checkout', { token, body });
  if (!sale.ok) {
    const m = String(sale.data?.message || sale.text || '').match(/(\d+(\.\d+)?)/);
    if (m) {
      body.payments[0].amount = Number(m[1]);
      body.cashTendered = Number(m[1]) + 20;
      body.payments[0].idempotencyKey += '-r';
      sale = await api('POST', '/pos/sale/checkout', { token, body });
    }
  }
  console.log(
    sale.ok ? 'PASS' : 'FAIL',
    'haircut+shampoo bill',
    sale.ok ? sale.data?.order?.id : `${sale.status} ${sale.text}`,
  );

  console.log('\nLOGIN http://13.126.105.138:3000/login');
  console.log('Email   ', EMAIL);
  console.log('Password', PASSWORD);
  console.log('Shop    Glow Studio Salon');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
