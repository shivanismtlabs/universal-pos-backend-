/**
 * Full Sale smoke for The Pool Store (universal retail APIs only).
 * Mirrors multi-category pool/spa retail + owner/manager/cashier roles.
 * Usage: node scripts/smoke-pool-retail-full.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const PWD = 'WalitShop@2026';

async function req(path, { method = 'GET', token, body, expectStatus } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (expectStatus != null) {
    if (res.status !== expectStatus) {
      throw new Error(
        `${method} ${path} expected ${expectStatus} got ${res.status} ${JSON.stringify(json)}`,
      );
    }
    return json.data ?? json;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json.data ?? json;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function login(email) {
  const data = await req('/auth/login', {
    method: 'POST',
    body: { tenantSlug: 'pool-store', email, password: PWD },
  });
  return { token: data.accessToken, user: data.user };
}

async function main() {
  const stamp = Date.now().toString(36).slice(-6);
  const results = [];
  const pass = (name) => {
    results.push(name);
    console.log('PASS', name);
  };

  const owner = await login('owner@pool.demo');
  const boot = await req('/tenants/me/bootstrap', { token: owner.token });
  assert(boot.tenant?.slug === 'pool-store', 'tenant');
  const modes = boot.tenant?.settings?.commerceModes
    ?? boot.commerce?.modes
    ?? [];
  assert(
    modes.includes('sale') && modes.includes('rental'),
    'universal shop must have sale+rental',
  );
  assert(boot.commerce?.setupComplete !== false, 'setup complete');
  pass('universal sale+rental (no choose lock)');

  const locsRaw = await req('/locations', { token: owner.token });
  const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
  const loc = locs[0];
  assert(loc?.id, 'location');

  const cats = await req('/pos/sale/categories', { token: owner.token });
  const catList = Array.isArray(cats) ? cats : cats.items ?? [];
  assert(catList.length >= 6, `categories got ${catList.length}`);
  pass(`browse categories (${catList.length})`);

  const catalog = await req(
    `/pos/sale/catalog?locationId=${loc.id}&limit=100`,
    { token: owner.token },
  );
  const lines = catalog.items ?? catalog ?? [];
  assert(lines.length >= 15, `catalog got ${lines.length}`);
  pass(`sale catalog (${lines.length})`);

  const byName = (re) =>
    lines.find((l) => re.test(l.name ?? l.product?.name ?? ''));
  const picks = [
    byName(/chlorine|shock|dichlor/i),
    byName(/brush|skimmer|pole/i),
    byName(/float|noodle|grill|fire/i),
    byName(/pump|filter|salt|heater|light/i),
  ].filter(Boolean);
  assert(picks.length >= 3, 'multi-category picks');

  // Register
  let session = await req('/pos/sale/register/open', {
    method: 'POST',
    token: owner.token,
    body: { locationId: loc.id, openingFloat: 150 },
  }).catch(async () => {
    const cur = await req(
      `/pos/sale/register/current?locationId=${loc.id}`,
      { token: owner.token },
    );
    return cur.session ?? cur;
  });
  assert(session?.id, 'register session');
  pass('register open');

  // Customer (intl phone; unique per run)
  const phoneSuffix = String(Date.now()).slice(-7);
  const customer = await req('/customers', {
    method: 'POST',
    token: owner.token,
    body: {
      fullName: `Pool Guest ${stamp}`,
      phone: `+1229${phoneSuffix}`,
      email: `guest.${stamp}@pool.demo`,
    },
  });
  pass('customer create');

  const items = picks.map((l) => ({
    stockLevelId: l.id,
    quantity: 1,
    unitPrice: Number(l.sellPrice ?? l.unitPrice ?? l.basePrice),
  }));
  const merchandise = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const discount = Math.min(5, merchandise * 0.05);
  // Quote via checkout with generous cash; server calc tax
  const sale = await req('/pos/sale/checkout', {
    method: 'POST',
    token: owner.token,
    body: {
      locationId: loc.id,
      customerId: customer.id,
      items,
      discountAmount: discount,
      payments: [
        {
          method: 'cash',
          amount: merchandise + 100,
          idempotencyKey: `pool-sale-${stamp}`,
        },
      ],
      cashTendered: merchandise + 100,
      note: 'Multi-category pool retail basket',
    },
  });
  assert(sale.order?.id, 'sale order');
  pass(`multi-category checkout ${sale.order.orderNumber}`);

  // Park / resume / discard
  const parked = await req('/pos/sale/park', {
    method: 'POST',
    token: owner.token,
    body: {
      locationId: loc.id,
      items: [items[0]],
      label: 'Hold for pickup',
    },
  });
  assert(parked.id, 'park');
  const resumed = await req(`/pos/sale/parked/${parked.id}/resume`, {
    method: 'POST',
    token: owner.token,
  });
  assert(resumed.cart?.length >= 1, 'resume');
  await req(`/pos/sale/parked/${parked.id}/discard`, {
    method: 'POST',
    token: owner.token,
  });
  pass('park resume discard');

  // Universal product add (Sale keys)
  const prod = await req('/pos/sale/products', {
    method: 'POST',
    token: owner.token,
    body: {
      title: `Universal SKU ${stamp}`,
      sku: `UNI-${stamp}`,
      categoryId: catList[0].id,
      price: 12.5,
      qty: 20,
      locationId: loc.id,
      description: 'Any retail SKU — not vertical-specific',
    },
  });
  assert(prod.product?.id || prod.posItem?.id || prod.id, 'product');
  pass('universal sale product create');

  // Staff
  const cashierEmail = `cashier.${stamp}@pool.demo`;
  const managerEmail = `manager.${stamp}@pool.demo`;
  await req('/users', {
    method: 'POST',
    token: owner.token,
    body: {
      email: cashierEmail,
      fullName: 'Pool Cashier',
      phone: '+12295550111',
      password: PWD,
      roleCode: 'cashier',
    },
  });
  await req('/users', {
    method: 'POST',
    token: owner.token,
    body: {
      email: managerEmail,
      fullName: 'Pool Manager',
      phone: '+12295550112',
      password: PWD,
      roleCode: 'manager',
    },
  });
  pass('owner invites cashier + manager');

  // Cashier charge
  const cashier = await login(cashierEmail);
  const cCat = await req(
    `/pos/sale/catalog?locationId=${loc.id}&limit=10`,
    { token: cashier.token },
  );
  const cLine = (cCat.items ?? cCat)[0];
  const price = Number(cLine.sellPrice);
  const cSale = await req('/pos/sale/checkout', {
    method: 'POST',
    token: cashier.token,
    body: {
      locationId: loc.id,
      items: [{ stockLevelId: cLine.id, quantity: 1, unitPrice: price }],
      payments: [
        {
          method: 'cash',
          amount: price + 50,
          idempotencyKey: `cash-${stamp}`,
        },
      ],
      cashTendered: price + 50,
    },
  });
  assert(cSale.order?.id, 'cashier sale');
  pass('cashier can checkout');

  await req('/users', {
    method: 'POST',
    token: cashier.token,
    body: {
      email: `nope.${stamp}@pool.demo`,
      fullName: 'Nope',
      phone: '+12295550999',
      password: PWD,
      roleCode: 'cashier',
    },
    expectStatus: 403,
  });
  pass('cashier denied staff create');

  // Manager hire cashier, cannot grant admin
  const manager = await login(managerEmail);
  await req('/users', {
    method: 'POST',
    token: manager.token,
    body: {
      email: `hire.${stamp}@pool.demo`,
      fullName: 'Mgr Hire',
      phone: '+12295550113',
      password: PWD,
      roleCode: 'cashier',
    },
  });
  pass('manager can hire cashier');

  const adminAttempt = await fetch(`${API}/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${manager.token}`,
    },
    body: JSON.stringify({
      email: `badadmin.${stamp}@pool.demo`,
      fullName: 'Bad Admin',
      phone: '+12295550114',
      password: PWD,
      roleCode: 'admin',
    }),
  });
  assert([400, 403].includes(adminAttempt.status), 'manager cannot grant admin');
  pass('manager cannot grant admin');

  // Manager return on owner sale
  const retItem = items[0];
  const ret = await req('/pos/sale/returns', {
    method: 'POST',
    token: manager.token,
    body: {
      orderId: sale.order.id,
      items: [{ stockLevelId: retItem.stockLevelId, quantity: 1 }],
      refundMethod: 'cash',
      reason: 'Customer changed mind',
      idempotencyKey: `ret-${stamp}`,
    },
  });
  assert(ret.refundPaymentId || ret.amount != null, 'return');
  pass('manager sale return');

  // Cashier denied return
  await req('/pos/sale/returns', {
    method: 'POST',
    token: cashier.token,
    body: {
      orderId: cSale.order.id,
      items: [{ stockLevelId: cLine.id, quantity: 1 }],
      refundMethod: 'cash',
      reason: 'Cashier attempt',
      idempotencyKey: `badret-${stamp}`,
    },
    expectStatus: 403,
  });
  pass('cashier denied return');

  // Close register (owner)
  const closed = await req(`/pos/sale/register/${session.id}/close`, {
    method: 'POST',
    token: owner.token,
    body: { closingCash: 500, note: 'EOD pool smoke' },
  });
  assert(closed.closedAt || closed.zReport, 'register close');
  pass('register close / Z');

  console.log('\n=== Pool retail full smoke PASS ===');
  console.log(
    JSON.stringify(
      {
        reference: 'https://thepoolstore.net/',
        tenant: 'pool-store',
        owner: 'owner@pool.demo',
        password: PWD,
        cashier: cashierEmail,
        manager: managerEmail,
        checks: results.length,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error('FAIL', e.message || e);
  process.exit(1);
});
