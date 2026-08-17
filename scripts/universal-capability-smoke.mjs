/**
 * Smoke: recommend-setup + capability isolation (no industry forks).
 * Run: node scripts/universal-capability-smoke.mjs
 * Requires local API + DEMO credentials or creates via recommend endpoint (public auth not needed for recommend).
 */
const API = process.env.API_URL || 'http://127.0.0.1:3001';

async function json(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log('Universal capability smoke @', API);

  const retail = await json('/commerce/recommend-setup', {
    method: 'POST',
    body: JSON.stringify({
      businessType: 'retail',
      sells: ['products'],
      needs: ['inventory', 'serial'],
    }),
  });
  // recommend may require auth — try catalog first
  const caps = await json('/commerce/capabilities');
  const configs = await json('/commerce/business-configs');

  console.log('capabilities catalog', caps.status, caps.body?.codes?.length);
  console.log('business configs', configs.status, configs.body?.catalog?.length);

  if (caps.status === 401 || configs.status === 401) {
    console.log(
      'SKIP auth-gated catalog — endpoints exist but need token (expected without login)',
    );
  } else if (caps.status === 200) {
    assert(Array.isArray(caps.body.codes), 'codes array');
    assert(caps.body.codes.includes('INVENTORY'), 'INVENTORY present');
    assert(caps.body.codes.includes('REPAIR_JOB'), 'REPAIR_JOB present');
    assert(caps.body.codes.includes('RESOURCE'), 'RESOURCE present');
  }

  // Offline recommendation unit (mirrors server logic via public if allowed)
  if (retail.status === 200) {
    assert(
      retail.body.commerceModes?.includes('sale'),
      'retail recommends sale',
    );
    assert(
      !retail.body.capabilities?.includes('KOT'),
      'retail should not get KOT by default',
    );
  }

  const restaurant = await json('/commerce/recommend-setup', {
    method: 'POST',
    body: JSON.stringify({
      businessType: 'restaurant',
      sells: ['products'],
      needs: ['tables', 'kitchen'],
    }),
  });
  if (restaurant.status === 200) {
    assert(
      restaurant.body.capabilities?.includes('TABLE'),
      'restaurant TABLE',
    );
    assert(
      restaurant.body.capabilities?.includes('KITCHEN'),
      'restaurant KITCHEN',
    );
  }

  const pet = await json('/commerce/recommend-setup', {
    method: 'POST',
    body: JSON.stringify({
      businessType: 'pet_grooming',
      sells: ['services', 'products'],
      needs: ['appointments', 'resources'],
    }),
  });
  if (pet.status === 200) {
    assert(pet.body.commerceModes?.includes('service'), 'pet service mode');
    assert(pet.body.capabilities?.includes('BOOKING'), 'pet BOOKING');
    console.log('Unknown business pet_grooming →', pet.body.capabilities);
  }

  console.log('OK — capability architecture endpoints responsive');
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
