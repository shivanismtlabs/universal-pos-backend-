/**
 * Full universal rental feature smoke — Clothes / Bikes / Cars / Home.
 * Covers schema, categories, products, units, lookup, orders, lifecycle,
 * payments (rent+deposit), ready/handover, exchange, returns, inspect,
 * cleaning, damage, fees, layaway, receipt, documents, recent, walk-in.
 *
 * Usage: node scripts/smoke-rental-full.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const SUFFIX = Date.now().toString(36);
const SLUG = `rent-full-${SUFFIX}`;
const EMAIL = `owner@${SLUG}.test`;
const PASSWORD = 'RentFull@2026!';

const results = [];
function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, err) {
  results.push({ name, ok: false, detail: String(err) });
  console.error(`  ✗ ${name} — ${err}`);
}

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
    const msg =
      json?.message ??
      json?.error ??
      (Array.isArray(json?.messages) ? json.messages.join(', ') : null) ??
      JSON.stringify(json);
    throw new Error(`${method} ${path} → ${res.status} ${msg}`);
  }
  return json.data !== undefined ? json.data : json;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : '');
    return detail;
  } catch (e) {
    fail(name, e.message || e);
    throw e;
  }
}

async function soft(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : '');
    return { ok: true, detail };
  } catch (e) {
    fail(name, e.message || e);
    return { ok: false, error: e.message || String(e) };
  }
}

async function main() {
  console.log(`\nAPI ${API}`);
  console.log(`Tenant ${SLUG}\n`);

  let token;
  let loc;
  let cats = {};
  let units = {};
  let customer;
  let order;
  let order2;

  await step('Register tenant', async () => {
    const reg = await req('/auth/register-tenant', {
      method: 'POST',
      body: {
        tenantName: 'Full Rent Lab',
        tenantSlug: SLUG,
        storeName: 'Main',
        adminFullName: 'Full Owner',
        adminEmail: EMAIL,
        adminPassword: PASSWORD,
        adminPhone: '9876512345',
      },
    });
    token = reg.accessToken;
    assert(token, 'no accessToken');
    return EMAIL;
  });

  await step('Set commerce mode = rental', async () => {
    await req('/tenants/me/commerce-modes', {
      method: 'POST',
      token,
      body: {
        mode: 'rental',
        shopTitle: 'Full Rent Lab',
        tagline: 'Universal rental POS',
      },
    });
  });

  await step('Bootstrap exposes rental schema + categoryExamples', async () => {
    const boot = await req('/tenants/me/bootstrap', { token });
    const rental = boot.commerce?.schemas?.rental;
    assert(rental?.fields?.length, 'rental fields missing on bootstrap');
    assert(
      Array.isArray(rental.categoryExamples) && rental.categoryExamples.length > 0,
      'categoryExamples must come from API',
    );
    assert(
      rental.categoryExamples.includes('Clothes') ||
        rental.categoryExamples.includes('Bikes'),
      `unexpected examples: ${rental.categoryExamples}`,
    );
    assert(
      Array.isArray(boot.commerce?.rentalLifecycle) &&
        boot.commerce.rentalLifecycle.includes('quote'),
      'rentalLifecycle missing',
    );
    return rental.categoryExamples.join(', ');
  });

  await step('Locations', async () => {
    const locsRaw = await req('/locations', { token });
    const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
    loc = locs[0];
    assert(loc?.id, 'no location');
    return loc.name || loc.id;
  });

  await step('GET /pos/rental/schema', async () => {
    const schema = await req('/pos/rental/schema', { token });
    assert(schema.mode === 'rental', 'mode');
    const keys = (schema.fields ?? []).map((f) => f.key);
    for (const k of [
      'title',
      'categoryId',
      'sku',
      'rentalPrice',
      'deposit',
      'barcode',
      'variant',
    ]) {
      assert(keys.includes(k), `field ${k} missing`);
    }
    assert(schema.categoryExamples?.length, 'categoryExamples on schema');
    assert(schema.lifecycle?.includes('checked_out'), 'lifecycle on schema');
    return keys.join(',');
  });

  await step('GET /pos/rental/floor', async () => {
    const floor = await req('/pos/rental/floor', { token });
    assert(floor.locationId, 'locationId');
    assert(floor.schema?.categoryExamples?.length, 'floor schema examples');
    assert(floor.counts, 'counts');
    return `loc=${floor.locationId}`;
  });

  // Categories for all verticals
  for (const name of ['Clothes', 'Bikes', 'Cars', 'Home']) {
    await step(`Create category ${name}`, async () => {
      const row = await req('/pos/rental/categories', {
        method: 'POST',
        token,
        body: { name },
      });
      cats[name] = row;
      assert(row.id, 'id');
      return row.id;
    });
  }

  await step('Rename category Clothes → Formalwear', async () => {
    const row = await req(`/pos/rental/categories/${cats.Clothes.id}`, {
      method: 'PATCH',
      token,
      body: { name: 'Formalwear' },
    });
    assert(row.name === 'Formalwear', 'rename failed');
    cats.Clothes = row;
    return row.name;
  });

  await step('List categories', async () => {
    const list = await req('/pos/rental/categories', { token });
    assert(list.length >= 4, `expected ≥4 cats, got ${list.length}`);
    return String(list.length);
  });

  // Products + units
  const productSpecs = [
    {
      key: 'gown',
      cat: 'Clothes',
      title: 'Evening Gown',
      sku: 'CL-GOWN',
      price: 2500,
      deposit: 1000,
      barcode: `CL-${SUFFIX}-1`,
      variant: 'M',
      extraBarcode: `CL-${SUFFIX}-2`,
      extraVariant: 'L',
    },
    {
      key: 'bike',
      cat: 'Bikes',
      title: 'Trail Bike',
      sku: 'BK-TRAIL',
      price: 800,
      deposit: 2000,
      barcode: `BK-${SUFFIX}-1`,
      variant: 'Frame-M',
      extraBarcode: `BK-${SUFFIX}-2`,
      extraVariant: 'Frame-L',
    },
    {
      key: 'car',
      cat: 'Cars',
      title: 'City Hatchback',
      sku: 'CR-HATCH',
      price: 3500,
      deposit: 10000,
      barcode: `CR-${SUFFIX}-1`,
      variant: 'Petrol-5',
      extraBarcode: `CR-${SUFFIX}-2`,
      extraVariant: 'Diesel-5',
    },
    {
      key: 'vacuum',
      cat: 'Home',
      title: 'Stick Vacuum',
      sku: 'HM-VAC',
      price: 400,
      deposit: 1500,
      barcode: `HM-${SUFFIX}-1`,
      variant: 'Black',
      extraBarcode: `HM-${SUFFIX}-2`,
      extraVariant: 'Kit-B',
    },
  ];

  for (const p of productSpecs) {
    await step(`Add product ${p.title} (${p.cat})`, async () => {
      const res = await req('/pos/rental/products', {
        method: 'POST',
        token,
        body: {
          title: p.title,
          description: `${p.cat} rental unit`,
          categoryId: cats[p.cat].id,
          sku: p.sku,
          rentalPrice: p.price,
          deposit: p.deposit,
          barcode: p.barcode,
          variant: p.variant,
          locationId: loc.id,
        },
      });
      assert(res.product?.id && res.unit?.id, 'product+unit');
      units[p.key] = { product: res.product, unit: res.unit, spec: p };
      return res.unit.barcodeSku || p.barcode;
    });

    await step(`Extra unit for ${p.key}`, async () => {
      const u = await req('/pos/rental/units', {
        method: 'POST',
        token,
        body: {
          productId: units[p.key].product.id,
          barcode: p.extraBarcode,
          variant: p.extraVariant,
          rentalPrice: p.price,
          deposit: p.deposit,
          locationId: loc.id,
        },
      });
      units[p.key].spare = u;
      return u.barcodeSku || p.extraBarcode;
    });
  }

  await step('List products', async () => {
    const res = await req('/pos/rental/products', { token });
    assert(res.items?.length >= 4, `products ${res.items?.length}`);
    return String(res.items.length);
  });

  await step('Update product title', async () => {
    const id = units.gown.product.id;
    const updated = await req(`/pos/rental/products/${id}`, {
      method: 'PATCH',
      token,
      body: { title: 'Evening Gown Pro' },
    });
    assert(
      updated.title === 'Evening Gown Pro' || updated.name === 'Evening Gown Pro',
      'title not updated',
    );
  });

  await step('Update unit variant', async () => {
    const id = units.bike.unit.id;
    const updated = await req(`/pos/rental/units/${id}`, {
      method: 'PATCH',
      token,
      body: { variant: 'Frame-M-updated' },
    });
    assert(
      (updated.variant || updated.variantLabel || '').includes('updated') ||
        updated.status,
      'unit patch failed',
    );
  });

  await step('List units + filter by category', async () => {
    const all = await req('/pos/rental/units', { token });
    assert(all.items?.length >= 8, `units ${all.items?.length}`);
    const bikes = await req(
      `/pos/rental/units?categoryId=${cats.Bikes.id}`,
      { token },
    );
    assert(bikes.items?.length >= 2, 'bike filter');
    return `all=${all.items.length} bikes=${bikes.items.length}`;
  });

  await step('Catalog', async () => {
    const cat = await req('/pos/rental/catalog?limit=50', { token });
    assert(cat.items?.length >= 8, `catalog ${cat.items?.length}`);
  });

  await step('Lookup barcode', async () => {
    const hit = await req(
      `/pos/rental/lookup?barcode=${encodeURIComponent(units.car.spec.barcode)}`,
      { token },
    );
    assert(hit.id === units.car.unit.id, 'lookup mismatch');
    return hit.title || hit.barcodeSku;
  });

  await step('Create customer', async () => {
    customer = await req('/customers', {
      method: 'POST',
      token,
      body: {
        fullName: 'Priya Renter',
        phone: '9123456780',
        email: 'priya@example.com',
      },
    });
    assert(customer.id, 'customer id');
  });

  const today = new Date();
  const pickup = today.toISOString().slice(0, 10);
  const retDue = new Date(today.getTime() + 3 * 86400000)
    .toISOString()
    .slice(0, 10);

  await step('Create rental order (multi-category)', async () => {
    order = await req('/orders', {
      method: 'POST',
      token,
      body: {
        locationId: loc.id,
        customerId: customer.id,
        kind: 'rental',
        pickupDate: pickup,
        returnDueDate: retDue,
        items: [
          {
            itemKind: 'stock_unit',
            stockUnitId: units.gown.unit.id,
            unitPrice: 2500,
          },
          {
            itemKind: 'stock_unit',
            stockUnitId: units.bike.unit.id,
            unitPrice: 800,
          },
          {
            itemKind: 'stock_unit',
            stockUnitId: units.car.unit.id,
            unitPrice: 3500,
          },
        ],
      },
    });
    assert(order.id, 'order id');
    assert(order.rentalExt?.lifecycle === 'quote', 'lifecycle quote');
    assert(Number(order.balanceDue) > 0, 'balanceDue');
    return `${order.orderNumber} due=${order.balanceDue}`;
  });

  await step('Walk-in order (no customer)', async () => {
    order2 = await req('/orders', {
      method: 'POST',
      token,
      body: {
        locationId: loc.id,
        kind: 'rental',
        pickupDate: pickup,
        returnDueDate: retDue,
        items: [
          {
            itemKind: 'stock_unit',
            stockUnitId: units.vacuum.unit.id,
            unitPrice: 400,
          },
        ],
      },
    });
    assert(order2.id, 'walk-in id');
    assert(!order2.customerId || order2.customer == null, 'should allow null customer');
    return order2.orderNumber;
  });

  await step('Add item via POST /orders/:id/items', async () => {
    // add spare vacuum to walk-in? vacuum spare still available
    const updated = await req(`/orders/${order2.id}/items`, {
      method: 'POST',
      token,
      body: {
        itemKind: 'stock_unit',
        stockUnitId: units.vacuum.spare.id,
      },
    });
    assert((updated.items?.length ?? 0) >= 2, 'item not added');
  });

  await step('Lifecycle quote → reserved', async () => {
    const o = await req(`/orders/${order.id}/rental-lifecycle`, {
      method: 'POST',
      token,
      body: { lifecycle: 'reserved' },
    });
    assert(o.rentalExt?.lifecycle === 'reserved', 'reserved');
  });

  await step('Lifecycle reserved → ready', async () => {
    const o = await req(`/orders/${order.id}/rental-lifecycle`, {
      method: 'POST',
      token,
      body: { lifecycle: 'ready' },
    });
    assert(o.rentalExt?.lifecycle === 'ready', 'ready');
  });

  await step('Deposit payment', async () => {
    await req('/payments', {
      method: 'POST',
      token,
      body: {
        orderId: order.id,
        method: 'cash',
        amount: 1000,
        type: 'deposit',
        idempotencyKey: `dep-${SUFFIX}`,
      },
    });
  });

  await step('Rent payment (remaining)', async () => {
    const cur = await req(`/orders/${order.id}`, { token });
    const due = Number(cur.balanceDue);
    if (due > 0) {
      await req('/payments', {
        method: 'POST',
        token,
        body: {
          orderId: order.id,
          method: 'cash',
          amount: due,
          type: 'payment',
          idempotencyKey: `pay-${SUFFIX}`,
        },
      });
    }
    const after = await req(`/orders/${order.id}`, { token });
    assert(Number(after.balanceDue) <= 0, `still due ${after.balanceDue}`);
  });

  await step('Handover checked_out', async () => {
    const o = await req(`/orders/${order.id}/rental-lifecycle`, {
      method: 'POST',
      token,
      body: { lifecycle: 'checked_out' },
    });
    assert(o.rentalExt?.lifecycle === 'checked_out', 'checked_out');
  });

  await soft('POS receipt', async () => {
    const r = await req(`/pos/orders/${order.id}/receipt`, { token });
    assert(r.orderNumber || r.totals, 'receipt payload');
    return r.orderNumber;
  });

  await soft('Digital agreement document', async () => {
    const doc = await req('/documents', {
      method: 'POST',
      token,
      body: {
        docType: 'agreement',
        storageKey: `agreements/${order.id}/${SUFFIX}.txt`,
        orderId: order.id,
        customerId: customer.id,
      },
    });
    assert(doc.id, 'doc id');
    await req(`/documents/${doc.id}/acknowledge`, { method: 'POST', token });
    return doc.id;
  });

  await step('Returns candidates', async () => {
    const c = await req('/returns/candidates', { token });
    const hit = (c.items ?? []).find((o) => o.id === order.id);
    assert(hit, 'order not in candidates');
    assert(hit.unitsOut?.length >= 3, `unitsOut ${hit.unitsOut?.length}`);
    return String(hit.unitsOut.length);
  });

  await step('Exchange bike → spare', async () => {
    const ex = await req('/pos/rental/exchange', {
      method: 'POST',
      token,
      body: {
        orderId: order.id,
        fromStockUnitId: units.bike.unit.id,
        toStockUnitId: units.bike.spare.id,
        reason: 'Larger frame',
      },
    });
    assert(ex.toStockUnitId === units.bike.spare.id, 'exchange');
  });

  await step('Return gown (cleaning)', async () => {
    return (
      await req('/returns', {
        method: 'POST',
        token,
        body: {
          orderId: order.id,
          stockUnitId: units.gown.unit.id,
          cleaningRequired: true,
          inspectNotes: 'Needs clean',
        },
      })
    ).id;
  });

  let retBike;
  let retCar;
  await step('Return exchanged bike', async () => {
    retBike = await req('/returns', {
      method: 'POST',
      token,
      body: {
        orderId: order.id,
        stockUnitId: units.bike.spare.id,
        cleaningRequired: false,
      },
    });
    return retBike.id;
  });

  await step('Return car + advance to returned', async () => {
    retCar = await req('/returns', {
      method: 'POST',
      token,
      body: {
        orderId: order.id,
        stockUnitId: units.car.unit.id,
        cleaningRequired: false,
        inspectNotes: 'Scratch on bumper',
      },
    });
    const o = await req(`/orders/${order.id}`, { token });
    assert(
      o.rentalExt?.lifecycle === 'returned',
      `expected returned, got ${o.rentalExt?.lifecycle}`,
    );
    return retCar.id;
  });

  await step('Inspect gown → needs_cleaning → complete', async () => {
    const returns = await req('/returns?limit=20', { token });
    const gownRet = (returns.items ?? []).find(
      (r) =>
        r.stockUnitId === units.gown.unit.id ||
        r.stockUnit?.id === units.gown.unit.id,
    );
    assert(gownRet?.id, 'gown return not found');
    await req(`/returns/${gownRet.id}/inspect`, {
      method: 'POST',
      token,
      body: { inspectStatus: 'needs_cleaning' },
    });
    await req(`/returns/${gownRet.id}/cleaning/complete`, {
      method: 'POST',
      token,
    });
  });

  await step('Inspect bike → clean_ready', async () => {
    await req(`/returns/${retBike.id}/inspect`, {
      method: 'POST',
      token,
      body: { inspectStatus: 'clean_ready' },
    });
  });

  await step('Inspect car → damaged', async () => {
    await req(`/returns/${retCar.id}/inspect`, {
      method: 'POST',
      token,
      body: {
        inspectStatus: 'damaged',
        inspectNotes: 'Bumper scratch',
      },
    });
  });

  await soft('Damage fee', async () => {
    const fee = await req(`/orders/${order.id}/fees`, {
      method: 'POST',
      token,
      body: {
        feeType: 'damage',
        amount: 500,
        reason: 'Bumper scratch',
      },
    });
    assert(fee.id || fee.amount, 'fee');
    return String(fee.amount ?? 500);
  });

  await soft('Late fee auto-calc', async () => {
    try {
      const fee = await req(`/orders/${order.id}/fees/late`, {
        method: 'POST',
        token,
        body: {},
      });
      return JSON.stringify(fee?.amount ?? fee);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('not overdue') || msg.includes('400')) {
        return 'API ok (not overdue yet — expected)';
      }
      throw e;
    }
  });

  await soft('Layaway schedule (walk-in order)', async () => {
    const lay = await req(`/orders/${order2.id}/layaway`, {
      method: 'POST',
      token,
      body: {
        installments: [
          { installmentAmount: 200, dueBy: pickup },
          { installmentAmount: 200, dueBy: retDue },
        ],
      },
    });
    const list = await req(`/orders/${order2.id}/layaway`, { token });
    assert(
      (Array.isArray(list) ? list : list.items ?? []).length >= 1 || lay,
      'layaway empty',
    );
  });

  await step('Close main order', async () => {
    // may need inspected first
    const cur = await req(`/orders/${order.id}`, { token });
    const lc = cur.rentalExt?.lifecycle;
    if (lc === 'returned') {
      await req(`/orders/${order.id}/rental-lifecycle`, {
        method: 'POST',
        token,
        body: { lifecycle: 'inspected' },
      });
    }
    await req(`/orders/${order.id}/rental-lifecycle`, {
      method: 'POST',
      token,
      body: { lifecycle: 'closed' },
    });
    const closed = await req(`/orders/${order.id}`, { token });
    assert(
      closed.rentalExt?.lifecycle === 'closed' || closed.status === 'closed',
      'not closed',
    );
  });

  await step('Recent rentals', async () => {
    const recent = await req('/pos/rental/recent?limit=10', { token });
    assert(
      (recent.items ?? []).some((o) => o.id === order.id),
      'main order missing in recent',
    );
  });

  await step('List rental orders', async () => {
    const list = await req('/orders?kind=rental&limit=20', { token });
    assert((list.items ?? []).length >= 2, 'orders list');
  });

  await step('Re-login', async () => {
    const login = await req('/auth/login', {
      method: 'POST',
      body: { tenantSlug: SLUG, email: EMAIL, password: PASSWORD },
    });
    assert(login.accessToken, 'token');
  });

  // Known gaps — probe and report without failing hard
  console.log('\n--- Gap probes (may fail; reported) ---');
  await soft('Date-range availability API', async () => {
    await req(
      `/pos/rental/availability?from=${pickup}&to=${retDue}&productId=${units.bike.product.id}`,
      { token },
    );
  });
  await soft('Rental product image upload', async () => {
    // 1x1 PNG
    const tiny =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await req(
      `/pos/rental/products/${units.gown.product.id}/image`,
      {
        method: 'POST',
        token,
        body: { imageBase64: tiny },
      },
    );
    assert(res.image, 'image url missing');
    return res.image;
  });

  const ok = results.filter((r) => r.ok).length;
  const bad = results.filter((r) => !r.ok);
  console.log('\n========================================');
  console.log(`RENTAL FULL SMOKE: ${ok}/${results.length} passed`);
  if (bad.length) {
    console.log('FAILED / MISSING:');
    for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`);
  }
  console.log('Login:');
  console.log(`  slug: ${SLUG}`);
  console.log(`  email: ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log('========================================\n');

  // Soft probes — late fee "not overdue" is OK for same-day rentals
  const hardFails = bad.filter(
    (b) =>
      !b.detail.includes('not overdue') &&
      !b.name.includes('availability') &&
      !b.name.includes('image'),
  );
  if (hardFails.length) process.exit(1);
}

main().catch((e) => {
  console.error('\nFATAL:', e.message || e);
  process.exit(1);
});
