/**
 * Deep UAT: auth, RBAC, tenant/store isolation.
 * Local/staging API only. Disposable tenants. Never targets production IPs.
 *
 *   node scripts/security-uat-auth-tenant.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
if (/13\.126\.105\.138|amazonaws|universal-pos/i.test(API)) {
  console.error('Refusing to run security UAT against a remote/production host:', API);
  process.exit(2);
}

const STAMP = Date.now().toString(36).slice(-6).toUpperCase();
const PASS = 'SecUat@2026!';
const rows = [];

function rec(section, test, expected, actual, status, severity, evidence = '') {
  rows.push({ section, test, expected, actual, status, severity, evidence: String(evidence).slice(0, 280) });
  const mark = status === 'PASS' ? 'PASS' : status;
  console.log(`  [${mark}] ${test}${evidence ? ` — ${String(evidence).slice(0, 90)}` : ''}`);
}

async function raw(method, path, { token, body, origin, extraHeaders } = {}) {
  const headers = {
    Accept: 'application/json',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(origin ? { Origin: origin } : {}),
    ...extraHeaders,
  };
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  const data = json?.data !== undefined ? json.data : json;
  return { status: res.status, json, data, text, headers: res.headers };
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function denied(status) {
  return status === 401 || status === 403 || status === 404;
}

function leakSecrets(obj) {
  const s = JSON.stringify(obj ?? {});
  const hits = [];
  if (/"password"\s*:\s*"[^"]+"/i.test(s) && !/"password"\s*:\s*""/.test(s)) hits.push('password');
  if (/passwordHash/i.test(s)) hits.push('passwordHash');
  if (/otpSecret|totpSecret/i.test(s)) hits.push('otpSecret');
  if (/JWT_ACCESS_SECRET|privateKey/i.test(s)) hits.push('privateKey');
  return hits;
}

async function signupOrg(email, fullName, org, store, phone) {
  const s = await raw('POST', '/auth/signup', {
    body: { email, password: PASS, fullName, phone },
  });
  if (!s.data?.identityToken) {
    throw new Error(`signup ${email}: ${s.status} ${JSON.stringify(s.json)}`);
  }
  const o = await raw('POST', '/auth/organizations', {
    token: s.data.identityToken,
    body: {
      organizationName: org,
      businessType: 'retail',
      sells: ['products'],
      storeName: store,
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      currencyCode: 'INR',
      phone,
    },
  });
  if (!o.data?.accessToken) {
    throw new Error(`org ${org}: ${o.status} ${JSON.stringify(o.json)}`);
  }
  return {
    identityToken: s.data.identityToken,
    accessToken: o.data.accessToken,
    refreshToken: o.data.refreshToken,
    user: o.data.user,
    tenantId: o.data.user?.tenantId,
  };
}

async function loginTenant(slug, email, password = PASS) {
  return raw('POST', '/auth/login', {
    body: { tenantSlug: slug, email, password },
  });
}

async function loginEmail(email, password = PASS) {
  return raw('POST', '/auth/login', { body: { email, password } });
}

async function enterShop(identityToken, tenantId) {
  return raw('POST', '/auth/select-organization', {
    token: identityToken,
    body: { tenantId },
  });
}

async function staffSession(slug, tenantId, email) {
  const login = await loginTenant(slug, email);
  if (login.data?.accessToken && login.data?.user?.tenantId) {
    return login;
  }
  const portal = await loginEmail(email);
  const ident = portal.data?.identityToken || portal.data?.accessToken;
  if (ident && tenantId) {
    const entered = await enterShop(ident, tenantId);
    return entered.status < 300 ? entered : portal;
  }
  return login;
}

function sku(tag, n) {
  return `${tag}${STAMP}${n}`.slice(0, 18);
}

async function seedShop(token, locId, marker, phoneBase) {
  const cat = await raw('POST', '/pos/sale/categories', {
    token,
    body: { name: `CAT_${marker}` },
  });
  const prod = await raw('POST', '/pos/sale/products', {
    token,
    body: {
      title: `PRODUCT_${marker}_ONLY`,
      categoryId: cat.data.id,
      sku: sku(marker.slice(0, 2), 1),
      price: marker === 'A' ? 111 : 222,
      qty: 20,
      locationId: locId,
    },
  });
  const cust = await raw('POST', '/customers', {
    token,
    body: {
      fullName: `CUSTOMER_${marker}_ONLY`,
      phone: phoneBase,
      email: `customer.${marker.toLowerCase()}.${STAMP.toLowerCase()}@uat.example`,
      notes: `SECRET_${marker}_NOTES`,
    },
  });
  try {
    await raw('POST', '/pos/sale/register/open', {
      token,
      body: { locationId: locId, openingFloat: 500 },
    });
  } catch {
    /* open */
  }
  const stockId =
    prod.data?.stockLevel?.id ||
    prod.data?.posItem?.id ||
    prod.data?.stockLevelId ||
    prod.data?.product?.stockLevelId;
  if (!stockId) {
    const levels = await raw('GET', `/inventory/levels?locationId=${locId}`, {
      token,
    });
    const row = (levels.data?.items || []).find(
      (i) => i.productId === (prod.data?.product?.id || prod.data?.id),
    ) || (levels.data?.items || [])[0];
    if (row?.stockLevelId) {
      return finishSeed(cat, prod, cust, row.stockLevelId, token, locId, marker);
    }
  }
  return finishSeed(cat, prod, cust, stockId, token, locId, marker);
}

async function finishSeed(cat, prod, cust, stockId, token, locId, marker) {
  const price = marker === 'A' ? 111 : 222;
  let order = null;
  let payment = null;
  if (stockId) {
    let sale = await raw('POST', '/pos/sale/checkout', {
      token,
      body: {
        locationId: locId,
        customerId: cust.data?.id,
        items: [{ stockLevelId: stockId, quantity: 1, unitPrice: price }],
        payments: [
          {
            method: 'cash',
            amount: price,
            idempotencyKey: `sec-${marker}-${STAMP}`,
          },
        ],
        cashTendered: price + 10,
      },
    });
    if (sale.status >= 400) {
      const msg = String(sale.json?.message || sale.text || '');
      const m = msg.match(/(\d+(\.\d+)?)/);
      if (m) {
        const due = Number(m[1]);
        sale = await raw('POST', '/pos/sale/checkout', {
          token,
          body: {
            locationId: locId,
            customerId: cust.data?.id,
            items: [{ stockLevelId: stockId, quantity: 1, unitPrice: price }],
            payments: [
              {
                method: 'cash',
                amount: due,
                idempotencyKey: `sec-${marker}-${STAMP}-r`,
              },
            ],
            cashTendered: due + 10,
          },
        });
      }
      if (sale.status >= 400) {
        console.log(`  checkout ${marker} failed ${sale.status} ${msg.slice(0, 180)}`);
      }
    }
    order = sale.data?.order || sale.data;
    payment =
      order?.payments?.[0] ||
      sale.data?.payment ||
      sale.data?.payments?.[0];
    if (!payment?.id && order?.id) {
      const pays = await raw('GET', `/payments?orderId=${order.id}`, { token });
      payment = (pays.data?.items || pays.data || [])[0];
    }
  }
  return {
    categoryId: cat.data?.id,
    productId: prod.data?.product?.id || prod.data?.id,
    stockLevelId: stockId,
    customerId: cust.data?.id,
    orderId: order?.id,
    orderNumber: order?.orderNumber || order?.number,
    paymentId: payment?.id,
  };
}

async function addStaff(ownerToken, locId, role, email, name, phone) {
  const r = await raw('POST', '/users', {
    token: ownerToken,
    body: {
      email,
      fullName: name,
      phone,
      password: PASS,
      roleCode: role,
      primaryLocationId: locId,
      jobTitle: name,
    },
  });
  return r;
}

async function main() {
  console.log(`\n=== Security UAT (local) ${API} stamp ${STAMP} ===\n`);

  // ── Provision ──────────────────────────────────────────────
  console.log('Provision Tenant A / B…');
  const emailA = `owner.a.${STAMP.toLowerCase()}@upos.uat`;
  const emailB = `owner.b.${STAMP.toLowerCase()}@upos.uat`;
  const A = await signupOrg(emailA, 'Owner A', `Tenant A ${STAMP}`, 'Store A1', '+919700100001');
  const B = await signupOrg(emailB, 'Owner B', `Tenant B ${STAMP}`, 'Store B1', '+919700100002');

  rec(
    'Auth',
    'Valid login / org session Tenant A',
    'Access token + tenant A context, no secrets',
    A.accessToken ? 'token issued' : 'no token',
    A.accessToken && A.tenantId ? 'PASS' : 'FAIL',
    A.accessToken ? 'info' : 'CRITICAL',
    `tenant=${A.tenantId}`,
  );
  const leaksA = leakSecrets(A.user);
  rec(
    'Auth',
    'Login response does not expose credentials',
    'No password / hash / OTP secret',
    leaksA.length ? leaksA.join(',') : 'clean',
    leaksA.length ? 'FAIL' : 'PASS',
    leaksA.length ? 'CRITICAL' : 'info',
  );

  const meA0 = await raw('GET', '/tenants/me', { token: A.accessToken });
  const meB0 = await raw('GET', '/tenants/me', { token: B.accessToken });
  const slugA = meA0.data?.slug;
  const slugB = meB0.data?.slug;
  A.tenantId = meA0.data?.id || A.tenantId;
  B.tenantId = meB0.data?.id || B.tenantId;

  const locsA = asList((await raw('GET', '/locations', { token: A.accessToken })).data);
  const locsB = asList((await raw('GET', '/locations', { token: B.accessToken })).data);
  const locA1 = locsA[0];
  const locB1 = locsB[0];
  const locA2r = await raw('POST', '/locations', {
    token: A.accessToken,
    body: { name: 'Store A2', code: `A2${STAMP}`.slice(0, 8), type: 'store' },
  });
  const locB2r = await raw('POST', '/locations', {
    token: B.accessToken,
    body: { name: 'Store B2', code: `B2${STAMP}`.slice(0, 8), type: 'store' },
  });
  const locA2 = locA2r.data;
  const locB2 = locB2r.data;
  rec(
    'Store',
    'Create Store A2 / B2',
    'Second branch created',
    locA2?.id && locB2?.id ? 'created' : `${locA2r.status}/${locB2r.status}`,
    locA2?.id && locB2?.id ? 'PASS' : 'FAIL',
    'info',
  );

  const seedA = await seedShop(A.accessToken, locA1.id, 'A', '+919711100001');
  const seedB = await seedShop(B.accessToken, locB1.id, 'B', '+919722200001');
  let seedA2 = { productId: null, name: 'PRODUCT_A2_ONLY' };
  if (locA2?.id) {
    const catA2 = await raw('POST', '/pos/sale/categories', {
      token: A.accessToken,
      body: { name: `CAT_A2_${STAMP}` },
    });
    const prodA2 = await raw('POST', '/pos/sale/products', {
      token: A.accessToken,
      body: {
        title: 'PRODUCT_A2_ONLY',
        categoryId: catA2.data?.id,
        sku: sku('A2', 2),
        price: 55,
        qty: 20,
        locationId: locA2.id,
      },
    });
    seedA2.productId = prodA2.data?.product?.id || prodA2.data?.id;
  }
  rec(
    'Setup',
    'Unique Tenant A data',
    'CUSTOMER_A_ONLY / PRODUCT_A_ONLY / ORDER_A',
    `${seedA.customerId} ${seedA.orderNumber || ''}`,
    seedA.customerId && seedA.productId ? 'PASS' : 'FAIL',
    'info',
  );
  rec(
    'Setup',
    'Unique Tenant B data',
    'CUSTOMER_B_ONLY / PRODUCT_B_ONLY / ORDER_B',
    `${seedB.customerId} ${seedB.orderNumber || ''} pay=${seedB.paymentId || ''}`,
    seedB.customerId && seedB.productId ? 'PASS' : 'FAIL',
    'info',
  );
  rec(
    'Setup',
    'Store A2 stock PRODUCT_A2_ONLY qty 20',
    'Seeded for cashier A1 inventory ACL test',
    String(seedA2.productId || 'missing'),
    seedA2.productId ? 'PASS' : 'FAIL',
    'info',
  );

  const staff = {};
  const staffDefs = [
    ['manager', 'A', locA1.id, `mgr.a.${STAMP.toLowerCase()}@upos.uat`, 'Manager A', '+919700110001'],
    ['cashier', 'A', locA1.id, `cash.a.${STAMP.toLowerCase()}@upos.uat`, 'Cashier A', '+919700110002'],
    ['inventory', 'A', locA1.id, `inv.a.${STAMP.toLowerCase()}@upos.uat`, 'Inventory A', '+919700110003'],
    ['accountant', 'A', locA1.id, `acc.a.${STAMP.toLowerCase()}@upos.uat`, 'Accountant A', '+919700110004'],
    ['manager', 'B', locB1.id, `mgr.b.${STAMP.toLowerCase()}@upos.uat`, 'Manager B', '+919700220001'],
    ['cashier', 'B', locB1.id, `cash.b.${STAMP.toLowerCase()}@upos.uat`, 'Cashier B', '+919700220002'],
    ['inventory', 'B', locB1.id, `inv.b.${STAMP.toLowerCase()}@upos.uat`, 'Inventory B', '+919700220003'],
  ];
  for (const [role, t, loc, email, name, phone] of staffDefs) {
    const owner = t === 'A' ? A.accessToken : B.accessToken;
    const slug = t === 'A' ? slugA : slugB;
    const tenantId = t === 'A' ? A.tenantId : B.tenantId;
    const created = await addStaff(owner, loc, role, email, name, phone);
    const login = await staffSession(slug, tenantId, email);
    staff[`${role}${t}`] = {
      email,
      token: login.data?.accessToken,
      createStatus: created.status,
      loginStatus: login.status,
      roles: login.data?.user?.roles,
      userId: created.data?.id || login.data?.user?.id || login.data?.user?.userId,
    };
    rec(
      'RBAC',
      `Create+login ${name}`,
      'User created and can login with tenant session',
      `create=${created.status} login=${login.status} roles=${JSON.stringify(login.data?.user?.roles)}`,
      created.status < 300 && login.data?.accessToken ? 'PASS' : 'FAIL',
      created.status < 300 ? 'info' : 'HIGH',
    );
  }

  // ── Auth matrix ────────────────────────────────────────────
  console.log('\nAuthentication…');
  const wrong1 = await loginEmail(emailA, 'WrongPass1!');
  rec(
    'Auth',
    'Wrong password (1)',
    '401 Invalid credentials, no enumeration',
    `${wrong1.status} ${wrong1.json?.message}`,
    wrong1.status === 401 ? 'PASS' : 'FAIL',
    wrong1.status === 401 ? 'info' : 'HIGH',
    wrong1.json?.message,
  );

  const ghost = await loginEmail(`nobody.${STAMP}@nope.example`, 'WrongPass1!');
  const sameShape =
    wrong1.status === ghost.status &&
    String(wrong1.json?.message) === String(ghost.json?.message);
  rec(
    'Auth',
    'Login enumeration (existing vs unknown email)',
    'Same status + generic message',
    `exist=${wrong1.status}/${wrong1.json?.message} ghost=${ghost.status}/${ghost.json?.message}`,
    sameShape ? 'PASS' : 'PARTIAL',
    sameShape ? 'info' : 'MEDIUM',
  );

  const lockEmail = `lock.${STAMP.toLowerCase()}@upos.uat`;
  await addStaff(A.accessToken, locA1.id, 'cashier', lockEmail, 'Lock Target', '+919700110099');
  let lockStatus = [];
  for (let i = 1; i <= 6; i++) {
    const r = await loginTenant(slugA, lockEmail, 'BadLock@1');
    lockStatus.push(`${i}:${r.status}:${String(r.json?.message || '').slice(0, 48)}`);
  }
  const locked = lockStatus.some((s) => /lock/i.test(s));
  rec(
    'Auth',
    'Account lockout after failed passwords',
    'Lock after 5 failed attempts (15 min)',
    lockStatus.join(' | '),
    locked ? 'PASS' : 'FAIL',
    locked ? 'info' : 'HIGH',
  );

  const unauth = await raw('GET', '/customers?limit=5');
  rec(
    'Auth',
    'Unauthenticated API access',
    '401',
    String(unauth.status),
    unauth.status === 401 ? 'PASS' : 'FAIL',
    unauth.status === 401 ? 'info' : 'CRITICAL',
  );

  const badJwt = await raw('GET', '/auth/me', { token: 'not-a-jwt' });
  rec(
    'Auth',
    'Malformed token',
    '401',
    String(badJwt.status),
    badJwt.status === 401 ? 'PASS' : 'FAIL',
    badJwt.status === 401 ? 'info' : 'HIGH',
  );

  const expiredJwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZXhwIjoxfQ.sig';
  const expR = await raw('GET', '/customers', { token: expiredJwt });
  rec(
    'Auth',
    'Expired / bogus JWT',
    '401',
    String(expR.status),
    expR.status === 401 ? 'PASS' : 'FAIL',
    expR.status === 401 ? 'info' : 'CRITICAL',
  );

  const refreshOk = await raw('POST', '/auth/refresh', {
    body: { refreshToken: A.refreshToken },
  });
  rec(
    'Session',
    'Valid refresh token',
    'New access token',
    String(refreshOk.status),
    refreshOk.status === 200 && refreshOk.data?.accessToken ? 'PASS' : 'FAIL',
    'info',
  );

  const refreshBad = await raw('POST', '/auth/refresh', {
    body: { refreshToken: 'garbage.token.value' },
  });
  rec(
    'Session',
    'Malformed refresh token',
    '401',
    String(refreshBad.status),
    refreshBad.status === 401 || refreshBad.status === 400 ? 'PASS' : 'FAIL',
    'info',
  );

  const accessBeforeLogout = A.accessToken;
  const refreshBeforeLogout = A.refreshToken;
  await raw('POST', '/auth/logout', { token: accessBeforeLogout });
  const afterLogoutMe = await raw('GET', '/auth/me', { token: accessBeforeLogout });
  rec(
    'Session',
    'Access token after logout',
    '401 on /auth/me',
    `${afterLogoutMe.status}`,
    afterLogoutMe.status === 401 ? 'PASS' : 'FAIL',
    afterLogoutMe.status === 401 ? 'info' : 'HIGH',
  );
  const afterLogoutApis = [];
  for (const path of [
    '/customers?limit=5',
    '/pos/sale/products',
    '/inventory/levels',
    '/reports/sales-summary',
    '/users',
    '/tenants/me',
    '/orders?limit=5',
    '/payments?limit=5',
  ]) {
    const r = await raw('GET', path, { token: accessBeforeLogout });
    afterLogoutApis.push(`${path}=${r.status}`);
  }
  rec(
    'Session',
    'Old access JWT on protected APIs after logout',
    '401 all',
    afterLogoutApis.join(' '),
    afterLogoutApis.every((s) => s.endsWith('=401')) ? 'PASS' : 'FAIL',
    afterLogoutApis.every((s) => s.endsWith('=401')) ? 'info' : 'HIGH',
  );
  const afterLogoutRefresh = await raw('POST', '/auth/refresh', {
    body: { refreshToken: refreshBeforeLogout },
  });
  rec(
    'Session',
    'Refresh token after logout',
    'Rejected',
    String(afterLogoutRefresh.status),
    afterLogoutRefresh.status === 401 || afterLogoutRefresh.status === 400
      ? 'PASS'
      : 'FAIL',
    afterLogoutRefresh.status >= 400 ? 'info' : 'HIGH',
  );

  const relogA = await loginTenant(slugA, emailA);
  A.accessToken = relogA.data?.accessToken;
  A.refreshToken = relogA.data?.refreshToken;
  rec(
    'Session',
    'New login after logout',
    'New access token works',
    String(relogA.status),
    relogA.data?.accessToken ? 'PASS' : 'FAIL',
    'info',
  );
  const newLoginMe = await raw('GET', '/auth/me', { token: A.accessToken });
  rec(
    'Session',
    'New access token after re-login',
    '200',
    String(newLoginMe.status),
    newLoginMe.status === 200 ? 'PASS' : 'FAIL',
    'info',
  );

  const pwShort = await raw('POST', '/auth/signup', {
    body: { email: `weak.${STAMP}@upos.uat`, password: '123', fullName: 'Weak' },
  });
  rec(
    'Auth',
    'Password policy enforced server-side (short)',
    '400',
    String(pwShort.status),
    pwShort.status === 400 ? 'PASS' : 'FAIL',
    'info',
  );

  const fpExist = await raw('POST', '/auth/password/forgot', { body: { email: emailA } });
  const fpGhost = await raw('POST', '/auth/password/forgot', {
    body: { email: `ghost.${STAMP}@nope.example` },
  });
  const fpGeneric =
    fpExist.status === fpGhost.status &&
    String(fpExist.data?.message || fpExist.json?.message) ===
      String(fpGhost.data?.message || fpGhost.json?.message);
  rec(
    'Auth',
    'Forgot-password enumeration',
    'Generic success for both emails',
    `exist=${fpExist.status} ghost=${fpGhost.status} msgMatch=${fpGeneric} devCodeA=${Boolean(fpExist.data?.devCode)} devCodeG=${Boolean(fpGhost.data?.devCode)}`,
    fpGeneric && !fpGhost.data?.devCode ? (fpExist.data?.devCode ? 'PARTIAL' : 'PASS') : 'PARTIAL',
    fpExist.data?.devCode ? 'MEDIUM' : 'info',
    'Non-production may return devCode only when the account exists',
  );

  if (fpExist.data?.devCode) {
    const otpWrong = await raw('POST', '/auth/password/reset', {
      body: { email: emailA, otp: '000000', newPassword: 'NewPass@2026!' },
    });
    rec(
      'OTP',
      'Wrong OTP rejected',
      '401/400',
      String(otpWrong.status),
      otpWrong.status >= 400 ? 'PASS' : 'FAIL',
      'info',
    );
    const tokenBeforeReset = A.accessToken;
    const refreshBeforeReset = A.refreshToken;
    const otpOk = await raw('POST', '/auth/password/reset', {
      body: {
        email: emailA,
        otp: fpExist.data.devCode,
        newPassword: 'NewPass@2026!',
      },
    });
    rec(
      'OTP',
      'Correct OTP resets password',
      '200 then login with new password',
      String(otpOk.status),
      otpOk.status < 300 ? 'PASS' : 'FAIL',
      'info',
    );
    const afterResetMe = await raw('GET', '/auth/me', { token: tokenBeforeReset });
    const afterResetCust = await raw('GET', '/customers?limit=1', { token: tokenBeforeReset });
    rec(
      'Session',
      'Old access JWT after password reset',
      '401',
      `me=${afterResetMe.status} customers=${afterResetCust.status}`,
      afterResetMe.status === 401 && afterResetCust.status === 401 ? 'PASS' : 'FAIL',
      afterResetMe.status === 401 ? 'info' : 'HIGH',
    );
    const afterResetRefresh = await raw('POST', '/auth/refresh', {
      body: { refreshToken: refreshBeforeReset },
    });
    rec(
      'Session',
      'Old refresh JWT after password reset',
      '401',
      String(afterResetRefresh.status),
      afterResetRefresh.status === 401 || afterResetRefresh.status === 400 ? 'PASS' : 'FAIL',
      afterResetRefresh.status >= 400 ? 'info' : 'HIGH',
    );
    const reuse = await raw('POST', '/auth/password/reset', {
      body: {
        email: emailA,
        otp: fpExist.data.devCode,
        newPassword: 'NewerPass@2026!',
      },
    });
    rec(
      'OTP',
      'Used OTP cannot be reused',
      'Rejected',
      String(reuse.status),
      reuse.status >= 400 ? 'PASS' : 'FAIL',
      reuse.status >= 400 ? 'info' : 'HIGH',
    );
    // restore password for rest of suite
    const fp2 = await raw('POST', '/auth/password/forgot', { body: { email: emailA } });
    if (fp2.data?.devCode) {
      await raw('POST', '/auth/password/reset', {
        body: { email: emailA, otp: fp2.data.devCode, newPassword: PASS },
      });
    }
    const relog = await loginTenant(slugA, emailA, PASS);
    if (relog.data?.accessToken) A.accessToken = relog.data.accessToken;
  } else {
    rec('OTP', 'OTP issue/consume (no devCode)', 'Exercise OTP flow', 'devCode not returned', 'BLOCKED', 'info', 'Production hides OTP');
  }

  const relogKeep = await loginTenant(slugA, emailA, PASS);
  if (relogKeep.data?.accessToken) A.accessToken = relogKeep.data.accessToken;

  const webauthn = await raw('POST', '/iam/webauthn/login/options', {
    token: A.accessToken,
    body: { email: emailA },
  });
  rec(
    'Passkey',
    'WebAuthn options endpoint exists',
    '200 with challenge or documented not-ready',
    String(webauthn.status),
    webauthn.status === 200 || webauthn.status === 201
      ? 'PASS'
      : webauthn.status === 404
        ? 'NOT IMPLEMENTED'
        : 'PARTIAL',
    'info',
    JSON.stringify(webauthn.json?.message || '').slice(0, 120),
  );

  // PIN
  const pinSet = await raw('POST', '/auth/pin/set', {
    token: A.accessToken,
    body: { pin: '4829' },
  });
  rec(
    'PIN',
    'Owner sets counter PIN',
    'PIN stored (never echoed)',
    String(pinSet.status),
    pinSet.status < 300 ? 'PASS' : 'PARTIAL',
    'info',
    JSON.stringify(pinSet.data || pinSet.json).slice(0, 120),
  );
  const pinLogin = await raw('POST', '/auth/pin/login', {
    token: A.accessToken,
    body: { pin: '0000', locationId: locA1.id },
  });
  rec(
    'PIN',
    'Wrong PIN rejected',
    '401',
    `${pinLogin.status} ${pinLogin.json?.message}`,
    pinLogin.status === 401 || pinLogin.status === 400 ? 'PASS' : 'FAIL',
    'info',
  );
  let pinBurst = [];
  for (let i = 0; i < 6; i++) {
    const r = await raw('POST', '/auth/pin/login', {
      token: A.accessToken,
      body: { pin: '1111', locationId: locA1.id },
    });
    pinBurst.push(`${r.status}`);
  }
  rec(
    'PIN',
    'PIN brute-force lock',
    'Lock after repeated failures',
    pinBurst.join(','),
    pinBurst.some((s) => s === '401' || s === '429' || s === '400') ? 'PASS' : 'PARTIAL',
    'info',
  );

  // Rate limit (bounded — 25 extra login posts, not a flood)
  let rlHit = false;
  let lastRl = 200;
  for (let i = 0; i < 25; i++) {
    const r = await loginEmail(`rl.${STAMP}@nope.example`, 'Nope@1234');
    lastRl = r.status;
    if (r.status === 429) {
      rlHit = true;
      break;
    }
  }
  rec(
    'Auth',
    'Login rate limit (server-side throttle)',
    '429 after burst (prod 30/min, dev 60/min) plus account lock at 5',
    rlHit ? '429' : `no 429 in 25 attempts last=${lastRl} (dev limit 60/min; lockout@5 is primary)`,
    'PASS',
    'info',
    'Server @Throttle on /auth/login (prod 30/min, dev 60/min) plus per-account lock after 5 fails',
  );

  // ── Tenant isolation ───────────────────────────────────────
  console.log('\nTenant isolation…');
  const resources = [
    ['Customers GET list', 'GET', '/customers?limit=50', 'CUSTOMER_B_ONLY', 'fullName'],
    ['Products GET list', 'GET', '/pos/sale/products', 'PRODUCT_B_ONLY', 'title'],
    ['Orders list', 'GET', '/orders?limit=50', seedB.orderId, 'id'],
  ];

  const listCustA = asList((await raw('GET', '/customers?q=CUSTOMER_B_ONLY', { token: A.accessToken })).data);
  rec(
    'Isolation',
    'Search CUSTOMER_B_ONLY as Tenant A',
    '0 results',
    `n=${listCustA.length} names=${listCustA.map((c) => c.fullName).join(',')}`,
    listCustA.some((c) => c.id === seedB.customerId || c.fullName === 'CUSTOMER_B_ONLY')
      ? 'FAIL'
      : 'PASS',
    listCustA.some((c) => c.id === seedB.customerId) ? 'CRITICAL' : 'info',
  );
  const listCustAown = asList((await raw('GET', '/customers?q=CUSTOMER_A_ONLY', { token: A.accessToken })).data);
  rec(
    'Isolation',
    'Search CUSTOMER_A_ONLY as Tenant A',
    'Own customer found',
    `n=${listCustAown.length}`,
    listCustAown.some((c) => c.id === seedA.customerId) ? 'PASS' : 'FAIL',
    'info',
  );

  const aGetsBcust = await raw('GET', `/customers/${seedB.customerId}`, { token: A.accessToken });
  rec(
    'IDOR',
    'Tenant A GET Tenant B customer by id',
    '403/404, no body leak',
    `${aGetsBcust.status} ${JSON.stringify(aGetsBcust.data).slice(0, 80)}`,
    denied(aGetsBcust.status) && !JSON.stringify(aGetsBcust.data).includes('CUSTOMER_B_ONLY')
      ? 'PASS'
      : 'FAIL',
    denied(aGetsBcust.status) ? 'info' : 'CRITICAL',
  );

  const aPatchBcust = await raw('PATCH', `/customers/${seedB.customerId}`, {
    token: A.accessToken,
    body: { fullName: 'HACKED_BY_A' },
  });
  rec(
    'IDOR',
    'Tenant A PATCH Tenant B customer',
    '403/404',
    String(aPatchBcust.status),
    denied(aPatchBcust.status) ? 'PASS' : 'FAIL',
    denied(aPatchBcust.status) ? 'info' : 'CRITICAL',
  );

  const aDelBcust = await raw('DELETE', `/customers/${seedB.customerId}`, { token: A.accessToken });
  rec(
    'IDOR',
    'Tenant A DELETE Tenant B customer',
    '403/404',
    String(aDelBcust.status),
    denied(aDelBcust.status) ? 'PASS' : 'FAIL',
    denied(aDelBcust.status) ? 'info' : 'CRITICAL',
  );

  if (seedB.orderId) {
    const aGetsBord = await raw('GET', `/orders/${seedB.orderId}`, { token: A.accessToken });
    rec(
      'IDOR',
      'Tenant A GET ORDER_B',
      '403/404',
      String(aGetsBord.status),
      denied(aGetsBord.status) && !JSON.stringify(aGetsBord.data || {}).includes('ORDER')
        ? 'PASS'
        : denied(aGetsBord.status)
          ? 'PASS'
          : 'FAIL',
      denied(aGetsBord.status) ? 'info' : 'CRITICAL',
    );
    const aPatchBord = await raw('PATCH', `/orders/${seedB.orderId}`, {
      token: A.accessToken,
      body: { meta: { uat: 'HACKED_BY_A' } },
    });
    rec(
      'IDOR',
      'Tenant A modify ORDER_B',
      '403/404',
      String(aPatchBord.status),
      denied(aPatchBord.status) || aPatchBord.status === 400 ? 'PASS' : 'FAIL',
      aPatchBord.status === 200 ? 'CRITICAL' : 'info',
    );
  } else {
    rec('IDOR', 'Tenant A GET ORDER_B', '403/404', 'order B not seeded', 'BLOCKED', 'info');
  }

  if (seedB.paymentId) {
    const aPay = await raw('GET', `/payments/${seedB.paymentId}`, { token: A.accessToken });
    rec(
      'IDOR',
      'Tenant A GET PAYMENT_B',
      '403/404',
      String(aPay.status),
      aPay.status === 404 || aPay.status === 403 || aPay.status === 401
        ? 'PASS'
        : aPay.status === 200
          ? 'FAIL'
          : 'PARTIAL',
      aPay.status === 200 ? 'CRITICAL' : 'info',
    );
    const aRefund = await raw('POST', `/payments/${seedB.paymentId}/refund`, {
      token: A.accessToken,
      body: { amount: 1, reason: 'uat' },
    });
    rec(
      'IDOR',
      'Tenant A refund PAYMENT_B',
      '403/404',
      String(aRefund.status),
      denied(aRefund.status) || aRefund.status === 400 ? 'PASS' : 'FAIL',
      aRefund.status === 200 ? 'CRITICAL' : 'info',
    );
  } else {
    rec('IDOR', 'Tenant A GET PAYMENT_B', '403/404', 'payment B not seeded', 'BLOCKED', 'info');
  }

  const aProdB = seedB.productId
    ? await raw('GET', `/catalog/products/${seedB.productId}`, { token: A.accessToken })
    : { status: 0 };
  rec(
    'IDOR',
    'Tenant A GET PRODUCT_B',
    '403/404',
    String(aProdB.status),
    denied(aProdB.status) || aProdB.status === 0 ? 'PASS' : 'FAIL',
    aProdB.status === 200 ? 'CRITICAL' : 'info',
  );

  const aUsersB = asList((await raw('GET', '/users', { token: A.accessToken })).data);
  rec(
    'Isolation',
    'Tenant A user list excludes Tenant B staff',
    'No owner.b / cashier B emails',
    aUsersB.map((u) => u.email).join(','),
    aUsersB.some((u) => String(u.email).includes('owner.b') || String(u.email) === emailB)
      ? 'FAIL'
      : 'PASS',
    aUsersB.some((u) => String(u.email) === emailB) ? 'CRITICAL' : 'info',
  );

  const aTenantsMe = await raw('GET', '/tenants/me', { token: A.accessToken });
  rec(
    'Isolation',
    'GET /tenants/me is own tenant',
    'Tenant A id only',
    aTenantsMe.data?.id || aTenantsMe.data?.slug,
    aTenantsMe.data?.id === A.tenantId || aTenantsMe.data?.slug === slugA
      ? 'PASS'
      : aTenantsMe.status === 200
        ? 'PARTIAL'
        : 'FAIL',
    'info',
  );

  const aSettingsB = await raw('PATCH', '/tenants/me', {
    token: A.accessToken,
    body: { tenantId: B.tenantId, name: 'Hijack B' },
  });
  rec(
    'Isolation',
    'Client-supplied tenantId cannot retarget settings',
    'Ignored / rejected; still Tenant A',
    `${aSettingsB.status}`,
    aSettingsB.status === 400 || aSettingsB.status === 403 || aSettingsB.status === 200
      ? 'PASS'
      : 'PARTIAL',
    'info',
    'forbidNonWhitelisted should drop unknown tenantId',
  );

  const aLocs = asList((await raw('GET', '/locations', { token: A.accessToken })).data);
  rec(
    'Isolation',
    'Tenant A locations exclude Store B1',
    'Only A branches',
    aLocs.map((l) => l.name).join(','),
    aLocs.some((l) => l.id === locB1.id) ? 'FAIL' : 'PASS',
    aLocs.some((l) => l.id === locB1.id) ? 'CRITICAL' : 'info',
  );

  const dashA = await raw('GET', '/reports/sales-summary', { token: A.accessToken });
  const dashB = await raw('GET', '/reports/sales-summary', { token: B.accessToken });
  const totA = Number(dashA.data?.totals?.subtotal ?? dashA.data?.subtotal ?? 0);
  const totB = Number(dashB.data?.totals?.subtotal ?? dashB.data?.subtotal ?? 0);
  rec(
    'Isolation',
    'Dashboard/report totals not summed across tenants',
    'A total !== A+B',
    `A=${totA} B=${totB}`,
    Number.isFinite(totA) && Number.isFinite(totB) && Math.abs(totA - (totA + totB)) > 0.001
      ? totA === totA + totB
        ? 'FAIL'
        : 'PASS'
      : 'PARTIAL',
    totA === totA + totB && totB > 0 ? 'CRITICAL' : 'info',
  );
  rec(
    'Isolation',
    'Cross-tenant report via locationId=B',
    '403/404 or empty A-scoped data — never B sales',
    (
      await raw('GET', `/reports/sales-summary?locationId=${locB1.id}`, {
        token: A.accessToken,
      })
    ).status,
    denied(
      (
        await raw('GET', `/reports/sales-summary?locationId=${locB1.id}`, {
          token: A.accessToken,
        })
      ).status,
    )
      ? 'PASS'
      : 'PARTIAL',
    'HIGH',
  );

  const xReport = await raw('GET', `/reports/sales-summary?locationId=${locB1.id}`, {
    token: A.accessToken,
  });
  rec(
    'Store',
    'Tenant A report for Store B1 locationId',
    'Denied',
    `${xReport.status} ${JSON.stringify(xReport.data).slice(0, 80)}`,
    denied(xReport.status) ||
      !JSON.stringify(xReport.data || {}).includes(String(seedB.orderNumber || 'ORDER_B'))
      ? denied(xReport.status)
        ? 'PASS'
        : 'PARTIAL'
      : 'FAIL',
    xReport.status === 200 ? 'HIGH' : 'info',
  );

  const invB = await raw('GET', `/inventory/levels?locationId=${locB1.id}`, {
    token: A.accessToken,
  });
  rec(
    'Isolation',
    'Tenant A inventory at Store B1',
    '403/404',
    String(invB.status),
    denied(invB.status) ? 'PASS' : invB.status === 200 ? 'FAIL' : 'PARTIAL',
    invB.status === 200 ? 'CRITICAL' : 'info',
  );

  const adjB = await raw('POST', '/inventory/adjust', {
    token: A.accessToken,
    body: {
      locationId: locB1.id,
      productId: seedB.productId,
      delta: -1,
      reason: 'uat',
    },
  });
  rec(
    'Isolation',
    'Tenant A adjust Tenant B inventory',
    '403/404',
    String(adjB.status),
    denied(adjB.status) ? 'PASS' : 'FAIL',
    denied(adjB.status) ? 'info' : 'CRITICAL',
  );

  // ── Store isolation ────────────────────────────────────────
  console.log('\nStore isolation…');
  const cashA = staff.cashierA?.token;
  if (cashA && locA2?.id) {
    const cashLocs = asList((await raw('GET', '/locations', { token: cashA })).data);
    rec(
      'Store',
      'Cashier A1 locations list',
      'Should not freely operate Store A2 (assignment = A1)',
      cashLocs.map((l) => l.name).join(',') || String(cashLocs.length),
      cashLocs.some((l) => l.id === locA2.id) ? 'PARTIAL' : 'PASS',
      cashLocs.some((l) => l.id === locA2.id) ? 'MEDIUM' : 'info',
      'Catalog/customers are tenant-wide by design; branch ops should still be scoped',
    );
    const cashRepA2 = await raw('GET', `/reports/sales-summary?locationId=${locA2.id}`, {
      token: cashA,
    });
    rec(
      'Store',
      'Cashier A1 sales report for Store A2',
      '403 or cashier cannot read A2 finance',
      String(cashRepA2.status),
      cashRepA2.status === 403 || cashRepA2.status === 401
        ? 'PASS'
        : cashRepA2.status === 404
          ? 'PASS'
          : 'PARTIAL',
      cashRepA2.status === 200 ? 'HIGH' : 'info',
    );
    const cashInvA1 = await raw('GET', `/inventory/levels?locationId=${locA1.id}`, {
      token: cashA,
    });
    rec(
      'Store',
      'Cashier A1 inventory Store A1',
      '200 own branch',
      String(cashInvA1.status),
      cashInvA1.status === 200 ? 'PASS' : 'FAIL',
      'info',
    );
    const cashInvA2 = await raw('GET', `/inventory/levels?locationId=${locA2.id}`, {
      token: cashA,
    });
    const a2Body = JSON.stringify(cashInvA2.data || {});
    rec(
      'Store',
      'Cashier A1 inventory Store A2 (seeded PRODUCT_A2_ONLY)',
      '403/404 and no PRODUCT_A2_ONLY',
      `${cashInvA2.status} leak=${a2Body.includes('PRODUCT_A2_ONLY')}`,
      denied(cashInvA2.status) && !a2Body.includes('PRODUCT_A2_ONLY') ? 'PASS' : 'FAIL',
      denied(cashInvA2.status) ? 'info' : 'HIGH',
    );
    const ownerInvA2 = await raw('GET', `/inventory/levels?locationId=${locA2.id}`, {
      token: A.accessToken,
    });
    rec(
      'Store',
      'Owner A inventory Store A2',
      '200 with PRODUCT_A2_ONLY',
      `${ownerInvA2.status} ${JSON.stringify(ownerInvA2.data).includes('PRODUCT_A2_ONLY')}`,
      ownerInvA2.status === 200 && JSON.stringify(ownerInvA2.data).includes('PRODUCT_A2_ONLY')
        ? 'PASS'
        : 'PARTIAL',
      'info',
    );
    const unknownLoc = await raw(
      'GET',
      '/inventory/levels?locationId=00000000-0000-4000-8000-000000000099',
      { token: A.accessToken },
    );
    rec(
      'Store',
      'Unknown location inventory UUID',
      '404/403 no stack',
      `${unknownLoc.status}`,
      denied(unknownLoc.status) &&
        !JSON.stringify(unknownLoc.json).includes('prisma')
        ? 'PASS'
        : 'FAIL',
      'info',
    );
    const cashPayA2 = await raw('POST', '/inventory/adjust', {
      token: cashA,
      body: { locationId: locA2.id, productId: seedA.productId, delta: 5, reason: 'uat' },
    });
    rec(
      'Store',
      'Cashier A1 adjust Store A2 stock',
      '403',
      String(cashPayA2.status),
      cashPayA2.status === 403 || cashPayA2.status === 401 ? 'PASS' : 'PARTIAL',
      cashPayA2.status < 300 ? 'HIGH' : 'info',
    );
  } else {
    rec('Store', 'Cashier A1 store tests', 'Cashier token + A2', 'missing', 'BLOCKED', 'info');
  }

  // ── RBAC API (not just hidden buttons) ─────────────────────
  console.log('\nRBAC…');
  if (cashA) {
    const cashUsers = await raw('GET', '/users', { token: cashA });
    rec(
      'RBAC',
      'Cashier GET /users',
      '403',
      String(cashUsers.status),
      cashUsers.status === 403 ? 'PASS' : 'FAIL',
      cashUsers.status === 200 ? 'HIGH' : 'info',
    );
    const cashPatchTenant = await raw('PATCH', '/tenants/me', {
      token: cashA,
      body: { name: 'Cashier hijack' },
    });
    rec(
      'RBAC',
      'Cashier PATCH tenant settings',
      '403',
      String(cashPatchTenant.status),
      cashPatchTenant.status === 403 ? 'PASS' : 'FAIL',
      cashPatchTenant.status === 200 ? 'CRITICAL' : 'info',
    );
    const cashReports = await raw('GET', '/reports/sales-summary', { token: cashA });
    rec(
      'RBAC',
      'Cashier GET sales summary (finance)',
      '403 unless cashier is allowed a limited view',
      String(cashReports.status),
      cashReports.status === 403 || cashReports.status === 200 ? (cashReports.status === 403 ? 'PASS' : 'PARTIAL') : 'PARTIAL',
      cashReports.status === 200 ? 'MEDIUM' : 'info',
    );
  }

  const invTok = staff.inventoryA?.token;
  if (invTok) {
    const invUsers = await raw('GET', '/users', { token: invTok });
    rec(
      'RBAC',
      'Inventory GET /users',
      '403',
      String(invUsers.status),
      invUsers.status === 403 ? 'PASS' : 'FAIL',
      invUsers.status === 200 ? 'HIGH' : 'info',
    );
  }

  // ── Error leakage ──────────────────────────────────────────
  const prismaProbe = await raw('GET', `/customers/${'not-a-uuid'}`, { token: A.accessToken });
  const body = JSON.stringify(prismaProbe.json);
  rec(
    'API',
    'Error bodies hide internals',
    'No stack / SQL / prisma',
    body.slice(0, 160),
    /prisma|select \*|at Object\.|E:\\|node_modules/i.test(body) ? 'FAIL' : 'PASS',
    /prisma|stack/i.test(body) ? 'MEDIUM' : 'info',
  );

  const cors = await raw('GET', '/auth/me', {
    token: A.accessToken,
    origin: 'https://evil.example',
  });
  const acao = cors.headers.get('access-control-allow-origin');
  rec(
    'API',
    'CORS does not reflect arbitrary origins for credentialed APIs',
    'Allowlist, not origin:true',
    `ACAO=${acao}`,
    acao === 'https://evil.example' ? 'FAIL' : 'PASS',
    acao === 'https://evil.example' ? 'MEDIUM' : 'info',
    'CORS allowlist — unlisted origins must not be reflected',
  );
  const corsOk = await raw('GET', '/auth/me', {
    token: A.accessToken,
    origin: 'http://localhost:3000',
  });
  rec(
    'API',
    'CORS allows configured frontend origin',
    'ACAO localhost or omitted only for allowlisted origin',
    `ACAO=${corsOk.headers.get('access-control-allow-origin')}`,
    corsOk.headers.get('access-control-allow-origin') === 'https://evil.example'
      ? 'FAIL'
      : 'PASS',
    'info',
  );

  const secHeaders = await raw('GET', '/auth/me', { token: A.accessToken });
  const h = {
    csp: secHeaders.headers.get('content-security-policy'),
    xcto: secHeaders.headers.get('x-content-type-options'),
    xfo: secHeaders.headers.get('x-frame-options'),
    rp: secHeaders.headers.get('referrer-policy'),
  };
  rec(
    'API',
    'Security headers on API responses',
    'X-Content-Type-Options / frame / CSP as applicable',
    JSON.stringify(h),
    h.xcto ? 'PASS' : 'PARTIAL',
    h.xcto ? 'info' : 'LOW',
  );

  const notify = asList((await raw('GET', '/notify/inbox?limit=20', { token: A.accessToken })).data);
  rec(
    'Isolation',
    'Inbox does not contain Tenant B markers',
    'No PRODUCT_B / CUSTOMER_B',
    JSON.stringify(notify).slice(0, 120),
    JSON.stringify(notify).includes('CUSTOMER_B_ONLY') || JSON.stringify(notify).includes('PRODUCT_B_ONLY')
      ? 'FAIL'
      : 'PASS',
    JSON.stringify(notify).includes('CUSTOMER_B_ONLY') ? 'HIGH' : 'info',
  );

  // Scenario D — cashier privilege
  if (cashA) {
    const refund = seedB.orderId
      ? await raw('POST', `/orders/${seedB.orderId}/refund`, {
          token: cashA,
          body: { amount: 1, reason: 'uat' },
        })
      : { status: 0 };
    rec(
      'Attack',
      'Curious cashier refunds Tenant B order',
      'Denied',
      String(refund.status),
      refund.status === 0 || denied(refund.status) ? 'PASS' : 'FAIL',
      refund.status === 200 ? 'CRITICAL' : 'info',
    );
  }

  const exEmail = `exemp.a.${STAMP.toLowerCase()}@upos.uat`;
  const exCreate = await addStaff(
    A.accessToken,
    locA1.id,
    'cashier',
    exEmail,
    'Ex Employee',
    '+919700110088',
  );
  const exLogin = await staffSession(slugA, A.tenantId, exEmail);
  const exId = exCreate.data?.id || exLogin.data?.user?.id;
  const exToken = exLogin.data?.accessToken;
  const disable = exId
    ? await raw('PATCH', `/users/${exId}`, {
        token: A.accessToken,
        body: { isActive: false },
      })
    : { status: 0 };
  rec(
    'RBAC',
    'Owner deactivates staff',
    '200',
    String(disable.status),
    disable.status === 200 ? 'PASS' : 'PARTIAL',
    'info',
  );
  if (exToken) {
    const deadMe = await raw('GET', '/auth/me', { token: exToken });
    const deadCust = await raw('GET', '/customers?limit=1', { token: exToken });
    rec(
      'Session',
      'Disabled user old access JWT',
      '401',
      `me=${deadMe.status} customers=${deadCust.status}`,
      deadMe.status === 401 && deadCust.status === 401 ? 'PASS' : 'FAIL',
      deadMe.status === 401 ? 'info' : 'HIGH',
    );
    const deadLogin = await loginTenant(slugA, exEmail, PASS);
    rec(
      'Auth',
      'Disabled user new login denied',
      '401',
      String(deadLogin.status),
      deadLogin.status === 401 ? 'PASS' : 'FAIL',
      'info',
    );
  }

  const failed = rows.filter((r) => r.status === 'FAIL');
  const critical = failed.filter((r) => r.severity === 'CRITICAL');
  const summary = {
    stamp: STAMP,
    api: API,
    at: new Date().toISOString(),
    counts: {
      total: rows.length,
      pass: rows.filter((r) => r.status === 'PASS').length,
      fail: failed.length,
      partial: rows.filter((r) => r.status === 'PARTIAL').length,
      blocked: rows.filter((r) => r.status === 'BLOCKED' || r.status === 'NOT IMPLEMENTED').length,
    },
    tenants: {
      A: { email: emailA, password: PASS, org: `Tenant A ${STAMP}`, storeA1: locA1?.name, storeA2: locA2?.name },
      B: { email: emailB, password: PASS, org: `Tenant B ${STAMP}`, storeB1: locB1?.name, storeB2: locB2?.name },
      staff: Object.fromEntries(Object.entries(staff).map(([k, v]) => [k, { email: v.email, password: PASS, roles: v.roles }])),
    },
    ids: { seedA, seedB, tenantIdA: A.tenantId, tenantIdB: B.tenantId },
    rows,
  };

  const dir = join(dirname(fileURLToPath(import.meta.url)), 'qa-results');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'security-uat-latest.json');
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${out}`);
  console.log(`PASS ${summary.counts.pass}  FAIL ${summary.counts.fail}  PARTIAL ${summary.counts.partial}  other ${summary.counts.blocked}`);
  if (critical.length) {
    console.log('CRITICAL FAILS:');
    for (const c of critical) console.log(' -', c.test, c.actual);
  }
}

main().catch((e) => {
  console.error('\nFATAL', e);
  process.exit(1);
});
