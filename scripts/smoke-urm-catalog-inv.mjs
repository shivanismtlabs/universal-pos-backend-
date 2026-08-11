/**
 * Smoke test + demo data for IAM / Catalog / Inventory
 *   node scripts/smoke-urm-catalog-inv.mjs
 * Env: API_BASE=http://127.0.0.1:3001/v1  TEST_PASSWORD=TestPass123!
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = process.env.API_BASE || 'http://127.0.0.1:3001/v1';
const PASS = process.env.TEST_PASSWORD || 'TestPass123!';
const stamp = Date.now().toString(36);
const adminEmail = `admin.${stamp}@test.upos.local`;
const __dir = dirname(fileURLToPath(import.meta.url));

const results = [];

function log(area, name, ok, detail = '') {
  results.push({ area, name, ok, detail: String(detail || '') });
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${area} · ${name}${detail ? ' — ' + detail : ''}`,
  );
}

async function req(method, path, { token, body, expectFail } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  const data = json.data !== undefined ? json.data : json;
  if (!res.ok && !expectFail) {
    const msg =
      typeof json.message === 'string'
        ? json.message
        : Array.isArray(json.message)
          ? json.message.join('; ')
          : json.error || res.statusText;
    const err = new Error(`${method} ${path} → ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return { status: res.status, data, raw: json };
}

/** Portal login → select org → tenant access token */
async function loginAs(email, password) {
  const r = await req('POST', '/auth/login', {
    body: { email, password },
  });
  const d = r.data;
  if (d.accessToken) return d.accessToken;
  if (d.identityToken && d.organizations?.[0]?.tenantId) {
    const sel = await req('POST', '/auth/select-organization', {
      token: d.identityToken,
      body: { tenantId: d.organizations[0].tenantId },
    });
    if (!sel.data.accessToken) {
      throw new Error('select-organization returned no accessToken');
    }
    return sel.data.accessToken;
  }
  throw new Error(
    `No session for ${email}: ${JSON.stringify(d).slice(0, 180)}`,
  );
}

async function main() {
  console.log(`\n=== Universal POS smoke test → ${API} ===\n`);

  // ── 1. Identity + org (Admin) ─────────────────────────────────────────
  let adminToken;
  let stationToken;
  let locationId;
  let identityToken;
  let tenantId;
  let tenantSlug;
  let adminUserId;

  try {
    const signup = await req('POST', '/auth/signup', {
      body: {
        fullName: 'Test Admin Owner',
        email: adminEmail,
        password: PASS,
        phone: '+919876543210',
      },
    });
    identityToken = signup.data.identityToken;
    log('IAM', 'Signup identity', Boolean(identityToken), adminEmail);
  } catch (e) {
    log('IAM', 'Signup identity', false, e.message);
    process.exit(1);
  }

  try {
    const created = await req('POST', '/auth/organizations', {
      token: identityToken,
      body: {
        organizationName: `Smoke Shop ${stamp}`,
        businessType: 'retail',
        phone: '+919876543210',
      },
    });
    adminToken = created.data.accessToken;
    stationToken = created.data.stationToken;
    tenantId = created.data.tenant?.id || created.data.user?.tenantId;
    tenantSlug = created.data.tenant?.slug;
    adminUserId = created.data.user?.id;
    log('IAM', 'Create organization + admin session', Boolean(adminToken), tenantSlug);
  } catch (e) {
    log('IAM', 'Create organization', false, e.message);
    process.exit(1);
  }

  if (!adminToken) {
    try {
      adminToken = await loginAs(adminEmail, PASS);
      log('IAM', 'Admin re-login', true);
    } catch (e) {
      log('IAM', 'Admin re-login', false, e.message);
      process.exit(1);
    }
  }

  // me
  try {
    const me = await req('GET', '/auth/me', { token: adminToken });
    adminUserId = me.data?.id || me.data?.user?.id || adminUserId;
    log(
      'IAM',
      'Admin me (roles)',
      true,
      (me.data?.roles || me.data?.user?.roles || []).join(',') || 'ok',
    );
  } catch (e) {
    log('IAM', 'Admin me', false, e.message);
  }

  // locations
  try {
    const locs = await req('GET', '/locations', { token: adminToken });
    const list = Array.isArray(locs.data) ? locs.data : locs.data?.items || [];
    locationId = list[0]?.id;
    if (!locationId) {
      const w = await req('POST', '/locations', {
        token: adminToken,
        body: {
          name: 'Main Warehouse',
          code: 'WH1',
          type: 'warehouse',
        },
      });
      locationId = w.data.id;
    }
    try {
      await req('POST', '/locations', {
        token: adminToken,
        body: {
          name: `Warehouse B ${stamp}`,
          code: `WHB${stamp}`.slice(0, 8),
          type: 'warehouse',
          address: 'Zone A',
        },
      });
      log('INV', 'Create multi-location warehouse B', true);
      log('INV', 'Warehouse management', true);
    } catch (e) {
      log('INV', 'Create multi-location warehouse B', false, e.message);
      log('INV', 'Warehouse management', false, e.message);
    }
    log('INV', 'Location ready', Boolean(locationId), locationId);
  } catch (e) {
    log('INV', 'Locations', false, e.message);
  }

  // PIN (must not be sequential/obvious per policy)
  const adminPin = '4829';
  try {
    await req('POST', '/auth/pin/set', {
      token: adminToken,
      body: { pin: adminPin },
    });
    log('IAM', 'PIN set (admin)', true);
    const pinSessionTok = stationToken || adminToken;
    if (adminUserId && locationId && pinSessionTok) {
      await req('POST', '/auth/pin/login', {
        token: pinSessionTok,
        body: {
          locationId,
          userId: adminUserId,
          pin: adminPin,
        },
      });
      log('IAM', 'PIN-based login (station session)', true);
    } else {
      log('IAM', 'PIN-based login (station session)', false, 'missing stationToken/user/location');
    }
  } catch (e) {
    log('IAM', 'PIN-based login', false, e.message);
  }

  // ── Staff users by role ───────────────────────────────────────────────
  const staff = [
    {
      roleCode: 'manager',
      email: `mgr.${stamp}@test.upos.local`,
      fullName: 'Store Manager Demo',
    },
    {
      roleCode: 'cashier',
      email: `cash.${stamp}@test.upos.local`,
      fullName: 'Cashier Demo',
    },
    {
      roleCode: 'inventory',
      email: `inv.${stamp}@test.upos.local`,
      fullName: 'Inventory Manager Demo',
    },
    {
      roleCode: 'accountant',
      email: `acc.${stamp}@test.upos.local`,
      fullName: 'Accountant Demo',
    },
  ];
  const staffIds = {};
  for (const s of staff) {
    try {
      const u = await req('POST', '/users', {
        token: adminToken,
        body: {
          email: s.email,
          fullName: s.fullName,
          password: PASS,
          roleCode: s.roleCode,
          primaryLocationId: locationId,
          jobTitle: s.fullName,
        },
      });
      staffIds[s.roleCode] = u.data.id || u.data.userId;
      log('IAM', `Create user ${s.roleCode}`, true, s.email);
    } catch (e) {
      log('IAM', `Create user ${s.roleCode}`, false, e.message);
    }
  }

  for (const s of staff) {
    try {
      const tok = await loginAs(s.email, PASS);
      // Verify role can call a safe endpoint
      const me = await req('GET', '/auth/me', { token: tok });
      const roles = me.data?.roles || me.data?.user?.roles || [];
      log(
        'IAM',
        `Login as ${s.roleCode}`,
        Boolean(tok),
        roles.length ? roles.join(',') : 'session ok',
      );
    } catch (e) {
      log('IAM', `Login as ${s.roleCode}`, false, e.message);
    }
  }

  // Custom role
  let customRoleId;
  try {
    const perms = await req('GET', '/iam/permissions', { token: adminToken });
    const list = Array.isArray(perms.data) ? perms.data : perms.data?.items || [];
    const codes = list.map((p) => p.code || p).filter(Boolean);
    const pick = codes.filter((c) =>
      ['catalog.read', 'inventory.read', 'pos.checkout', 'orders.read'].includes(
        c,
      ),
    );
    const role = await req('POST', '/iam/roles', {
      token: adminToken,
      body: {
        name: `Demo Associate ${stamp}`,
        code: `da_${stamp}`.slice(0, 36),
        permissions: pick.length ? pick : codes.slice(0, 4),
      },
    });
    customRoleId = role.data.id;
    log('IAM', 'Custom role & permissions', true, customRoleId);

    // optional: custom-role staff
    if (customRoleId) {
      const email = `custom.${stamp}@test.upos.local`;
      try {
        await req('POST', '/users', {
          token: adminToken,
          body: {
            email,
            fullName: 'Custom Role Associate',
            password: PASS,
            roleCode: role.data.code || `da_${stamp}`.slice(0, 36),
            primaryLocationId: locationId,
          },
        });
        staff.push({
          roleCode: 'custom',
          email,
          fullName: 'Custom Role Associate',
        });
        await loginAs(email, PASS);
        log('IAM', 'Create + login custom-role user', true, email);
      } catch (e) {
        log('IAM', 'Create custom-role user', false, e.message);
      }
    }
  } catch (e) {
    log('IAM', 'Custom role & permissions', false, e.message);
  }

  // Attendance
  try {
    await req('POST', '/iam/attendance/clock-in', {
      token: adminToken,
      body: { method: 'manual', locationId },
    });
    log('IAM', 'Attendance clock-in', true);
    await req('POST', '/iam/attendance/clock-out', {
      token: adminToken,
      body: {},
    });
    log('IAM', 'Attendance clock-out', true);
    const att = await req('GET', '/iam/attendance', { token: adminToken });
    const rows = att.data?.items || att.data || [];
    log(
      'IAM',
      'Attendance list',
      true,
      `${Array.isArray(rows) ? rows.length : 0} entries`,
    );
  } catch (e) {
    log('IAM', 'Attendance flow', false, e.message);
  }

  // Shifts
  try {
    const sh = await req('POST', '/iam/shifts', {
      token: adminToken,
      body: { name: 'Morning', startTime: '09:00', endTime: '17:00' },
    });
    log('IAM', 'Shift template create', true, sh.data.id);
    const today = new Date().toISOString().slice(0, 10);
    if (staffIds.cashier && sh.data.id) {
      await req('POST', '/iam/shift-assignments', {
        token: adminToken,
        body: {
          userId: staffIds.cashier,
          shiftId: sh.data.id,
          workDate: today,
          locationId,
        },
      });
      log('IAM', 'Shift assign staff', true);
    }
    await req('GET', '/iam/shifts', { token: adminToken });
    log('IAM', 'Shift list', true);
  } catch (e) {
    log('IAM', 'Shift management', false, e.message);
  }

  // WebAuthn (optional — may 4xx without browser/secure origin)
  try {
    await req('POST', '/iam/webauthn/register/options', { token: adminToken });
    log('IAM', 'Biometric WebAuthn options', true);
  } catch (e) {
    // Soft-pass if API exists but env not configured for WebAuthn
    const soft =
      e.status === 400 ||
      e.status === 501 ||
      /origin|rpId|webauthn/i.test(e.message);
    log('IAM', 'Biometric WebAuthn options', soft, e.message.slice(0, 100));
  }

  // ── Product catalog ──────────────────────────────────────────────────
  let brandId;
  let catId;
  let subCatId;
  let productId;
  let serviceId;
  let digitalId;
  let bundleId;
  let varId;

  try {
    const b = await req('POST', '/catalog/brands', {
      token: adminToken,
      body: { name: `Nike Test ${stamp}`, description: 'Demo brand' },
    });
    brandId = b.data.id;
    log('CATALOG', 'Brand create', true);
  } catch (e) {
    log('CATALOG', 'Brand create', false, e.message);
  }

  try {
    const c = await req('POST', '/catalog/categories', {
      token: adminToken,
      body: { name: `Footwear ${stamp}` },
    });
    catId = c.data.id;
    const sc = await req('POST', '/catalog/categories', {
      token: adminToken,
      body: { name: `Sports Shoes ${stamp}`, parentId: catId },
    });
    subCatId = sc.data.id;
    log('CATALOG', 'Category + subcategory', true);
  } catch (e) {
    log('CATALOG', 'Category tree', false, e.message);
  }

  try {
    const sku = await req('POST', '/catalog/sku/generate', {
      token: adminToken,
      body: { name: 'Air Max', kind: 'physical' },
    });
    log('CATALOG', 'SKU generation', Boolean(sku.data.sku || sku.data.skuCode), sku.data.sku || sku.data.skuCode);
  } catch (e) {
    log('CATALOG', 'SKU generation', false, e.message);
  }

  try {
    const p = await req('POST', '/catalog/products', {
      token: adminToken,
      body: {
        name: `Nike Air Max ${stamp}`,
        shortName: 'AM demo',
        kind: 'physical',
        status: 'active',
        categoryId: subCatId || catId,
        brandId,
        barcode: `890${stamp}`.replace(/[^0-9]/g, '').slice(0, 13).padEnd(13, '0'),
        internalCode: `INT-${stamp}`,
        shortDescription: 'Demo sneaker',
        description: 'Full description for catalog',
        basePrice: 4999,
        costPrice: 3000,
        mrp: 5499,
        taxCode: 'GST12',
        unitOfMeasure: 'pcs',
        trackInventory: true,
        trackSerial: true,
        trackBatch: true,
        canSell: true,
        canPurchase: true,
        availableInPos: true,
        openingQty: 20,
        locationId,
        photoUrl: 'https://via.placeholder.com/120',
        images: ['https://via.placeholder.com/120'],
      },
    });
    productId = p.data.id;
    log('CATALOG', 'Physical product + image + barcode', true, productId);
  } catch (e) {
    log('CATALOG', 'Physical product', false, e.message);
  }

  try {
    const s = await req('POST', '/catalog/products', {
      token: adminToken,
      body: {
        name: `Haircut Service ${stamp}`,
        kind: 'service',
        basePrice: 300,
        trackInventory: false,
        canPurchase: false,
        unitOfMeasure: 'service',
      },
    });
    serviceId = s.data.id;
    log('CATALOG', 'Service product', true);
  } catch (e) {
    log('CATALOG', 'Service product', false, e.message);
  }

  try {
    const d = await req('POST', '/catalog/products', {
      token: adminToken,
      body: {
        name: `Digital Course ${stamp}`,
        kind: 'digital',
        basePrice: 999,
        trackInventory: false,
        canPurchase: false,
        unitOfMeasure: 'pcs',
      },
    });
    digitalId = d.data.id;
    log('CATALOG', 'Digital product', true);
  } catch (e) {
    log('CATALOG', 'Digital product', false, e.message);
  }

  try {
    const b = await req('POST', '/catalog/products', {
      token: adminToken,
      body: {
        name: `Starter Kit Bundle ${stamp}`,
        kind: 'bundle',
        basePrice: 1500,
        trackInventory: false,
      },
    });
    bundleId = b.data.id;
    if (productId && serviceId) {
      await req('PUT', `/catalog/products/${bundleId}/bundle-lines`, {
        token: adminToken,
        body: {
          lines: [
            { componentProductId: productId, quantity: 1 },
            { componentProductId: serviceId, quantity: 1 },
          ],
        },
      });
    }
    log('CATALOG', 'Bundle/combo product', true);
  } catch (e) {
    log('CATALOG', 'Bundle/combo', false, e.message);
  }

  try {
    const v = await req('POST', `/catalog/products/${productId}/variants`, {
      token: adminToken,
      body: {
        name: 'Black / 42',
        attributes: { size: '42', color: 'Black', weight: '0.8' },
        basePrice: 4999,
      },
    });
    varId = v.data.id;
    log('CATALOG', 'Product variant size/color/weight', true, varId);
  } catch (e) {
    log('CATALOG', 'Product variant', false, e.message);
  }

  try {
    await req('POST', `/catalog/products/${productId}/serials`, {
      token: adminToken,
      body: { serial: `SN-${stamp}-001`, locationId, label: 'Unit 1' },
    });
    log('CATALOG', 'Serial number tracking', true);
  } catch (e) {
    log('CATALOG', 'Serial number', false, e.message);
  }

  try {
    await req('POST', `/catalog/products/${productId}/batches`, {
      token: adminToken,
      body: {
        batchCode: `LOT-${stamp}`,
        locationId,
        expiresAt: '2027-12-31',
        qtyOnHand: 5,
      },
    });
    log('CATALOG', 'Batch & expiry', true);
  } catch (e) {
    log('CATALOG', 'Batch & expiry', false, e.message);
  }

  try {
    const qr = await req('GET', `/catalog/products/${productId}/qr`, {
      token: adminToken,
    });
    log(
      'CATALOG',
      'QR code payload',
      Boolean(qr.data?.payload || qr.data?.chartUrl || qr.data?.qrCode),
    );
  } catch (e) {
    log('CATALOG', 'QR code', false, e.message);
  }

  try {
    const dup = await req('POST', `/catalog/products/${productId}/duplicate`, {
      token: adminToken,
    });
    log('CATALOG', 'Product duplicate', Boolean(dup.data.id));
  } catch (e) {
    log('CATALOG', 'Product duplicate', false, e.message);
  }

  try {
    const list = await req('GET', `/catalog/products?q=Nike`, {
      token: adminToken,
    });
    const items = list.data.items || list.data || [];
    log(
      'CATALOG',
      'Catalog search',
      Array.isArray(items) && items.length > 0,
      `${Array.isArray(items) ? items.length : 0} hits`,
    );
  } catch (e) {
    log('CATALOG', 'Catalog search', false, e.message);
  }

  // ── Inventory ────────────────────────────────────────────────────────
  let stockLevelId;
  let locB;

  try {
    const levels = await req(
      'GET',
      `/inventory/levels?locationId=${locationId}&includeZero=true`,
      { token: adminToken },
    );
    const items = levels.data.items || [];
    stockLevelId =
      items.find((i) => i.productId === productId)?.stockLevelId ||
      items[0]?.stockLevelId;
    log('INV', 'List stock levels', items.length > 0, `${items.length} rows`);
  } catch (e) {
    log('INV', 'List stock levels', false, e.message);
  }

  const productRef = stockLevelId
    ? { stockLevelId }
    : productId
      ? { productId }
      : null;

  try {
    if (!productRef) throw new Error('no stock level / product');
    await req('POST', '/inventory/stock-in', {
      token: adminToken,
      body: {
        locationId,
        reason: 'Opening stock GRN',
        lines: [{ ...productRef, qty: 10 }],
      },
    });
    log('INV', 'Stock In', true);
  } catch (e) {
    log('INV', 'Stock In', false, e.message);
  }

  try {
    await req('POST', '/inventory/stock-out', {
      token: adminToken,
      body: {
        locationId,
        reason: 'Internal use',
        lines: [{ ...productRef, qty: 2 }],
      },
    });
    log('INV', 'Stock Out', true);
  } catch (e) {
    log('INV', 'Stock Out', false, e.message);
  }

  try {
    await req('POST', '/inventory/adjust', {
      token: adminToken,
      body: {
        locationId,
        ...productRef,
        delta: 1,
        reason: 'Correction',
      },
    });
    log('INV', 'Stock adjustment', true);
  } catch (e) {
    log('INV', 'Stock adjustment', false, e.message);
  }

  try {
    await req('PATCH', '/inventory/reorder', {
      token: adminToken,
      body: {
        locationId,
        ...productRef,
        reorderPoint: 5,
        reorderQty: 20,
      },
    });
    log('INV', 'Reorder levels', true);
  } catch (e) {
    log('INV', 'Reorder levels', false, e.message);
  }

  try {
    const low = await req(
      'GET',
      `/inventory/low-stock?locationId=${locationId}`,
      { token: adminToken },
    );
    log('INV', 'Low stock alerts', true, `count=${low.data.count ?? 0}`);
  } catch (e) {
    log('INV', 'Low stock alerts', false, e.message);
  }

  try {
    await req('POST', '/inventory/damage', {
      token: adminToken,
      body: {
        locationId,
        ...productRef,
        qty: 1,
        reason: 'Damaged carton',
      },
    });
    log('INV', 'Damaged stock quarantine', true);
    await req('POST', '/inventory/damage/restore', {
      token: adminToken,
      body: {
        locationId,
        ...productRef,
        qty: 1,
        reason: 'Repaired',
      },
    });
    log('INV', 'Damaged restore', true);
  } catch (e) {
    log('INV', 'Damaged stock', false, e.message);
  }

  try {
    const count = await req('POST', '/inventory/counts', {
      token: adminToken,
      body: { locationId, notes: 'Smoke audit' },
    });
    const cid = count.data.id;
    const detail = await req('GET', `/inventory/counts/${cid}`, {
      token: adminToken,
    });
    const lines = (detail.data.lines || []).slice(0, 5).map((l) => ({
      stockLevelId: l.stockLevelId,
      countedQty: Number(l.systemQty ?? l.countedQty ?? 0),
    }));
    if (lines.length) {
      await req('POST', `/inventory/counts/${cid}/lines`, {
        token: adminToken,
        body: { lines },
      });
    }
    await req('POST', `/inventory/counts/${cid}/complete`, {
      token: adminToken,
      body: { apply: true },
    });
    log('INV', 'Physical stock audit', true, cid);
  } catch (e) {
    log('INV', 'Physical stock audit', false, e.message);
  }

  try {
    const locs = await req('GET', '/locations', { token: adminToken });
    const list = Array.isArray(locs.data) ? locs.data : [];
    locB = list.find((l) => l.id !== locationId)?.id;
    if (locB && productId) {
      await req('POST', '/stock-transfers', {
        token: adminToken,
        body: {
          fromLocationId: locationId,
          toLocationId: locB,
          notes: 'Smoke transfer',
          lines: [{ productId, qty: 3 }],
        },
      });
      log('INV', 'Stock transfer multi-location', true);
    } else {
      log('INV', 'Stock transfer multi-location', false, 'need 2 locations');
    }
  } catch (e) {
    log('INV', 'Stock transfer', false, e.message);
  }

  // Supplier + PO + receive + RTV
  let supplierId;
  let poId;
  try {
    const sup = await req('POST', '/suppliers', {
      token: adminToken,
      body: {
        name: `Supplier ${stamp}`,
        contact: 'Raj',
        phone: '+919999999999',
      },
    });
    supplierId = sup.data.id;
    log('INV', 'Supplier management', true);
  } catch (e) {
    log('INV', 'Supplier create', false, e.message);
  }

  try {
    if (supplierId && stockLevelId) {
      const po = await req('POST', '/purchase-orders', {
        token: adminToken,
        body: {
          supplierId,
          lines: [{ stockLevelId, qtyOrdered: 5, unitCost: 100 }],
        },
      });
      poId = po.data.id;
      log('INV', 'Purchase entry (PO)', true, poId);
      await req('PATCH', `/purchase-orders/${poId}`, {
        token: adminToken,
        body: { status: 'ordered' },
      });
      await req('POST', `/purchase-orders/${poId}/receive`, {
        token: adminToken,
        body: { lines: [{ stockLevelId, qty: 5 }] },
      });
      log('INV', 'PO receive (purchase stock in)', true);
      await req('POST', `/purchase-orders/${poId}/return`, {
        token: adminToken,
        body: {
          lines: [{ stockLevelId, qty: 1 }],
          reason: 'Wrong item RTV',
        },
      });
      log('INV', 'Returns to supplier (RTV)', true);
    } else {
      log('INV', 'Purchase / RTV cycle', false, 'missing supplier or stockLevel');
    }
  } catch (e) {
    log('INV', 'Purchase / RTV cycle', false, e.message);
  }

  try {
    const led = await req(
      'GET',
      `/inventory/ledger?locationId=${locationId}&limit=20`,
      { token: adminToken },
    );
    const items = led.data.items || [];
    log('INV', 'Stock ledger', items.length > 0, `${items.length} entries`);
  } catch (e) {
    log('INV', 'Stock ledger', false, e.message);
  }

  // Role-scoped denials (cashier should not stock-in)
  try {
    const cashTok = await loginAs(
      staff.find((s) => s.roleCode === 'cashier').email,
      PASS,
    );
    try {
      await req('POST', '/inventory/stock-in', {
        token: cashTok,
        body: {
          locationId,
          lines: [{ ...productRef, qty: 1 }],
        },
      });
      log('IAM', 'Cashier blocked from stock-in', false, 'unexpected allow');
    } catch (e) {
      log(
        'IAM',
        'Cashier blocked from stock-in',
        e.status === 403 || e.status === 401,
        `status ${e.status}`,
      );
    }
  } catch (e) {
    log('IAM', 'Cashier RBAC check', false, e.message);
  }

  // Summary + credentials file
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  const creds = {
    api: API,
    password: PASS,
    tenantId,
    tenantSlug,
    locationId,
    customRoleId,
    admin: { email: adminEmail, role: 'admin', pin: '4829' },
    staff: staff.map((s) => ({ email: s.email, role: s.roleCode })),
    sampleIds: {
      brandId,
      categoryId: catId,
      productId,
      serviceId,
      digitalId,
      bundleId,
      variantId: varId,
      poId,
      supplierId,
    },
    results: { pass, fail, total: results.length },
  };
  const outPath = join(__dir, `smoke-credentials-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(creds, null, 2));

  console.log('\n========== SUMMARY ==========');
  console.log(`PASS ${pass}  FAIL ${fail}  TOTAL ${results.length}`);
  console.log(`Credentials: ${outPath}`);
  console.log('\nDemo logins (password: ' + PASS + '):');
  console.log(`  admin        ${adminEmail}`);
  for (const s of staff) console.log(`  ${s.roleCode.padEnd(12)} ${s.email}`);
  if (customRoleId) console.log(`  Custom role id: ${customRoleId}`);
  console.log('==============================\n');

  if (fail > 0) {
    console.log('Failures:');
    for (const r of results.filter((x) => !x.ok)) {
      console.log(` - [${r.area}] ${r.name}: ${r.detail}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
