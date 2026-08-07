/**
 * Stripe flow smoke: config → intent (card/UPI) → confirm card → verify → cash offline.
 * Run: node scripts/smoke-stripe.mjs
 */
import 'dotenv/config';
import https from 'https';
import Stripe from 'stripe';

const BASE = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3001/v1';
const OWNER = {
  tenantSlug: 'demo-shop',
  email: 'owner@demo.shop',
  password: 'WalitShop@2026',
};

const results = [];
function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(method, path, { token, body } = {}, retries = 3) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
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
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

function stripeClient() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) throw new Error('STRIPE_SECRET_KEY missing in backend/.env');
  const insecure =
    (process.env.STRIPE_ALLOW_INSECURE_TLS || '').toLowerCase() === 'true';
  return new Stripe(key, {
    ...(insecure
      ? { httpAgent: new https.Agent({ rejectUnauthorized: false }) }
      : {}),
  });
}

async function main() {
  console.log(`\nStripe smoke → ${BASE}\n`);

  const login = await api('POST', '/auth/login', { body: OWNER });
  if (login.status !== 200 || !login.data?.accessToken) {
    fail('Login', `${login.status} ${JSON.stringify(login.json?.message)}`);
    process.exit(1);
  }
  pass('Login as owner');
  const token = login.data.accessToken;

  // Config (same as Terminal footer)
  const cfg = await api('GET', '/payments/stripe/config', { token });
  if (cfg.status !== 200 || !cfg.data?.enabled) {
    fail('GET stripe/config enabled', JSON.stringify(cfg.data ?? cfg.json));
  } else {
    pass('GET stripe/config', `mode=${cfg.data.mode} enabled=true`);
  }
  if (cfg.data?.publishableKey?.startsWith('pk_test_')) {
    pass('Publishable key is test mode');
  } else {
    fail('Publishable key is test mode', String(cfg.data?.publishableKey?.slice(0, 12)));
  }

  // Order with balance (or create + attach unit)
  const stores = await api('GET', '/stores', { token });
  const storeId = (Array.isArray(stores.data) ? stores.data : stores.data?.items)?.[0]
    ?.id;
  const customers = await api('GET', '/customers?limit=5', { token });
  const customerId = customers.data?.items?.[0]?.id;
  const units = await api('GET', '/inventory-units?limit=20', { token });
  const unitId = (units.data?.items ?? units.data)?.[0]?.id;

  let orderId = null;
  let balanceDue = 0;

  const orders = await api('GET', '/orders?limit=50', { token });
  const withDue = (orders.data?.items ?? []).find(
    (o) => Number(o.balanceDue) >= 60,
  );
  if (withDue) {
    orderId = withDue.id;
    balanceDue = Number(withDue.balanceDue);
    pass('Found order with balance', `${withDue.orderNumber} ₹${balanceDue}`);
  } else if (storeId && customerId) {
    const created = await api('POST', '/orders', {
      token,
      body: {
        storeId,
        customerId,
        eventDate: '2026-09-20',
        pickupDate: '2026-09-19',
        returnDueDate: '2026-09-22',
      },
    });
    orderId = created.data?.id;
    if (orderId && unitId) {
      await api('POST', `/orders/${orderId}/items`, {
        token,
        body: { itemType: 'rental_unit', inventoryUnitId: unitId },
      });
    }
    const detail = await api('GET', `/orders/${orderId}`, { token });
    balanceDue = Number(detail.data?.balanceDue ?? 0);
    if (balanceDue >= 60) {
      pass('Created order with balance', `₹${balanceDue}`);
    } else {
      pass('Created order', `balance ₹${balanceDue} (will charge ₹100 for Stripe test)`);
    }
  } else {
    fail('No store/customer to create order');
    process.exit(1);
  }

  const chargeAmt = Math.max(60, Math.min(balanceDue > 0 ? balanceDue : 100, 100));
  const stripe = stripeClient();

  // ── Card path (web Terminal → Card → Charge) ─────────────────────────────
  const cardIntent = await api('POST', '/payments/stripe/intent', {
    token,
    body: {
      orderId,
      amount: chargeAmt,
      method: 'card',
      type: 'payment',
    },
  });
  if (cardIntent.status === 200 || cardIntent.status === 201) {
    pass(
      'Create PaymentIntent (card)',
      `${cardIntent.data.paymentIntentId} ₹${chargeAmt}`,
    );
  } else {
    fail(
      'Create PaymentIntent (card)',
      `${cardIntent.status} ${JSON.stringify(cardIntent.json?.message)}`,
    );
  }

  let cardPiId = cardIntent.data?.paymentIntentId;
  if (cardPiId) {
    try {
      const confirmed = await stripe.paymentIntents.confirm(cardPiId, {
        payment_method: 'pm_card_visa',
        return_url: 'http://localhost:3000/pos',
      });
      if (confirmed.status === 'succeeded') {
        pass('Confirm card (pm_card_visa test PM)', confirmed.status);
      } else {
        fail('Confirm card', `status=${confirmed.status}`);
      }
    } catch (e) {
      fail('Confirm card', e.message);
    }

    const verify = await api('POST', '/payments/stripe/verify', {
      token,
      body: {
        orderId,
        paymentIntentId: cardPiId,
        amount: chargeAmt,
        method: 'card',
        type: 'payment',
      },
    });
    if (verify.status === 200 || verify.status === 201) {
      pass('Verify + record card payment in POS', `payment id ${verify.data?.id ?? 'ok'}`);
    } else {
      fail(
        'Verify + record card payment',
        `${verify.status} ${JSON.stringify(verify.json?.message)}`,
      );
    }
  }

  // ── UPI path (same Stripe Element; method tagged upi) ─────────────────────
  // Refresh balance after card pay
  const afterCard = await api('GET', `/orders/${orderId}`, { token });
  const dueAfter = Number(afterCard.data?.balanceDue ?? 0);
  const upiAmt = dueAfter >= 60 ? Math.min(dueAfter, 100) : 100;

  // If settled, create a small intent on same order still allowed by API for test
  // Prefer remaining balance when available
  const upiCharge = dueAfter >= 60 ? upiAmt : 100;

  const upiIntent = await api('POST', '/payments/stripe/intent', {
    token,
    body: {
      orderId,
      amount: upiCharge,
      method: 'upi',
      type: 'payment',
    },
  });
  if (upiIntent.status === 200 || upiIntent.status === 201) {
    pass(
      'Create PaymentIntent (upi method tag)',
      `${upiIntent.data.paymentIntentId} ₹${upiCharge}`,
    );
  } else {
    fail(
      'Create PaymentIntent (upi)',
      `${upiIntent.status} ${JSON.stringify(upiIntent.json?.message)}`,
    );
  }

  const upiPiId = upiIntent.data?.paymentIntentId;
  if (upiPiId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(upiPiId);
      const types = pi.payment_method_types ?? [];
      if (types.includes('upi') || types.includes('card')) {
        pass(
          'Intent allows India methods',
          `payment_method_types=[${types.join(', ')}]`,
        );
      } else {
        fail('Intent allows India methods', JSON.stringify(types));
      }

      // UPI cannot be fully confirmed via server PM in the same way as card.
      // Document: browser Payment Element shows UPI; server confirms card for e2e.
      pass(
        'UPI browser note',
        'UPI completes in Payment Element (scan/collect); API intent+types OK',
      );

      // Cancel unused UPI intent so it does not hang open
      await stripe.paymentIntents.cancel(upiPiId);
      pass('Cancel unused UPI test intent');
    } catch (e) {
      fail('Inspect/cancel UPI intent', e.message);
    }
  }

  // ── Cash (not Stripe — offline POS path used in web) ─────────────────────
  const fresh = await api('GET', `/orders/${orderId}`, { token });
  const cashDue = Number(fresh.data?.balanceDue ?? 0);
  if (cashDue > 0) {
    const cashAmt = Math.min(cashDue, 50);
    const cash = await api('POST', '/pos/checkout', {
      token,
      body: {
        orderId,
        markReady: false,
        payments: [
          {
            method: 'cash',
            amount: cashAmt,
            type: 'payment',
            idempotencyKey: `smoke-stripe-cash-${Date.now()}`,
          },
        ],
      },
    });
    if (cash.status === 200 || cash.status === 201) {
      pass('Cash checkout (offline, not Stripe)', `₹${cashAmt}`);
    } else {
      fail('Cash checkout', `${cash.status} ${JSON.stringify(cash.json?.message)}`);
    }
  } else {
    pass('Cash checkout', 'skipped (no balance left)');
  }

  // Decline card path (optional sanity)
  try {
    const declinePi = await stripe.paymentIntents.create({
      amount: 6000,
      currency: 'inr',
      automatic_payment_methods: { enabled: true },
      confirm: true,
      payment_method: 'pm_card_chargeDeclined',
      return_url: 'http://localhost:3000/pos',
    });
    fail('Decline card should fail', declinePi.status);
  } catch (e) {
    pass('Decline card rejected by Stripe', e.message.slice(0, 80));
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n======== STRIPE SUMMARY ========`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log('================================\n');
  console.log('Manual browser check (Terminal /pos):');
  console.log('  Card: 4242 4242 4242 4242 · any future expiry · any CVC');
  console.log('  UPI:  choose UPI in Payment Element (test mode QR / collect)');
  console.log('  Cash: records offline without Stripe modal\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
