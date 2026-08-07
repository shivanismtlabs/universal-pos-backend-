/**
 * Phase 6 smoke — formal rental happy path on universal APIs.
 * Usage: node scripts/smoke-rental.mjs
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
      tenantSlug: 'demo-shop',
      email: 'owner@demo.shop',
      password: 'WalitShop@2026',
    },
  });
  const token = login.accessToken;
  console.log('login ok', login.user?.email);

  const boot = await req('/tenants/me/bootstrap', { token });
  const rental = boot.modules?.find((m) => m.code === 'rental');
  if (rental?.status !== 'enabled') {
    throw new Error(`rental should be enabled, got ${rental?.status}`);
  }
  console.log('rental enabled', boot.tenant?.branding?.productName);

  const locsRaw = await req('/locations', { token });
  const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
  const loc = locs.find((l) => l.code === 'MAIN') ?? locs[0];

  const customers = await req('/customers?limit=10', { token });
  const groom = (customers.items ?? []).find((c) =>
    String(c.fullName).includes('Arjun'),
  );
  if (!groom) throw new Error('groom customer missing — reseed');

  const parties = await req('/parties', { token });
  const partyList = Array.isArray(parties) ? parties : parties.items ?? [];
  const party = partyList[0];
  if (!party) throw new Error('party missing — reseed');

  const units = await req('/inventory-units?limit=20', { token });
  const unitItems = units.items ?? units;
  const jacket = unitItems.find((u) => String(u.barcodeSku).startsWith('JKT-BLK'));
  if (!jacket) throw new Error('no jacket unit — reseed');
  console.log('unit', jacket.barcodeSku, 'status', jacket.status);

  const order = await req('/orders', {
    method: 'POST',
    token,
    body: {
      locationId: loc.id,
      customerId: groom.id,
      kind: 'rental',
      partyId: party.id,
      eventDate: '2026-12-15',
      pickupDate: '2026-12-14',
      returnDueDate: '2026-12-16',
      items: [
        {
          itemType: 'rental_unit',
          inventoryUnitId: jacket.id,
        },
      ],
    },
  });
  console.log(
    'order',
    order.orderNumber,
    'lifecycle',
    order.rentalExt?.lifecycle,
    'balance',
    order.balanceDue,
  );

  const reserved = await req(`/orders/${order.id}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'reserved' },
  });
  console.log(
    'reserved →',
    reserved.rentalExt?.lifecycle,
    'core',
    reserved.status,
  );

  const unitAfterReserve = await req(`/inventory-units/${jacket.id}`, {
    token,
  });
  if (unitAfterReserve.status !== 'reserved') {
    throw new Error(`expected reserved, got ${unitAfterReserve.status}`);
  }

  await req('/payments', {
    method: 'POST',
    token,
    body: {
      orderId: order.id,
      method: 'cash',
      amount: Number(order.balanceDue),
      idempotencyKey: `rental-smoke-${Date.now()}`,
    },
  });

  const checkedOut = await req(`/orders/${order.id}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'checked_out' },
  });
  console.log(
    'checked_out →',
    checkedOut.rentalExt?.lifecycle,
    'core',
    checkedOut.status,
  );

  const unitOut = await req(`/inventory-units/${jacket.id}`, { token });
  if (unitOut.status !== 'checked_out') {
    throw new Error(`expected checked_out, got ${unitOut.status}`);
  }

  const ret = await req('/returns', {
    method: 'POST',
    token,
    body: {
      orderId: order.id,
      inventoryUnitId: jacket.id,
      cleaningRequired: true,
      inspectNotes: 'Light soil on cuff',
    },
  });
  console.log('return', ret.id);

  const afterReturn = await req(`/orders/${order.id}`, { token });
  console.log('lifecycle after return', afterReturn.rentalExt?.lifecycle);

  await req(`/returns/${ret.id}/inspect`, {
    method: 'POST',
    token,
    body: { inspectStatus: 'needs_cleaning', inspectNotes: 'Send to clean' },
  });

  const inspected = await req(`/orders/${order.id}`, { token });
  console.log('lifecycle after inspect', inspected.rentalExt?.lifecycle);

  await req(`/returns/${ret.id}/cleaning/complete`, {
    method: 'POST',
    token,
  });

  const unitDone = await req(`/inventory-units/${jacket.id}`, { token });
  console.log('unit after clean', unitDone.status);
  if (unitDone.status !== 'available') {
    throw new Error(`expected available after clean, got ${unitDone.status}`);
  }

  await req(`/orders/${order.id}/rental-lifecycle`, {
    method: 'POST',
    token,
    body: { lifecycle: 'closed' },
  });

  const closed = await req(`/orders/${order.id}`, { token });
  console.log(
    'closed →',
    closed.rentalExt?.lifecycle,
    'core',
    closed.status,
  );

  console.log('PHASE6 RENTAL SMOKE PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
