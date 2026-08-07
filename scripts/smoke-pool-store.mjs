/**
 * Phase 5 smoke — The Pool Store retail sale on universal APIs.
 * Usage: node scripts/smoke-pool-store.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json.data ?? json;
}

async function main() {
  const login = await req('/auth/login', {
    method: 'POST',
    body: {
      tenantSlug: 'pool-store',
      email: 'owner@pool.demo',
      password: 'WalitShop@2026',
    },
  });
  const token = login.accessToken;
  console.log('login ok', login.user?.email);

  const boot = await req('/tenants/me/bootstrap', { token });
  const rentalOn = boot.modules?.some(
    (m) => m.code === 'rental' && m.status === 'enabled',
  );
  console.log('currency', boot.tenant?.currencyCode, 'rentalEnabled', !!rentalOn);
  if (rentalOn) throw new Error('rental should be OFF for pool-store');

  const locsRaw = await req('/locations', { token });
  const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
  const loc = locs.find((l) => l.code === 'MAIN') ?? locs[0];
  if (!loc) throw new Error('no location');
  const customers = await req('/customers?limit=5', { token });
  const customer = customers.items?.[0];
  if (!customer) throw new Error('no customer');
  const skus = await req('/retail-skus?limit=5', { token });
  const items = skus.items ?? skus;
  const sku = items[0];
  if (!sku) throw new Error('no sku');
  console.log('sku', sku.sku, 'qty', sku.qtyOnHand, 'price', sku.sellPrice);

  const order = await req('/orders', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      customerId: customer.id,
      kind: 'sale',
      items: [
        {
          itemType: 'retail',
          retailSkuId: sku.id,
          quantity: 1,
        },
      ],
    },
  });
  console.log('order', order.orderNumber, 'balance', order.balanceDue);

  await req('/payments', {
    method: 'POST',
    token,
    body: {
      orderId: order.id,
      method: 'cash',
      amount: Number(order.balanceDue),
      idempotencyKey: `pool-smoke-${Date.now()}`,
    },
  });

  await req(`/orders/${order.id}/status`, {
    method: 'POST',
    token,
    body: { status: 'quoted' },
  });
  await req(`/orders/${order.id}/status`, {
    method: 'POST',
    token,
    body: { status: 'confirmed' },
  });
  await req(`/orders/${order.id}/status`, {
    method: 'POST',
    token,
    body: { status: 'ready' },
  });

  const receipt = await req(`/pos/orders/${order.id}/receipt`, { token });
  console.log(
    'receipt',
    receipt.orderNumber,
    'balance',
    receipt.totals?.balanceDue,
  );

  const skusAfter = await req('/retail-skus?limit=5', { token });
  const after = (skusAfter.items ?? skusAfter).find((s) => s.id === sku.id);
  console.log('qty after', after?.qtyOnHand, '(expect', sku.qtyOnHand - 1, ')');
  console.log('PHASE5 POOL-STORE SMOKE PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
