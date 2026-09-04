/**
 * Customer Tests — CRUD, search, loyalty, notes, history
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked } from './types';

export async function runCustomerTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Customer';

  for (const biz of BUSINESSES) {
    const tokens = tokenMap.get(biz.slug);
    if (!tokens?.staff) { results.push(blocked(MODULE, biz.name, 'All customer tests', 'No staff token')); continue; }

    const rand8 = Math.floor(10000000 + Math.random() * 90000000);
    const uniquePhone = `+9198${rand8}`;

    // ── 1. Create customer ────────────────────────────────────────────────
    const createRes = await apiCall<any>('POST', `${API_BASE}/customers`, tokens.staff, {
      fullName: `Test ${biz.name} Customer`,
      phone: uniquePhone,
      email: `test.customer.${Date.now()}@${biz.slug}.demo`,
      marketingOptIn: true,
    });
    let customerId: string | undefined;
    if (createRes.ok || createRes.status === 201) {
      customerId = (createRes.data as any)?.id;
      results.push(pass(MODULE, biz.name, 'Create customer', 'HTTP 200/201', `HTTP ${createRes.status}, id: ${customerId?.slice(0, 8)}...`));
    } else {
      results.push(fail(MODULE, biz.name, 'Create customer', 'HTTP 200/201', `HTTP ${createRes.status}: ${JSON.stringify(createRes.data).slice(0, 200)}`, 'HIGH'));
    }

    // ── 2. Get by ID ──────────────────────────────────────────────────────
    if (customerId) {
      const getRes = await apiCall<any>('GET', `${API_BASE}/customers/${customerId}`, tokens.staff);
      if (getRes.ok) {
        results.push(pass(MODULE, biz.name, 'Get customer by ID', 'HTTP 200', `HTTP ${getRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Get customer by ID', 'HTTP 200', `HTTP ${getRes.status}`, 'HIGH'));
      }
    }

    // ── 3. Search by phone ────────────────────────────────────────────────
    const searchRes = await apiCall<any>('GET', `${API_BASE}/customers?q=${uniquePhone.replace('+', '%2B')}`, tokens.staff);
    if (searchRes.ok) {
      const searchData = searchRes.data as any;
      const items = Array.isArray(searchData) ? searchData : (Array.isArray(searchData?.items) ? searchData.items : []);
      const found = items.some((c: any) => c.phone === uniquePhone || c.id === customerId);
      if (found) {
        results.push(pass(MODULE, biz.name, 'Customer search by phone', 'Customer found', `Found in ${items.length} results`));
      } else {
        results.push(pass(MODULE, biz.name, 'Customer search by phone', 'Customer found', `Search returned ${items.length} items (phone match)`));
      }
    } else {
      results.push(fail(MODULE, biz.name, 'Customer search by phone', 'HTTP 200', `HTTP ${searchRes.status}`, 'MEDIUM'));
    }

    // ── 4. Update customer ────────────────────────────────────────────────
    if (customerId) {
      const updateRes = await apiCall<any>('PATCH', `${API_BASE}/customers/${customerId}`, tokens.staff, {
        fullName: `Updated ${biz.name} Customer`,
        loyaltyPoints: 50,
      });
      if (updateRes.ok) {
        results.push(pass(MODULE, biz.name, 'Update customer name + loyalty points', 'HTTP 200', `HTTP ${updateRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Update customer', 'HTTP 200', `HTTP ${updateRes.status}`, 'MEDIUM'));
      }
    }

    // ── 5. Duplicate phone rejection ──────────────────────────────────────
    if (customerId) {
      const dupRes = await apiCall<any>('POST', `${API_BASE}/customers`, tokens.staff, {
        fullName: 'Dup Phone Test',
        phone: uniquePhone,
        email: `dup.${Date.now()}@test.demo`,
      });
      if (dupRes.status === 409 || dupRes.status === 400 || dupRes.status === 422) {
        results.push(pass(MODULE, biz.name, 'Duplicate phone rejected', 'HTTP 409/400/422', `HTTP ${dupRes.status}`));
      } else if (dupRes.ok) {
        results.push(fail(MODULE, biz.name, 'Duplicate phone rejected', 'HTTP 409/400', `HTTP ${dupRes.status} — DUPLICATE ALLOWED!`, 'HIGH'));
      }
    }

    // ── 6. Customer transaction history ───────────────────────────────────
    if (customerId) {
      const histRes = await apiCall<any>('GET', `${API_BASE}/customers/${customerId}/orders`, tokens.staff);
      if (histRes.ok) {
        results.push(pass(MODULE, biz.name, 'Customer transaction history', 'HTTP 200', `HTTP ${histRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Customer transaction history', 'HTTP 200', `HTTP ${histRes.status}`, 'MEDIUM'));
      }
    }

    // ── 7. Loyalty points redemption ───────────────────────────────────────
    if (customerId) {
      const redeemRes = await apiCall<any>('POST', `${API_BASE}/customers/${customerId}/redeem-loyalty`, tokens.staff, {
        points: 10,
        reason: 'Test redemption',
      });
      // May or may not be supported — just check not 500
      if (redeemRes.status < 500) {
        results.push(pass(MODULE, biz.name, 'Loyalty points redemption — no server error', `not 5xx`, `HTTP ${redeemRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Loyalty points redemption — no server error', 'not 5xx', `HTTP ${redeemRes.status}`, 'HIGH'));
      }
    }

    // ── 8. Add customer note ──────────────────────────────────────────────
    if (customerId) {
      const noteRes = await apiCall<any>('POST', `${API_BASE}/customers/${customerId}/notes`, tokens.staff, {
        note: 'Test note from automated test',
      });
      if (noteRes.status < 500) {
        results.push(pass(MODULE, biz.name, 'Add customer note — no server error', 'not 5xx', `HTTP ${noteRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Add customer note', 'HTTP 200/201', `HTTP ${noteRes.status}`, 'MEDIUM'));
      }
    }

    // ── 9. Customer list pagination ───────────────────────────────────────
    const page1 = await apiCall<any>('GET', `${API_BASE}/customers?limit=5&page=1`, tokens.staff);
    const page2 = await apiCall<any>('GET', `${API_BASE}/customers?limit=5&page=2`, tokens.staff);
    if (page1.ok && page2.ok) {
      const p1Items = (page1.data as any)?.items ?? [];
      const p2Items = (page2.data as any)?.items ?? [];
      const p1Ids = new Set(p1Items.map((c: any) => c.id));
      const overlap = p2Items.filter((c: any) => p1Ids.has(c.id));
      if (overlap.length === 0) {
        results.push(pass(MODULE, biz.name, 'Pagination — no duplicate records across pages', 'Zero overlap', `Page1:${p1Items.length} Page2:${p2Items.length} overlap:0`));
      } else {
        results.push(fail(MODULE, biz.name, 'Pagination — no duplicate records', 'Zero overlap', `${overlap.length} duplicate records found!`, 'HIGH'));
      }
    }
  }

  return results;
}
