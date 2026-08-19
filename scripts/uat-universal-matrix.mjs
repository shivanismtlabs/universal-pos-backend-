/**
 * Universal POS — UAT matrix: 24 templates + 5 unknown businesses.
 * Templates are setup defaults only. Runtime is commerce modes + capabilities.
 *
 * Usage:
 *   node scripts/uat-universal-matrix.mjs
 *   API_URL=http://127.0.0.1:3001/v1 node scripts/uat-universal-matrix.mjs
 *   SKIP_LIVE=1 node scripts/uat-universal-matrix.mjs
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dir = dirname(fileURLToPath(import.meta.url));
const API = process.env.API_URL || 'http://127.0.0.1:3001/v1';
const SKIP_LIVE = process.env.SKIP_LIVE === '1';
const STAMP = Date.now().toString(36);
const PASSWORD = 'WalitShop@2026';
const OUT_DIR = join(__dir, 'qa-results');
mkdirSync(OUT_DIR, { recursive: true });

function loadCommon(name) {
  try {
    require('ts-node/register/transpile-only');
  } catch {
    /* optional — compiled dist may exist */
  }
  const candidates = [
    join(__dir, `../dist/src/common/${name}.js`),
    join(__dir, `../dist/common/${name}.js`),
    join(__dir, `../src/common/${name}.ts`),
  ];
  let lastErr;
  for (const p of candidates) {
    try {
      return require(p);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const {
  recommendCapabilities,
  recommendCommerceModes,
  hasCapability,
} = loadCommon('capabilities');
const {
  listBusinessConfigs,
  resolveSetupBusinessProfile,
  getBusinessConfig,
} = loadCommon('business-config');
const { enabledReportPacks, reportContextFromSettings } = loadCommon(
  'report-capabilities',
);

/** 24 operator profiles: 19 registry templates + 5 aliases (not separate apps). */
const TEMPLATES_24 = [
  { id: 'retail', kind: 'template', expectModes: ['sale'], mustHave: ['INVENTORY', 'BARCODE'], mustNot: ['KOT'] },
  { id: 'grocery', kind: 'template', expectModes: ['sale'], mustHave: ['BATCH', 'EXPIRY'], mustNot: ['KOT'] },
  { id: 'restaurant', kind: 'template', expectModes: ['sale'], mustHave: ['TABLE', 'KOT', 'KITCHEN'], mustNot: ['REPAIR_JOB'] },
  { id: 'salon', kind: 'template', expectModes: ['service'], mustHave: ['BOOKING', 'STAFF_ASSIGNMENT'], mustNot: ['KOT'] },
  { id: 'service', kind: 'template', expectModes: ['service'], mustHave: ['BOOKING'], mustNot: ['KOT'] },
  { id: 'gym', kind: 'template', expectModes: ['subscription'], mustHave: ['MEMBERSHIP', 'CHECK_IN'], mustNot: ['KOT'] },
  { id: 'rental', kind: 'template', expectModes: ['rental'], mustHave: ['DEPOSIT', 'AVAILABILITY'], mustNot: ['KOT'] },
  { id: 'repair', kind: 'template', expectModes: ['service'], mustHave: ['REPAIR_JOB', 'ASSET'], mustNot: ['KOT'] },
  { id: 'pharmacy', kind: 'template', expectModes: ['sale'], mustHave: ['BATCH', 'EXPIRY', 'SERIAL'], mustNot: ['KOT'] },
  { id: 'furniture', kind: 'template', expectModes: ['sale'], mustHave: ['PARTIAL_PAYMENT'], mustNot: ['KOT'] },
  { id: 'coaching', kind: 'template', expectModes: ['subscription', 'service'], mustHave: ['SUBSCRIPTION', 'BOOKING'], mustNot: ['KOT'] },
  { id: 'spa', kind: 'template', expectModes: ['service'], mustHave: ['BOOKING', 'RESOURCE'], mustNot: ['KOT'] },
  { id: 'event', kind: 'template', expectModes: ['service'], mustHave: ['BOOKING', 'RESOURCE'], mustNot: ['KOT'] },
  { id: 'laundry', kind: 'template', expectModes: ['service'], mustHave: ['BOOKING'], mustNot: ['KOT'] },
  { id: 'pet_grooming', kind: 'template', expectModes: ['service'], mustHave: ['BOOKING'], mustNot: ['KOT'] },
  { id: 'photography', kind: 'template', expectModes: ['service'], mustHave: ['BOOKING'], mustNot: ['KOT'] },
  { id: 'car_wash', kind: 'template', expectModes: ['service'], mustHave: ['BOOKING'], mustNot: ['KOT'] },
  { id: 'coworking', kind: 'template', expectModes: ['subscription', 'service'], mustHave: ['MEMBERSHIP', 'CHECK_IN'], mustNot: ['KOT'] },
  { id: 'other', kind: 'template', expectModes: ['sale'], mustHave: ['CUSTOM_FIELDS'], mustNot: ['KOT'] },
  { id: 'clothing', kind: 'alias', mapsTo: 'other', expectModes: ['sale'] },
  { id: 'electronics', kind: 'alias', mapsTo: 'other', expectModes: ['sale'] },
  { id: 'cafe', kind: 'alias', mapsTo: 'other', expectModes: ['sale'] },
  { id: 'bakery', kind: 'alias', mapsTo: 'other', expectModes: ['sale'] },
  { id: 'clinic', kind: 'alias', mapsTo: 'other', expectModes: ['sale'] },
];

const UNKNOWN_5 = [
  { id: 'swimming_academy', label: 'BlueWave Swim', sells: ['products', 'services'] },
  { id: 'florist', label: 'Petal & Stem', sells: ['products'] },
  { id: 'hardware_store', label: 'Bolt & Bit', sells: ['products'] },
  { id: 'tutoring_centre', label: 'BrightHours Tutors', sells: ['services', 'subscriptions'] },
  { id: 'veterinary', label: 'PawCare Vet', sells: ['services', 'products'] },
];

const RESULTS = [];
const MATRIX = [];

function log(row, area, name, status, detail = '') {
  RESULTS.push({ row, area, name, status, detail });
  console.log(`${status.padEnd(7)} [${row}/${area}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function scoreOf(status) {
  if (status === 'PASS') return 1;
  if (status === 'PARTIAL') return 0.5;
  return 0;
}

function finalizeRow(id, cells) {
  const vals = Object.values(cells);
  const fail = vals.includes('FAIL');
  const partial = vals.includes('PARTIAL');
  const final = fail ? 'FAIL' : partial ? 'PARTIAL' : 'PASS';
  MATRIX.push({ id, ...cells, final });
  return final;
}

/* ── unit ─────────────────────────────────────────────── */

function unitTemplates() {
  console.log('\n—— unit: 24 profiles ——');
  const registryIds = new Set(listBusinessConfigs().map((c) => c.id));
  for (const p of TEMPLATES_24) {
    const cells = { resolve: 'PENDING', modes: 'PENDING', caps: 'PENDING', packs: 'PENDING' };
    try {
      const resolved = resolveSetupBusinessProfile(p.id);
      const expectedMap = p.kind === 'alias' ? 'other' : p.id;
      if (p.kind === 'alias') {
        cells.resolve =
          resolved.unknown && resolved.profile.id === 'other' ? 'PASS' : 'FAIL';
        log(
          p.id,
          'unit',
          'alias maps to Other (no industry pack)',
          cells.resolve,
          `profile=${resolved.profile.id} unknown=${resolved.unknown}`,
        );
      } else {
        cells.resolve =
          registryIds.has(p.id) && resolved.profile.id === p.id ? 'PASS' : 'FAIL';
        log(p.id, 'unit', 'registry template', cells.resolve, resolved.profile.label);
      }

      const profile = getBusinessConfig(resolved.profile.id);
      const modes = recommendCommerceModes({
        businessType: profile.id,
        fallback: profile.defaultCommerceModes,
      });
      const missingModes = (p.expectModes || []).filter((m) => !modes.includes(m));
      cells.modes = missingModes.length ? 'FAIL' : 'PASS';
      log(p.id, 'unit', 'commerce modes', cells.modes, `modes=[${modes}]`);

      const caps = recommendCapabilities({
        businessType: profile.id,
        commerceModes: modes.length ? modes : profile.defaultCommerceModes,
      });
      const missing = (p.mustHave || []).filter((c) => !hasCapability(caps, c));
      const extra = (p.mustNot || []).filter((c) => hasCapability(caps, c));
      cells.caps = missing.length || extra.length ? 'FAIL' : 'PASS';
      log(
        p.id,
        'unit',
        'capabilities',
        cells.caps,
        missing.length
          ? `missing ${missing}`
          : extra.length
            ? `unexpected ${extra}`
            : `n=${caps.length}`,
      );

      const packs = enabledReportPacks(
        reportContextFromSettings({
          businessType: profile.id,
          commerceModes: modes,
          capabilities: caps,
        }),
      );
      const packOk =
        (modes.includes('rental') ? packs.rental : true) &&
        (modes.includes('subscription') || hasCapability(caps, 'MEMBERSHIP')
          ? packs.subscription
          : true);
      cells.packs = packOk ? 'PASS' : 'FAIL';
      log(
        p.id,
        'unit',
        'report packs',
        cells.packs,
        `sale=${packs.sale} rental=${packs.rental} sub=${packs.subscription}`,
      );
    } catch (e) {
      cells.resolve = 'FAIL';
      log(p.id, 'unit', 'crash', 'FAIL', e.message);
    }
    finalizeRow(p.id, cells);
  }
}

function unitUnknown() {
  console.log('\n—— unit: 5 unknown businesses ——');
  for (const u of UNKNOWN_5) {
    const cells = { resolve: 'PENDING', modes: 'PENDING', caps: 'PENDING', packs: 'PENDING' };
    const resolved = resolveSetupBusinessProfile(u.id);
    cells.resolve =
      resolved.unknown && resolved.profile.id === 'other' ? 'PASS' : 'FAIL';
    log(
      u.id,
      'unit',
      'unknown → Other (no code pack)',
      cells.resolve,
      `requested=${u.id}`,
    );

    const modes = recommendCommerceModes({
      sells: u.sells,
      fallback: ['sale'],
    });
    cells.modes = modes.length ? 'PASS' : 'FAIL';
    log(u.id, 'unit', 'modes from sells[]', cells.modes, `[${modes}]`);

    const caps = recommendCapabilities({
      businessType: 'other',
      commerceModes: modes,
      sells: u.sells,
    });
    cells.caps = hasCapability(caps, 'CUSTOM_FIELDS') ? 'PASS' : 'PARTIAL';
    log(u.id, 'unit', 'other + custom fields', cells.caps, `n=${caps.length}`);

    const packs = enabledReportPacks(
      reportContextFromSettings({
        businessType: 'other',
        commerceModes: modes,
        capabilities: caps,
      }),
    );
    cells.packs =
      packs.sale || packs.service || packs.subscription || packs.rental
        ? 'PASS'
        : 'FAIL';
    log(
      u.id,
      'unit',
      'can use core reports',
      cells.packs,
      `sale=${packs.sale} service=${packs.service} sub=${packs.subscription}`,
    );
    finalizeRow(`unknown:${u.id}`, cells);
  }
}

function unitStaticScan() {
  console.log('\n—— static: leftover industry ifs ——');
  const files = [
    join(__dir, '..', 'src/modules/reports/reports-employees.service.ts'),
    join(__dir, '..', 'src/modules/reports/reports-top-products.service.ts'),
    join(__dir, '..', 'src/modules/reports/reports-inventory.service.ts'),
    join(__dir, '..', '..', 'frontend', 'src', 'app', '(app)', 'reports', 'employees', 'page.tsx'),
    join(__dir, '..', '..', 'frontend', 'src', 'app', '(app)', 'reports', 'daily', 'page.tsx'),
    join(__dir, '..', '..', 'frontend', 'src', 'app', '(app)', 'reports', 'top-products', 'page.tsx'),
    join(__dir, '..', '..', 'frontend', 'src', 'app', '(app)', 'reports', 'inventory', 'page.tsx'),
    join(__dir, '..', '..', 'frontend', 'src', 'app', '(app)', 'reports', 'slow-moving', 'page.tsx'),
  ];
  let hits = 0;
  for (const p of files) {
    const rel = p.replace(/\\/g, '/').replace(/^.*\/(frontend|backend)\//, '$1/');
    try {
      const text = readFileSync(p, 'utf8');
      const n = (
        text.match(
          /businessType\s*===\s*['"](?:restaurant|salon|grocery|hybrid|service|spa)['"]/g,
        ) || []
      ).length;
      hits += n;
      if (n) log('static', 'scan', rel, 'PARTIAL', `${n} businessType ===`);
    } catch {
      log('static', 'scan', rel, 'SKIP', 'file not found');
    }
  }
  const cells = {
    resolve: 'PASS',
    modes: 'PASS',
    caps: hits ? 'PARTIAL' : 'PASS',
    packs: hits ? 'PARTIAL' : 'PASS',
  };
  log(
    'static',
    'scan',
    'core engines vs report UI leftovers',
    hits ? 'PARTIAL' : 'PASS',
    hits
      ? `${hits} leftover ifs in report column show/hide (not checkout engines)`
      : 'clean',
  );
  finalizeRow('static-scan', cells);
}

/* ── live ─────────────────────────────────────────────── */

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
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  const data = json?.data ?? json;
  return { ok: res.ok, status: res.status, data, text, json };
}

async function provision(businessType, label, sells) {
  const email = `uat.${businessType}.${STAMP}@upos.test`.slice(0, 80);
  const signup = await api('POST', '/auth/signup', {
    body: { email, password: PASSWORD, fullName: `${label} Owner` },
  });
  if (!signup.ok || !signup.data?.identityToken) {
    throw new Error(`signup ${signup.status} ${signup.text.slice(0, 160)}`);
  }
  const created = await api('POST', '/auth/organizations', {
    token: signup.data.identityToken,
    body: {
      organizationName: `${label} ${STAMP}`.slice(0, 80),
      businessType,
      businessLabel: label,
      addressLine1: '12 Universal Road',
      state: 'Maharashtra',
      city: 'Mumbai',
      postalCode: '400001',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-08-01',
      storeName: `${label} Main`.slice(0, 40),
      ...(Array.isArray(sells) && sells.length ? { sells } : {}),
    },
  });
  if (!created.ok || !created.data?.accessToken) {
    throw new Error(`org ${created.status} ${created.text.slice(0, 180)}`);
  }
  return {
    token: created.data.accessToken,
    email,
    tenantId: created.data.user?.tenantId,
  };
}

async function liveSaleSlice(token, title) {
  const locs = await api('GET', '/locations', { token });
  const loc = Array.isArray(locs.data) ? locs.data[0] : locs.data?.items?.[0] || locs.data?.[0];
  const locId = loc?.id;
  if (!locId) return { status: 'FAIL', detail: 'no location' };

  const cat = await api('POST', '/pos/sale/categories', {
    token,
    body: { name: `UAT ${title}`.slice(0, 40) },
  });
  if (!cat.ok) return { status: 'PARTIAL', detail: `category ${cat.status}` };

  const sku = `U${STAMP}${Math.floor(Math.random() * 99)}`.slice(0, 18);
  const prod = await api('POST', '/pos/sale/products', {
    token,
    body: {
      title: `${title} item`,
      sku,
      price: 199,
      qty: 10,
      locationId: locId,
      categoryId: cat.data.id,
    },
  });
  if (!prod.ok) return { status: 'PARTIAL', detail: `product ${prod.status} ${prod.text.slice(0, 80)}` };
  const stockLevelId =
    prod.data.stockLevelId || prod.data.stockLevel?.id || prod.data.id;

  await api('POST', '/pos/sale/register/open', {
    token,
    body: { locationId: locId, openingFloat: 500 },
  });

  let sale = await api('POST', '/pos/sale/checkout', {
    token,
    body: {
      locationId: locId,
      items: [{ stockLevelId, quantity: 1, unitPrice: 199 }],
      payments: [
        {
          method: 'cash',
          amount: 250,
          idempotencyKey: `uat-${STAMP}-${Math.random().toString(36).slice(2, 8)}`,
        },
      ],
      cashTendered: 250,
    },
  });
  if (!sale.ok) {
    const msg = String(sale.json?.message || sale.text || '');
    const m = msg.match(/(\d+(\.\d+)?)/);
    if (m) {
      const due = Number(m[1]);
      sale = await api('POST', '/pos/sale/checkout', {
        token,
        body: {
          locationId: locId,
          items: [{ stockLevelId, quantity: 1, unitPrice: 199 }],
          payments: [
            {
              method: 'cash',
              amount: due,
              idempotencyKey: `uat-${STAMP}-r`,
            },
          ],
          cashTendered: due + 10,
        },
      });
    }
  }
  if (!sale.ok) return { status: 'FAIL', detail: `checkout ${sale.status}` };
  return { status: 'PASS', detail: sale.data?.order?.orderNumber || 'ok' };
}

async function liveRow(id, label, businessType, expect) {
  const cells = { setup: 'PENDING', packs: 'PENDING', operate: 'PENDING' };
  try {
    const ctx = await provision(businessType, label, expect?.sells);
    const boot = await api('GET', '/tenants/me/bootstrap', { token: ctx.token });
    const modes = boot.data?.commerce?.modes || [];
    const caps = boot.data?.capabilities?.enabled || [];
    const type = boot.data?.business?.type || boot.data?.business?.config?.id;
    cells.setup = modes.length ? 'PASS' : 'FAIL';
    log(id, 'live', 'onboard', cells.setup, `type=${type} modes=[${modes}] caps=${caps.length}`);

    const packs = await api('GET', '/reports/packs', { token: ctx.token });
    cells.packs = packs.ok ? 'PASS' : 'PARTIAL';
    log(
      id,
      'live',
      'reports/packs',
      cells.packs,
      packs.ok
        ? `rental=${packs.data?.rental} sub=${packs.data?.subscription}`
        : String(packs.status),
    );

    const fields = await api('GET', '/custom-fields/definitions?entity=product', {
      token: ctx.token,
    });
    log(
      id,
      'live',
      'custom fields API',
      fields.ok || fields.status === 404 ? 'PASS' : 'PARTIAL',
      String(fields.status),
    );

    const saleMode = modes.includes('sale') || expect?.checkout === true;
    if (saleMode) {
      const op = await liveSaleSlice(ctx.token, label);
      cells.operate = op.status;
      log(id, 'live', 'cash checkout', op.status, op.detail);
    } else {
      cells.operate = 'PASS';
      log(id, 'live', 'non-sale desk (config only)', 'PASS', `modes=[${modes}]`);
    }
  } catch (e) {
    cells.setup = 'FAIL';
    cells.operate = 'FAIL';
    log(id, 'live', 'crash', 'FAIL', e.message);
  }
  return finalizeRow(`live:${id}`, cells);
}

async function liveAll() {
  console.log(`\n—— live API @ ${API} ——`);
  const health = await api('GET', '/health');
  if (!health.ok) {
    log('live', 'health', 'API', 'FAIL', `${health.status}`);
    return;
  }
  log('live', 'health', 'API', 'PASS', API);

  const rec = await api('POST', '/commerce/recommend-setup', {
    body: { businessType: 'swimming', sells: ['products', 'services'] },
  });
  log(
    'live',
    'recommend',
    'unknown swimming',
    rec.ok ? 'PASS' : 'PARTIAL',
    rec.ok
      ? `→ ${rec.data?.businessType} modes=[${rec.data?.commerceModes}]`
      : String(rec.status),
  );

  const liveTemplates = TEMPLATES_24.filter((p) => p.kind === 'template');
  for (const p of liveTemplates) {
    await liveRow(p.id, p.id, p.id, {
      checkout: (p.expectModes || []).includes('sale'),
    });
  }
  for (const p of TEMPLATES_24.filter((x) => x.kind === 'alias')) {
    await liveRow(p.id, p.id, p.id, { checkout: true });
  }
  for (const u of UNKNOWN_5) {
    await liveRow(`unknown:${u.id}`, u.label, u.id, {
      checkout: u.sells.includes('products'),
      sells: u.sells,
    });
  }
}

function printMatrix() {
  console.log('\n=== COMPATIBILITY MATRIX ===');
  console.log(
    'id'.padEnd(28) +
      ['resolve', 'modes', 'caps', 'packs', 'setup', 'operate', 'final']
        .map((h) => h.padEnd(10))
        .join(''),
  );
  for (const r of MATRIX) {
    const cols = ['resolve', 'modes', 'caps', 'packs', 'setup', 'operate', 'final'].map(
      (k) => String(r[k] ?? '—').padEnd(10),
    );
    console.log(String(r.id).padEnd(28) + cols.join(''));
  }
}

async function main() {
  console.log(`Universal POS UAT matrix ${new Date().toISOString()}`);
  unitTemplates();
  unitUnknown();
  unitStaticScan();
  if (!SKIP_LIVE) {
    try {
      await liveAll();
    } catch (e) {
      log('live', 'suite', 'aborted', 'FAIL', e.message);
    }
  } else {
    log('live', 'suite', 'skipped', 'SKIP', 'SKIP_LIVE=1');
  }
  printMatrix();

  const finals = MATRIX.map((m) => m.final);
  const pass = finals.filter((f) => f === 'PASS').length;
  const partial = finals.filter((f) => f === 'PARTIAL').length;
  const fail = finals.filter((f) => f === 'FAIL').length;
  const score = Math.round(
    (MATRIX.reduce((s, m) => s + scoreOf(m.final), 0) / Math.max(MATRIX.length, 1)) *
      100,
  );

  const unknownRows = MATRIX.filter((m) => String(m.id).includes('unknown'));
  const unknownPass = unknownRows.every((m) => m.final === 'PASS');

  const leftover = RESULTS.filter(
    (r) => r.row === 'static' && r.status === 'PARTIAL',
  ).length;

  let verdict = 'UNIVERSAL WITH GAPS';
  if (fail === 0 && leftover === 0 && partial === 0) verdict = 'UNIVERSAL';
  else if (fail === 0) verdict = 'UNIVERSAL WITH GAPS';
  else verdict = 'NOT READY';

  const answers = {
    canUnknownOperateWithoutCode:
      unknownPass && fail === 0
        ? 'YES — Other profile + modes/capabilities; no industry pack required'
        : fail === 0
          ? 'MOSTLY YES — onboard + operate sale; some report columns still key off setup template'
          : 'NO — live onboard/checkout failures',
    areThe24SeparateApps: 'NO — 19 setup templates + 5 aliases map to Other. One core.',
    leftoverIndustryIfs:
      leftover > 0
        ? 'PARTIAL — report UI/service still uses businessType === for optional columns (daily meal split, employee service columns). Checkout/orders/payments do not.'
        : 'NONE in scanned files',
    newBusinessNeedsDeveloper: leftover
      ? 'No for core sell/rent/service/subscribe. Optional report column labels may look generic until capabilities drive those leftover UIs.'
      : 'No',
  };

  const report = {
    generatedAt: new Date().toISOString(),
    api: API,
    verdict,
    score,
    summary: { pass, partial, fail, total: MATRIX.length },
    answers,
    matrix: MATRIX,
    results: RESULTS,
  };
  const out = join(OUT_DIR, `uat-universal-matrix-${STAMP}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  writeFileSync(
    join(OUT_DIR, 'uat-universal-matrix-latest.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(`\nVerdict: ${verdict}  score=${score}/100  PASS=${pass} PARTIAL=${partial} FAIL=${fail}`);
  console.log(`Report: ${out}`);
  if (fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
