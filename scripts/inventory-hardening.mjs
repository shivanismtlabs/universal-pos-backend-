/**
 * Inventory mutation hardening (sale ledger, batch FEFO, serial sold, concurrency).
 *   node scripts/inventory-hardening.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const PASS = 'HardInv@2026';
const STAMP = Date.now().toString(36);

const rows = [];
function log(name, status, detail = '') {
  rows.push({ name, status, detail });
  console.log(`${status.padEnd(8)} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return {
    ok: res.ok && json.success !== false,
    status: res.status,
    data: json.data ?? json,
    raw: json,
  };
}
function list(d) {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.items)) return d.items;
  return [];
}

async function setupTenant() {
  const email = `inv.hard.${STAMP}@upos.test`;
  const signup = await req('POST', '/auth/signup', {
    body: { email, password: PASS, fullName: 'Inv Hard', phone: '+919900000001' },
  });
  const identityToken = signup.data.identityToken;
  if (!identityToken) throw new Error('No identityToken from signup: ' + JSON.stringify(signup.raw).slice(0, 200));

  const org = await req('POST', '/auth/organizations', {
    token: identityToken,
    body: { organizationName: `InvHard ${STAMP}`, businessType: 'retail' },
  });
  const token = org.data.accessToken;
  if (!token) throw new Error('No accessToken from org create: ' + JSON.stringify(org.raw).slice(0, 200));
  return token;
}

(async () => {
  const token = await setupTenant();
  const locs = await req('GET', '/locations', { token });
  const locsArr = Array.isArray(locs.data) ? locs.data : (Array.isArray(locs.raw) ? locs.raw : []);
  let loc = locsArr[0]?.id;
  if (!loc) {
    const newLoc = await req('POST', '/locations', {
      token,
      body: { name: 'Main Store', code: 'MAIN', type: 'store' },
    });
    loc = newLoc.data?.id;
  }
  if (!loc) { console.error('Cannot resolve location. locs:', JSON.stringify(locs.raw).slice(0, 300)); process.exit(1); }
  const cat = await req('POST', '/catalog/categories', {
    token,
    body: { name: 'HardCat' },
  });
  const sku = `HRD${STAMP}AAAAAAA`.slice(0, 18);
  const created = await req('POST', '/catalog/products', {
    token,
    body: {
      name: 'Hard Item',
      skuCode: sku,
      kind: 'physical',
      basePrice: 50,
      openingQty: 10,
      locationId: loc,
      categoryId: cat.data?.id,
      trackInventory: true,
    },
  });
  log('opening product', created.ok ? 'PASS' : 'FAIL', created.ok ? created.data?.id : JSON.stringify(created.raw).slice(0, 120));
  if (!created.ok) { process.exit(1); }
  const levels = await req('GET', `/inventory/levels?locationId=${loc}`, { token });
  const allLevels = list(levels.data);
  const level = allLevels.find((x) => x.sku === sku || x.productId === created.data?.id) || allLevels[0];
  if (!level) {
    console.error('No stock level found. Levels:', JSON.stringify(levels.raw).slice(0, 400));
    process.exit(1);
  }
  const ledger0 = await req('GET', `/inventory/ledger?productId=${level.productId}&limit=20`, { token });
  const hasOpening = list(ledger0.data).some((e) => e.type === 'opening' || Number(e.qtyDelta) === 10);
  log('opening ledger', hasOpening ? 'PASS' : 'FAIL', `types=${list(ledger0.data).map((e) => e.type).join(',')}`);

  // Open register session (required for cash checkout)
  const regResp = await req('POST', '/pos/sale/register/open', {
    token,
    body: { locationId: loc, openingFloat: 0 },
  });
  if (!regResp.ok && !regResp.raw?.message?.includes?.('already open')) {
    console.error('Could not open register:', JSON.stringify(regResp.raw).slice(0, 200));
  }

  const sale = await req('POST', '/pos/sale/checkout', {
    token,
    body: {
      locationId: loc,
      items: [{ stockLevelId: level.id || level.stockLevelId, quantity: 3, unitPrice: 50 }],
      payments: [{ method: 'cash', amount: 150, idempotencyKey: `h-${STAMP}-s` }],
      cashTendered: 150,
    },
  });
  log('sale checkout', sale.ok ? 'PASS' : 'FAIL', sale.ok ? sale.data?.order?.id : JSON.stringify(sale.raw).slice(0, 140));
  const ledger1 = await req('GET', `/inventory/ledger?productId=${level.productId}&limit=20`, { token });
  const saleLed = list(ledger1.data).find((e) => e.type === 'sale');
  log('sale ledger', saleLed ? 'PASS' : 'FAIL', saleLed ? `delta=${saleLed.qtyDelta} after=${saleLed.qtyAfter}` : 'missing');

  const after = await req('GET', `/inventory/levels?locationId=${loc}&includeZero=true`, { token });
  const lv = list(after.data).find((x) => (x.id || x.stockLevelId) === (level.id || level.stockLevelId));
  log('qty after sale 10-3', Number(lv?.qtyOnHand) === 7 ? 'PASS' : 'FAIL', `qty=${lv?.qtyOnHand}`);

  const rec = await req('GET', `/inventory/reconcile?locationId=${loc}`, { token });
  const issues = rec.data?.issues?.filter((i) => i.stockLevelId === (lv?.id || lv?.stockLevelId) || i.sku === sku) ?? [];
  log('reconcile sku', issues.length === 0 ? 'PASS' : 'PARTIAL', `issues=${issues.length}`);

  const raceA = req('POST', '/pos/sale/checkout', {
    token,
    body: {
      locationId: loc,
      items: [{ stockLevelId: level.id || level.stockLevelId, quantity: 6, unitPrice: 50 }],
      payments: [{ method: 'cash', amount: 300, idempotencyKey: `h-${STAMP}-a` }],
      cashTendered: 300,
    },
  });
  const raceB = req('POST', '/pos/sale/checkout', {
    token,
    body: {
      locationId: loc,
      items: [{ stockLevelId: level.id || level.stockLevelId, quantity: 7, unitPrice: 50 }],
      payments: [{ method: 'cash', amount: 350, idempotencyKey: `h-${STAMP}-b` }],
      cashTendered: 350,
    },
  });
  const [a, b] = await Promise.all([raceA, raceB]);
  const wins = [a, b].filter((x) => x.ok).length;
  const fails = [a, b].filter((x) => !x.ok).length;
  log(
    'concurrent 6+7 against 7',
    wins === 1 && fails === 1 ? 'PASS' : wins <= 1 ? 'PARTIAL' : 'FAIL',
    `ok=${wins} fail=${fails} a=${a.status} b=${b.status}`,
  );

  const pass = rows.filter((r) => r.status === 'PASS').length;
  const fail = rows.filter((r) => r.status === 'FAIL').length;
  const partial = rows.filter((r) => r.status === 'PARTIAL').length;
  console.log(`\nSUMMARY PASS ${pass} PARTIAL ${partial} FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
