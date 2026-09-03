/**
 * Sales Tests — checkout, multi-item, tax, discount, payment methods, receipt
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked, assertPerformance } from './types';

export async function runSalesTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Sales';

  for (const biz of BUSINESSES) {
    if (biz.hasRental) continue;
    const tokens = tokenMap.get(biz.slug);
    if (!tokens?.staff) { results.push(blocked(MODULE, biz.name, 'All sales tests', 'No staff token')); continue; }

    // ── 1. Get catalog ────────────────────────────────────────────────────
    const t0 = Date.now();
    const catalogRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/catalog?limit=10`, tokens.staff);
    const catalogDuration = Date.now() - t0;
    const catalogData = catalogRes.data as any;
    const items: any[] = Array.isArray(catalogData) ? catalogData : (Array.isArray(catalogData?.items) ? catalogData.items : []);

    if (!items.length) {
      results.push(blocked(MODULE, biz.name, 'All sales tests', 'Catalog is empty'));
      continue;
    }

    results.push(assertPerformance(catalogDuration, 2000, MODULE, biz.name, 'POS catalog load — under 2s'));

    // ── Get customers ─────────────────────────────────────────────────────
    const t1 = Date.now();
    const custRes = await apiCall<any>('GET', `${API_BASE}/customers?limit=5`, tokens.staff);
    const custSearchDuration = Date.now() - t1;
    const custData = custRes.data as any;
    const customers: any[] = Array.isArray(custData) ? custData : (Array.isArray(custData?.items) ? custData.items : []);
    const customerId: string | undefined = customers[1]?.id;
    results.push(assertPerformance(custSearchDuration, 500, MODULE, biz.name, 'Customer search — under 500ms'));

    const firstItem = items[0];
    const locId = firstItem.location?.id ?? catalogData?.locationId;

    async function getDue(orderItems: Array<{ stockLevelId: string; quantity: number }>, custId?: string): Promise<number> {
      const staffToken = tokens?.staff ?? tokens?.admin ?? '';
      const prep = await apiCall<any>('POST', `${API_BASE}/pos/sale/prepare`, staffToken, {
        locationId: locId,
        customerId: custId,
        items: orderItems,
      });
      const due = Number((prep.data as any)?.balanceDue ?? 100);
      const prepId = (prep.data as any)?.orderId;
      if (prepId) {
        await apiCall('POST', `${API_BASE}/pos/sale/prepare/${prepId}/cancel`, staffToken);
      }
      return due;
    }

    // ── 2. Single item cash checkout ──────────────────────────────────────
    const singleItems = [{ stockLevelId: firstItem.id, quantity: 1 }];
    const singleDue = await getDue(singleItems, customerId);

    const t2 = Date.now();
    const cashSaleRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, tokens.staff, {
      customerId: customerId ?? undefined,
      locationId: locId,
      cashTendered: Math.ceil(singleDue + 50),
      items: singleItems,
      payments: [
        {
          method: 'cash',
          amount: singleDue,
          idempotencyKey: `PAY-CASH-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      ],
    });
    const checkoutDuration = Date.now() - t2;

    let createdOrderId: string | undefined;
    if (cashSaleRes.ok || cashSaleRes.status === 201) {
      createdOrderId = (cashSaleRes.data as any)?.order?.id ?? (cashSaleRes.data as any)?.id;
      results.push(pass(MODULE, biz.name, 'Single item cash sale checkout', 'HTTP 200/201', `HTTP ${cashSaleRes.status}, order: ${createdOrderId?.slice(0, 8)}...`));
      results.push(assertPerformance(checkoutDuration, 3000, MODULE, biz.name, 'Checkout — under 3s'));
    } else {
      results.push(fail(MODULE, biz.name, 'Single item cash sale checkout', 'HTTP 200/201', `HTTP ${cashSaleRes.status}: ${JSON.stringify(cashSaleRes.data).slice(0, 300)}`, 'HIGH'));
    }

    // ── 3. UPI payment sale ───────────────────────────────────────────────
    const upiDue = await getDue(singleItems, customerId);
    const upiRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, tokens.staff, {
      customerId: customerId ?? undefined,
      locationId: locId,
      items: singleItems,
      payments: [{
        method: 'upi',
        amount: upiDue,
        idempotencyKey: `PAY-UPI-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }],
    });
    if (upiRes.ok || upiRes.status === 201) {
      results.push(pass(MODULE, biz.name, 'Single item UPI sale checkout', 'HTTP 200/201', `HTTP ${upiRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Single item UPI sale checkout', 'HTTP 200/201', `HTTP ${upiRes.status}`, 'MEDIUM'));
    }

    // ── 4. Card payment sale ──────────────────────────────────────────────
    const cardItems = [{ stockLevelId: firstItem.id, quantity: 2 }];
    const cardDue = await getDue(cardItems);
    const cardRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, tokens.staff, {
      locationId: locId,
      items: cardItems,
      payments: [{
        method: 'card',
        amount: cardDue,
        idempotencyKey: `PAY-CARD-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }],
    });
    if (cardRes.ok || cardRes.status === 201) {
      results.push(pass(MODULE, biz.name, 'Multi-qty card sale checkout', 'HTTP 200/201', `HTTP ${cardRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Multi-qty card sale checkout', 'HTTP 200/201', `HTTP ${cardRes.status}`, 'MEDIUM'));
    }

    // ── 5. Multi-item sale ────────────────────────────────────────────────
    if (items.length >= 2) {
      const item2 = items[1];
      const multiItems = [
        { stockLevelId: firstItem.id, quantity: 1 },
        { stockLevelId: item2.id, quantity: 1 },
      ];
      const multiDue = await getDue(multiItems, customerId);
      const multiRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, tokens.staff, {
        customerId: customerId ?? undefined,
        locationId: locId,
        cashTendered: Math.ceil(multiDue + 100),
        items: multiItems,
        payments: [{
          method: 'cash',
          amount: multiDue,
          idempotencyKey: `PAY-MULTI-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }],
      });
      if (multiRes.ok || multiRes.status === 201) {
        results.push(pass(MODULE, biz.name, 'Multi-item sale checkout (2 items)', 'HTTP 200/201', `HTTP ${multiRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Multi-item sale checkout', 'HTTP 200/201', `HTTP ${multiRes.status}`, 'HIGH'));
      }
    }

    // ── 6. Receipt retrieval ──────────────────────────────────────────────
    if (createdOrderId) {
      const receiptRes = await apiCall<any>('GET', `${API_BASE}/pos/orders/${createdOrderId}/receipt`, tokens.staff);
      if (receiptRes.ok) {
        results.push(pass(MODULE, biz.name, 'Order receipt retrieval', 'HTTP 200 with receipt', `HTTP ${receiptRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Order receipt retrieval', 'HTTP 200', `HTTP ${receiptRes.status}`, 'MEDIUM'));
      }
    }

    // ── 7. Recent sales ───────────────────────────────────────────────────
    const recentRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/recent?limit=5`, tokens.staff);
    if (recentRes.ok) {
      const recent = (recentRes.data as any)?.items ?? recentRes.data ?? [];
      results.push(pass(MODULE, biz.name, 'Recent sales list', 'HTTP 200', `${Array.isArray(recent) ? recent.length : '?'} recent sales`));
    } else {
      results.push(fail(MODULE, biz.name, 'Recent sales list', 'HTTP 200', `HTTP ${recentRes.status}`, 'MEDIUM'));
    }

    // ── 8. Park and resume sale ───────────────────────────────────────────
    const parkRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/park`, tokens.staff, {
      name: `Test Parked Sale ${biz.name}`,
      items: [{ stockLevelId: firstItem.stockLevelId ?? firstItem.id, qty: 1, price: firstItem.price ?? 100 }],
    });
    if (parkRes.ok || parkRes.status === 201) {
      const parkedId = (parkRes.data as any)?.id;
      results.push(pass(MODULE, biz.name, 'Park sale (hold cart)', 'HTTP 200/201', `HTTP ${parkRes.status}`));

      if (parkedId) {
        const resumeRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/parked/${parkedId}/resume`, tokens.staff);
        if (resumeRes.ok) {
          results.push(pass(MODULE, biz.name, 'Resume parked sale', 'HTTP 200', `HTTP ${resumeRes.status}`));
          // Discard the parked sale
          await apiCall('POST', `${API_BASE}/pos/sale/parked/${parkedId}/discard`, tokens.staff);
        } else {
          results.push(fail(MODULE, biz.name, 'Resume parked sale', 'HTTP 200', `HTTP ${resumeRes.status}`, 'MEDIUM'));
        }
      }
    } else {
      results.push(fail(MODULE, biz.name, 'Park sale', 'HTTP 200/201', `HTTP ${parkRes.status}`, 'MEDIUM'));
    }

    // ── 9. Backend total validation ───────────────────────────────────────
    if (createdOrderId) {
      const orderRes = await apiCall<any>('GET', `${API_BASE}/orders/${createdOrderId}`, tokens.staff);
      const orderData = orderRes.data as any;
      if (orderRes.ok && orderData?.grandTotal != null) {
        const expectedTotal = firstItem.price ?? 100;
        const diff = Math.abs(orderData.grandTotal - expectedTotal);
        if (diff <= expectedTotal * 0.3) { // allow for tax
          results.push(pass(MODULE, biz.name, 'Backend total reconciliation', `Grand total ≈ ${expectedTotal}`, `grandTotal = ${orderData.grandTotal}`));
        } else {
          results.push(fail(MODULE, biz.name, 'Backend total reconciliation', `Grand total ≈ ${expectedTotal}`, `grandTotal = ${orderData.grandTotal} (delta: ${diff})`, 'HIGH'));
        }
      }
    }
  }

  return results;
}
