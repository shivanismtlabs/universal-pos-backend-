/**
 * Owner vs employee (+ cross-tenant isolation) smoke test.
 * Run: node scripts/smoke-roles.mjs
 */
import 'dotenv/config';

const BASE = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3001/v1';

const OWNER = {
  tenantSlug: 'demo-shop',
  email: 'owner@demo.shop',
  password: 'WalitShop@2026',
};
const CASHIER = {
  tenantSlug: 'demo-shop',
  email: 'cashier@demo.shop',
  password: 'WalitShop@2026',
};

const results = [];
function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

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

async function login(creds) {
  const r = await api('POST', '/auth/login', { body: creds });
  if (r.status !== 200 || !r.data?.accessToken) {
    throw new Error(`login failed ${creds.email}: ${r.status} ${JSON.stringify(r.json?.message)}`);
  }
  return r.data;
}

async function main() {
  console.log(`\nRole / tenant smoke → ${BASE}\n`);

  // ── Owner login ──────────────────────────────────────────────────────────
  let owner;
  try {
    owner = await login(OWNER);
    pass(
      'Owner login',
      `roles=${JSON.stringify(owner.user?.roles ?? owner.roles)} tenant=${owner.user?.tenantId?.slice(0, 8)}…`,
    );
  } catch (e) {
    fail('Owner login', e.message);
    process.exit(1);
  }
  const ownerToken = owner.accessToken;
  const ownerTenantId = owner.user.tenantId;
  const ownerRoles = owner.user.roles ?? [];

  if (ownerRoles.includes('admin')) pass('Owner has admin role');
  else fail('Owner has admin role', String(ownerRoles));

  // ── Cashier / employee login (same tenant) ───────────────────────────────
  let cashier;
  try {
    cashier = await login(CASHIER);
    pass(
      'Employee (cashier) login',
      `roles=${JSON.stringify(cashier.user?.roles)} tenant=${cashier.user?.tenantId?.slice(0, 8)}…`,
    );
  } catch (e) {
    fail('Employee (cashier) login', e.message);
    console.log('\nHint: re-seed demo shop — npm run db:seed\n');
    process.exit(1);
  }
  const cashierToken = cashier.accessToken;
  const cashierTenantId = cashier.user.tenantId;
  const cashierRoles = cashier.user.roles ?? [];

  if (cashierRoles.includes('cashier')) pass('Employee has cashier role');
  else fail('Employee has cashier role', String(cashierRoles));

  if (ownerTenantId === cashierTenantId) {
    pass('Owner + employee share same tenant');
  } else {
    fail('Owner + employee share same tenant', `${ownerTenantId} vs ${cashierTenantId}`);
  }

  // ── Same-tenant data access ──────────────────────────────────────────────
  const ownerCustomers = await api('GET', '/customers?limit=5', { token: ownerToken });
  const cashierCustomers = await api('GET', '/customers?limit=5', {
    token: cashierToken,
  });
  if (ownerCustomers.status === 200) pass('Owner can list customers');
  else fail('Owner can list customers', String(ownerCustomers.status));

  if (cashierCustomers.status === 200) {
    pass('Employee can list customers (same shop)');
  } else {
    fail('Employee can list customers', `${cashierCustomers.status} ${JSON.stringify(cashierCustomers.json?.message)}`);
  }

  const ownerOrders = await api('GET', '/orders?limit=5', { token: ownerToken });
  const cashierOrders = await api('GET', '/orders?limit=5', { token: cashierToken });
  if (ownerOrders.status === 200) pass('Owner can list orders');
  else fail('Owner can list orders', String(ownerOrders.status));
  if (cashierOrders.status === 200) pass('Employee can list orders');
  else fail('Employee can list orders', String(cashierOrders.status));

  const cashierPos = await api('GET', '/payments/stripe/config', {
    token: cashierToken,
  });
  if (cashierPos.status === 200) pass('Employee can open POS payment config');
  else fail('Employee can open POS payment config', String(cashierPos.status));

  // ── Sensitive actions: refund + staff invite (admin/manager only) ─────────
  const payments = await api('GET', '/payments?limit=5', { token: ownerToken });
  const refundable = (payments.data?.items ?? []).find(
    (p) =>
      p.status === 'succeeded' &&
      (p.type === 'payment' || p.type === 'deposit'),
  );

  if (refundable?.id) {
    const cashierRefund = await api('POST', `/payments/${refundable.id}/refund`, {
      token: cashierToken,
      body: {
        amount: 1,
        idempotencyKey: `smoke-refund-cashier-${Date.now()}`,
        reason: 'should fail',
      },
    });
    if (cashierRefund.status === 403) {
      pass('Employee blocked from refund (admin/manager only)');
    } else {
      fail(
        'Employee blocked from refund',
        `expected 403 got ${cashierRefund.status}`,
      );
    }

    const ownerRefundProbe = await api('POST', `/payments/${refundable.id}/refund`, {
      token: ownerToken,
      body: {
        amount: 0.01,
        idempotencyKey: `smoke-refund-owner-probe-${Date.now()}`,
        reason: 'role probe — tiny amount',
      },
    });
    // 200/201 = allowed; 400 may mean amount/validation but NOT forbidden
    if (ownerRefundProbe.status !== 403) {
      pass(
        'Owner allowed to attempt refund (not 403)',
        `status=${ownerRefundProbe.status}`,
      );
    } else {
      fail('Owner allowed to attempt refund', 'got 403');
    }
  } else {
    pass('Refund role check skipped (no succeeded payment in demo)');
  }

  const cashierCreateUser = await api('POST', '/users', {
    token: cashierToken,
    body: {
      email: `blocked-${Date.now()}@demo.shop`,
      fullName: 'Should Block',
      password: 'BlockedUser@2026',
      roleCode: 'cashier',
    },
  });
  if (cashierCreateUser.status === 403) {
    pass('Employee blocked from creating staff');
  } else {
    fail(
      'Employee blocked from creating staff',
      `expected 403 got ${cashierCreateUser.status}`,
    );
  }

  const ownerCreateUser = await api('POST', '/users', {
    token: ownerToken,
    body: {
      email: `fitter-${Date.now()}@demo.shop`,
      fullName: 'Smoke Fitter',
      password: 'FitterUser@2026',
      roleCode: 'fitter',
    },
  });
  if (ownerCreateUser.status === 201 || ownerCreateUser.status === 200) {
    pass('Owner can create staff user');
  } else {
    fail(
      'Owner can create staff user',
      `${ownerCreateUser.status} ${JSON.stringify(ownerCreateUser.json?.message)}`,
    );
  }

  const cashierListUsers = await api('GET', '/users', { token: cashierToken });
  if (cashierListUsers.status === 200) {
    pass('Employee can list staff (shop roster — read allowed)');
  } else {
    fail('Employee can list staff', String(cashierListUsers.status));
  }

  // Admin-only: patch tenant
  const cashierPatchTenant = await api('PATCH', '/tenants/me', {
    token: cashierToken,
    body: { name: 'Should Not Change' },
  });
  if (cashierPatchTenant.status === 403) {
    pass('Employee blocked from PATCH /tenants/me (admin only)');
  } else {
    fail(
      'Employee blocked from PATCH /tenants/me',
      `expected 403 got ${cashierPatchTenant.status}`,
    );
  }

  const ownerPatchTenant = await api('PATCH', '/tenants/me', {
    token: ownerToken,
    body: { name: 'Demo Style' },
  });
  if (ownerPatchTenant.status === 200) pass('Owner can PATCH /tenants/me');
  else {
    fail(
      'Owner can PATCH /tenants/me',
      `${ownerPatchTenant.status} ${JSON.stringify(ownerPatchTenant.json?.message)}`,
    );
  }

  // Employee creates a customer in own tenant
  const phone = `9${String(Date.now()).slice(-9)}`;
  const created = await api('POST', '/customers', {
    token: cashierToken,
    body: {
      fullName: 'Cashier Created Guest',
      phone,
      marketingOptIn: false,
    },
  });
  if (created.status === 201 || created.status === 200) {
    pass('Employee can create customer');
  } else {
    fail(
      'Employee can create customer',
      `${created.status} ${JSON.stringify(created.json?.message)}`,
    );
  }

  // Owner sees that customer
  if (created.data?.id) {
    const seen = await api('GET', `/customers/${created.data.id}`, {
      token: ownerToken,
    });
    if (seen.status === 200) pass('Owner can see employee-created customer');
    else fail('Owner can see employee-created customer', String(seen.status));
  }

  // ── Second tenant isolation ──────────────────────────────────────────────
  const slug = `smoke-shop-${Date.now().toString(36)}`;
  const reg = await api('POST', '/auth/register-tenant', {
    body: {
      tenantName: 'Smoke Isolation Shop',
      tenantSlug: slug,
      storeName: 'Main',
      adminFullName: 'Other Owner',
      adminEmail: `owner@${slug}.com`,
      adminPassword: 'OtherShop@2026!',
    },
  });

  if (reg.status === 201 || reg.status === 200) {
    pass('Register second tenant (other company)', slug);
    const otherToken = reg.data.accessToken;
    const otherTenantId = reg.data.user?.tenantId ?? reg.data.tenant?.id;

    if (otherTenantId && otherTenantId !== ownerTenantId) {
      pass('Second tenant has different tenantId');
    } else {
      fail('Second tenant has different tenantId');
    }

    // Other owner lists customers — should not include demo-shop phones / or empty of demo data
    const otherCustomers = await api('GET', '/customers?limit=50', {
      token: otherToken,
    });
    const leaked = (otherCustomers.data?.items ?? []).some(
      (c) => c.phone === '9811111111' || c.phone === phone,
    );
    if (otherCustomers.status === 200 && !leaked) {
      pass('Other company cannot see demo-shop customers');
    } else {
      fail(
        'Other company cannot see demo-shop customers',
        leaked ? 'LEAKED customer from demo-shop' : String(otherCustomers.status),
      );
    }

    // Demo cashier must not read other tenant customer if we create one there
    const otherCust = await api('POST', '/customers', {
      token: otherToken,
      body: {
        fullName: 'Secret Other Shop Client',
        phone: `8${String(Date.now()).slice(-9)}`,
        marketingOptIn: false,
      },
    });
    if (otherCust.data?.id) {
      const sneak = await api('GET', `/customers/${otherCust.data.id}`, {
        token: cashierToken,
      });
      if (sneak.status === 404 || sneak.status === 403) {
        pass('Demo employee cannot read other-tenant customer');
      } else {
        fail(
          'Demo employee cannot read other-tenant customer',
          `expected 404/403 got ${sneak.status}`,
        );
      }
    }
  } else {
    fail(
      'Register second tenant',
      `${reg.status} ${JSON.stringify(reg.json?.message)}`,
    );
  }

  // Me endpoints
  const ownerMe = await api('GET', '/auth/me', { token: ownerToken });
  const cashierMe = await api('GET', '/auth/me', { token: cashierToken });
  if (ownerMe.data?.email === OWNER.email) pass('Owner /auth/me email');
  else fail('Owner /auth/me email', ownerMe.data?.email);
  if (cashierMe.data?.email === CASHIER.email) pass('Employee /auth/me email');
  else fail('Employee /auth/me email', cashierMe.data?.email);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n======== ROLE SUMMARY ========`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log('==============================\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
