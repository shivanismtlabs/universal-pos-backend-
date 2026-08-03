/**
 * Smoke new FRD APIs (billing, users list, reports, suppliers, retail).
 * Uses demo owner from env / defaults — same as smoke-roles.
 * Run: node scripts/smoke-new-apis.mjs
 */
import 'dotenv/config';

const BASE = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3001/v1';
const OWNER = {
  tenantSlug: process.env.SMOKE_TENANT ?? 'demo-shop',
  email: process.env.SMOKE_OWNER_EMAIL ?? 'owner@crown.demo',
  password: process.env.SMOKE_OWNER_PASSWORD ?? 'WalitShop@2026',
};

async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json, data: json?.data };
}

function ok(status) {
  return status >= 200 && status < 300;
}

async function main() {
  console.log(`\nNew API smoke → ${BASE}\n`);
  const login = await api('POST', '/auth/login', { body: OWNER });
  if (!ok(login.status) || !login.data?.accessToken) {
    console.error('Login failed', login.status, login.json?.message);
    process.exit(1);
  }
  const t = login.data.accessToken;
  const results = [];

  const checks = [
    ['GET', '/users'],
    ['GET', '/reports/sales-summary'],
    ['GET', '/reports/balances'],
    ['GET', '/reports/inventory-utilization'],
    ['GET', '/suppliers'],
    ['GET', '/purchase-orders'],
    ['GET', '/retail-skus?limit=5'],
    ['GET', '/platform-billing/plans'],
    ['GET', '/platform-billing/subscription'],
  ];

  const orders = await api('GET', '/orders?limit=1', { token: t });
  const oid = orders.data?.items?.[0]?.id;
  if (oid) {
    checks.push(
      ['GET', `/orders/${oid}/fees`],
      ['GET', `/orders/${oid}/layaway`],
      ['GET', `/orders/${oid}/invoices`],
      ['GET', `/documents?orderId=${oid}`],
    );
  }

  for (const [method, path] of checks) {
    const r = await api(method, path, { token: t });
    const pass = ok(r.status);
    results.push(pass);
    console.log(
      `${pass ? 'PASS' : 'FAIL'}  ${r.status} ${method} ${path}${
        pass ? '' : ` — ${JSON.stringify(r.json?.message ?? r.json)}`
      }`,
    );
  }

  // Create supplier + PO (write path)
  const supplier = await api('POST', '/suppliers', {
    token: t,
    body: { name: `Smoke Supplier ${Date.now()}`, phone: '9000000001' },
  });
  const supplierOk = ok(supplier.status);
  results.push(supplierOk);
  console.log(
    `${supplierOk ? 'PASS' : 'FAIL'}  ${supplier.status} POST /suppliers`,
  );

  if (supplier.data?.id) {
    const po = await api('POST', '/purchase-orders', {
      token: t,
      body: {
        supplierId: supplier.data.id,
        poType: 'sub_rental',
        expectedDelivery: new Date(Date.now() + 86400000 * 3)
          .toISOString()
          .slice(0, 10),
      },
    });
    const poOk = ok(po.status);
    results.push(poOk);
    console.log(
      `${poOk ? 'PASS' : 'FAIL'}  ${po.status} POST /purchase-orders`,
    );
  }

  if (oid) {
    const inv = await api('POST', `/orders/${oid}/invoices`, {
      token: t,
      body: { placeOfSupply: 'Maharashtra' },
    });
    const invOk = ok(inv.status);
    results.push(invOk);
    console.log(
      `${invOk ? 'PASS' : 'FAIL'}  ${inv.status} POST /orders/:id/invoices${
        invOk ? ` — ${inv.data?.invoiceNumber ?? ''}` : ` — ${JSON.stringify(inv.json?.message)}`
      }`,
    );
  }

  const failed = results.filter((x) => !x).length;
  console.log(`\n======== NEW API SUMMARY ========`);
  console.log(`Passed: ${results.length - failed}`);
  console.log(`Failed: ${failed}`);
  console.log('=================================\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
