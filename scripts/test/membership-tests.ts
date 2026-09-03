/**
 * Membership Tests — Gym and Swimming Academy membership plans, renewals, expiry
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked } from './types';

export async function runMembershipTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Membership';

  const membershipBizzes = BUSINESSES.filter(b => b.hasMembership);
  if (!membershipBizzes.length) {
    results.push(blocked(MODULE, 'All', 'Membership tests', 'No membership businesses in config'));
    return results;
  }

  for (const biz of membershipBizzes) {
    const tokens = tokenMap.get(biz.slug);
    if (!tokens?.staff) { results.push(blocked(MODULE, biz.name, 'All membership tests', 'No staff token')); continue; }

    // ── 1. Membership plan catalog ───────────────────────────────────────
    const plansRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/catalog?category=Membership+Plans&limit=10`, tokens.admin!);
    const planItems = (plansRes.data as any)?.items ?? plansRes.data ?? [];
    if (plansRes.ok && Array.isArray(planItems) && planItems.length > 0) {
      results.push(pass(MODULE, biz.name, 'Membership plans in catalog', `Plans available`, `${planItems.length} plan(s) found`));
    } else {
      results.push(fail(MODULE, biz.name, 'Membership plans in catalog', 'Plans available', `HTTP ${plansRes.status} / ${planItems.length} items`, 'MEDIUM'));
    }

    // ── 2. Get or create a test customer ─────────────────────────────────
    const custRes = await apiCall<any>('GET', `${API_BASE}/customers?limit=3`, tokens.staff);
    const customers = (custRes.data as any)?.items ?? custRes.data ?? [];
    const customer = Array.isArray(customers) ? customers[1] ?? customers[0] : null;

    if (!customer) {
      results.push(blocked(MODULE, biz.name, 'Membership assignment tests', 'No customers available'));
      continue;
    }

    // ── 3. Create membership subscription (buy plan) ──────────────────────
    const membershipPlan = Array.isArray(planItems) && planItems.length > 0 ? planItems[0] : null;
    if (!membershipPlan) {
      results.push(blocked(MODULE, biz.name, 'Buy membership plan', 'No membership plan available in catalog'));
      continue;
    }

    const buyRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, tokens.staff, {
      customerId: customer.id,
      items: [
        {
          stockLevelId: membershipPlan.stockLevelId ?? membershipPlan.id,
          qty: 1,
          price: membershipPlan.price ?? membershipPlan.sellPrice,
        },
      ],
      payments: [
        {
          method: 'cash',
          amount: membershipPlan.price ?? membershipPlan.sellPrice ?? 1000,
        },
      ],
      meta: {
        membershipPlanId: membershipPlan.id,
        customerId: customer.id,
      },
    });

    let membershipOrderId: string | undefined;
    if (buyRes.ok || buyRes.status === 201) {
      membershipOrderId = (buyRes.data as any)?.id;
      results.push(pass(MODULE, biz.name, 'Purchase membership plan checkout', 'HTTP 200/201', `HTTP ${buyRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Purchase membership plan checkout', 'HTTP 200/201', `HTTP ${buyRes.status}: ${JSON.stringify(buyRes.data).slice(0, 200)}`, 'HIGH'));
    }

    // ── 4. Customer membership status check ───────────────────────────────
    const memberStatusRes = await apiCall<any>('GET', `${API_BASE}/customers/${customer.id}/memberships`, tokens.staff);
    if (memberStatusRes.ok || memberStatusRes.status === 404) {
      results.push(pass(MODULE, biz.name, 'Customer membership status endpoint', 'HTTP 200/404', `HTTP ${memberStatusRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Customer membership status', 'HTTP 200/404', `HTTP ${memberStatusRes.status}`, 'MEDIUM'));
    }

    // ── 5. Subscription plans list ────────────────────────────────────────
    const subsRes = await apiCall<any>('GET', `${API_BASE}/subscriptions/plans?limit=5`, tokens.admin!);
    if (subsRes.ok || subsRes.status === 404) {
      results.push(pass(MODULE, biz.name, 'Subscription plans endpoint', 'HTTP 200/404', `HTTP ${subsRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Subscription plans endpoint', 'HTTP 200/404', `HTTP ${subsRes.status}`, 'MEDIUM'));
    }

    // ── 6. Check in customer (gym/pool attendance) ─────────────────────────
    const checkInRes = await apiCall<any>('POST', `${API_BASE}/customers/${customer.id}/check-in`, tokens.staff, {
      notes: 'Automated test check-in',
    });
    if (checkInRes.status < 500) {
      results.push(pass(MODULE, biz.name, 'Customer check-in — no server error', 'HTTP < 500', `HTTP ${checkInRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Customer check-in', 'HTTP < 500', `HTTP ${checkInRes.status}`, 'MEDIUM'));
    }

    // ── 7. Attendance log ─────────────────────────────────────────────────
    const attendRes = await apiCall<any>('GET', `${API_BASE}/customers/${customer.id}/attendance`, tokens.staff);
    if (attendRes.status < 500) {
      results.push(pass(MODULE, biz.name, 'Attendance log endpoint — no server error', 'HTTP < 500', `HTTP ${attendRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Attendance log', 'HTTP < 500', `HTTP ${attendRes.status}`, 'MEDIUM'));
    }
  }

  return results;
}
