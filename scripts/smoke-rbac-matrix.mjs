/**
 * Multi-role access matrix smoke.
 * Run: node scripts/smoke-rbac-matrix.mjs
 */
import 'dotenv/config';

const BASE = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3001/v1';
const PASS = process.env.SMOKE_OWNER_PASSWORD ?? 'WalitShop@2026';

const users = [
  { email: 'owner@demo.shop', role: 'admin' },
  { email: 'manager@demo.shop', role: 'manager' },
  { email: 'cashier@demo.shop', role: 'cashier' },
  { email: 'fitter@demo.shop', role: 'fitter' },
  { email: 'stock@demo.shop', role: 'inventory' },
];

/** path → roles that MUST succeed (others MUST get 403) */
const matrix = [
  { method: 'GET', path: '/reports/sales-summary', allow: ['admin', 'manager'] },
  { method: 'GET', path: '/users', allow: ['admin', 'manager'] },
  { method: 'GET', path: '/pos/orders/00000000-0000-0000-0000-000000000001/receipt', allow: ['admin', 'manager', 'cashier'], soft404: true },
  { method: 'GET', path: '/platform-billing/plans', allow: ['admin'] },
  { method: 'GET', path: '/suppliers', allow: ['admin', 'manager', 'inventory'] },
  { method: 'GET', path: '/appointments?limit=1', allow: ['admin', 'manager', 'cashier', 'fitter'] },
  { method: 'GET', path: '/customers?limit=1', allow: ['admin', 'manager', 'cashier', 'fitter'] },
  { method: 'GET', path: '/inventory-units?limit=1', allow: ['admin', 'manager', 'cashier', 'fitter', 'inventory'] },
  { method: 'POST', path: '/categories', allow: ['admin', 'manager', 'inventory'], body: { name: `RBAC ${Date.now()}` } },
];

async function api(method, path, token, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

async function login(email) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantSlug: 'demo-shop',
      email,
      password: PASS,
    }),
  });
  const json = await res.json();
  if (!json?.data?.accessToken) {
    throw new Error(`login ${email}: ${res.status}`);
  }
  return { token: json.data.accessToken, roles: json.data.user?.roles ?? [] };
}

async function main() {
  console.log(`\nRBAC matrix smoke → ${BASE}\n`);
  const tokens = {};
  for (const u of users) {
    const s = await login(u.email);
    tokens[u.role] = s.token;
    const ok = s.roles.includes(u.role);
    console.log(`${ok ? 'PASS' : 'FAIL'}  login ${u.email} roles=${JSON.stringify(s.roles)}`);
    if (!ok) process.exit(1);
  }

  let failed = 0;
  for (const row of matrix) {
    for (const u of users) {
      const status = await api(row.method, row.path, tokens[u.role], row.body);
      const shouldAllow = row.allow.includes(u.role);
      const allowed =
        (status >= 200 && status < 300) ||
        (row.soft404 && (status === 404 || status === 400)) ||
        (shouldAllow && status === 409);
      const denied = status === 403;
      const ok = shouldAllow ? allowed : denied;
      if (!ok) {
        failed += 1;
        console.log(
          `FAIL  ${u.role} ${row.method} ${row.path} → ${status} (expect ${shouldAllow ? '2xx' : '403'})`,
        );
      } else {
        console.log(
          `PASS  ${u.role} ${row.method} ${row.path} → ${status}`,
        );
      }
    }
  }

  console.log(`\n======== RBAC MATRIX ========`);
  console.log(`Failed: ${failed}`);
  console.log('=============================\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
