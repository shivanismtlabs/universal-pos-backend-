/**
 * Multi-business-type isolation smoke (local API).
 * Usage: node scripts/multi-business-type-smoke.mjs
 */
const API = process.env.API_URL || 'http://127.0.0.1:3001/v1';

const PROFILES = [
  {
    type: 'retail',
    expectModes: ['sale'],
    mustHave: ['INVENTORY', 'BARCODE'],
    mustNot: ['KOT', 'TABLE', 'REPAIR_JOB'],
  },
  {
    type: 'grocery',
    expectModes: ['sale'],
    mustHave: ['INVENTORY', 'BATCH', 'EXPIRY'],
    mustNot: ['KOT', 'BOOKING'],
  },
  {
    type: 'restaurant',
    expectModes: ['sale'],
    mustHave: ['TABLE', 'KITCHEN', 'KOT'],
    mustNot: ['REPAIR_JOB', 'MEMBERSHIP'],
  },
  {
    type: 'salon',
    expectModes: ['service'],
    mustHave: ['BOOKING', 'STAFF_ASSIGNMENT'],
    mustNot: ['KOT'],
  },
  {
    type: 'service',
    expectModes: ['service'],
    mustHave: ['BOOKING'],
    mustNot: ['KOT'],
  },
  {
    type: 'gym',
    expectModes: ['subscription'],
    mustHave: ['MEMBERSHIP', 'SUBSCRIPTION', 'CHECK_IN'],
    mustNot: ['KOT', 'TABLE'],
  },
  {
    type: 'rental',
    expectModes: ['rental'],
    mustHave: ['DEPOSIT', 'AVAILABILITY', 'DAMAGE'],
    mustNot: ['KOT'],
  },
  {
    type: 'repair',
    expectModes: ['service'],
    mustHave: ['REPAIR_JOB', 'ASSET'],
    mustNot: ['KOT', 'TABLE'],
  },
  {
    type: 'pet_grooming',
    expectModes: ['service'],
    mustHave: ['BOOKING'],
    mustNot: ['KOT'],
  },
  {
    type: 'photography',
    expectModes: ['service'],
    mustHave: ['BOOKING'],
    mustNot: ['KOT'],
  },
];

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
  const data = json?.data ?? json;
  if (!res.ok) {
    const msg = Array.isArray(json?.message)
      ? json.message.join('; ')
      : json?.message || res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
  }
  return data;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function provision(profile) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 9999)}`;
  const email = `mb.${profile.type}.${stamp}@upos.test`;
  const password = 'WalitShop@2026';

  const signup = await req('/auth/signup', {
    method: 'POST',
    body: {
      email,
      password,
      fullName: `${profile.type} Owner`,
    },
  });
  assert(signup.identityToken, `${profile.type}: identityToken missing`);
  assert(
    signup.stage === 'select_org' || !signup.accessToken,
    `${profile.type}: expected select_org (got ${signup.stage})`,
  );

  const created = await req('/auth/organizations', {
    method: 'POST',
    token: signup.identityToken,
    body: {
      organizationName: `${profile.type} Shop ${stamp}`,
      businessType: profile.type,
      addressLine1: '12 Multi Biz Road',
      state: 'Maharashtra',
      city: 'Mumbai',
      postalCode: '400001',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-08-14',
    },
  });
  assert(created.accessToken, `${profile.type}: accessToken missing after create`);
  assert(created.user?.tenantId, `${profile.type}: tenantId missing`);

  const boot = await req('/tenants/me/bootstrap', {
    token: created.accessToken,
  });
  const businessType = boot.business?.type || boot.business?.config?.id;
  const modes = boot.commerce?.modes || [];
  const caps =
    boot.capabilities?.enabled ||
    boot.business?.capabilities ||
    [];

  assert(
    businessType === profile.type,
    `${profile.type}: business.type=${businessType}`,
  );
  for (const m of profile.expectModes) {
    assert(modes.includes(m), `${profile.type}: missing mode ${m} (got ${modes})`);
  }
  for (const c of profile.mustHave) {
    assert(caps.includes(c), `${profile.type}: missing cap ${c} (got ${caps.slice(0, 12)})`);
  }
  for (const c of profile.mustNot) {
    assert(!caps.includes(c), `${profile.type}: should NOT have ${c}`);
  }

  // Isolation: select-organization still works
  const selected = await req('/auth/select-organization', {
    method: 'POST',
    token: signup.identityToken,
    body: { tenantId: created.user.tenantId },
  });
  assert(selected.accessToken, `${profile.type}: select-organization failed`);

  return {
    type: profile.type,
    email,
    tenantId: created.user.tenantId,
    modes,
    caps,
    billing: boot.business?.config?.billing?.style,
    screens: boot.business?.config?.screens || boot.capabilities?.screens,
  };
}

async function main() {
  console.log(`Multi-business smoke @ ${API}\n`);
  const health = await req('/health').catch(() => null);
  assert(health?.status === 'ok' || health?.service, 'API health failed');

  // Recommend endpoint (may 404 on stale server)
  let recommendOk = false;
  try {
    const rec = await req('/commerce/recommend-setup', {
      method: 'POST',
      body: {
        businessType: 'restaurant',
        sells: ['products'],
        needs: ['tables', 'kitchen'],
      },
    });
    recommendOk = Array.isArray(rec.capabilities) && rec.capabilities.includes('TABLE');
    console.log(
      recommendOk
        ? 'recommend-setup: OK (restaurant → TABLE)'
        : 'recommend-setup: unexpected shape',
    );
  } catch (e) {
    console.log('recommend-setup:', e.message);
  }

  const rows = [];
  const failures = [];
  for (const profile of PROFILES) {
    process.stdout.write(`→ ${profile.type.padEnd(14)} `);
    try {
      const row = await provision(profile);
      rows.push(row);
      console.log(
        `PASS  modes=[${row.modes}]  billing=${row.billing}  caps=${row.caps.length}`,
      );
    } catch (e) {
      failures.push({ type: profile.type, error: e.message });
      console.log(`FAIL  ${e.message}`);
    }
    // gentle pacing
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log('\n=== Isolation matrix (mustNot) ===');
  const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
  if (byType.retail && byType.restaurant) {
    assert(
      !byType.retail.caps.includes('KOT') &&
        byType.restaurant.caps.includes('KOT'),
      'retail must not inherit restaurant KOT',
    );
    console.log('retail ≠ restaurant KOT: OK');
  }
  if (byType.salon && byType.gym) {
    assert(
      byType.salon.caps.includes('BOOKING') &&
        byType.gym.caps.includes('MEMBERSHIP'),
      'salon/gym capability split',
    );
    console.log('salon BOOKING / gym MEMBERSHIP: OK');
  }
  if (byType.repair && byType.retail) {
    assert(
      byType.repair.caps.includes('REPAIR_JOB') &&
        !byType.retail.caps.includes('REPAIR_JOB'),
      'repair jobs not forced on retail',
    );
    console.log('repair REPAIR_JOB isolated from retail: OK');
  }

  console.log('\n=== Summary ===');
  console.log(
    `PASS ${rows.length}/${PROFILES.length}  FAIL ${failures.length}  recommend=${recommendOk}`,
  );
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f.type}: ${f.error}`);
    process.exit(1);
  }
  console.log('ALL BUSINESS TYPES CONFIGURE + BOOTSTRAP + SELECT OK');
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
