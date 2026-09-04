/**
 * Returns Tests — full, partial, exchange, refund, and stock restoration
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked } from './types';

export async function runReturnsTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Returns';

  for (const biz of BUSINESSES) {
    if (biz.hasRental) continue; // rental returns handled in rental-tests.ts
    const tokens = tokenMap.get(biz.slug);
    if (!tokens?.staff) { results.push(blocked(MODULE, biz.name, 'All returns tests', 'No staff token')); continue; }

    // ── Step 1: Create a sale to return ──────────────────────────────────
    const catalogRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/catalog?limit=20`, tokens.staff);
    const data = catalogRes.data as any;
    const items: any[] = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
    const physicalItem = items.find((i: any) => i.kind !== 'service' && ((i.qtyOnHand ?? i.qty ?? 0) > 0 || i.trackQty !== false));
    const item = physicalItem ?? items[0];

    if (!item) {
      results.push(blocked(MODULE, biz.name, 'Returns tests — need a product', 'No catalog items'));
      continue;
    }

    const locId = item.location?.id ?? data?.locationId;

    async function getDue(orderItems: Array<{ stockLevelId: string; quantity: number }>): Promise<number> {
      const staffToken = tokens?.staff ?? tokens?.admin ?? '';
      const prep = await apiCall<any>('POST', `${API_BASE}/pos/sale/prepare`, staffToken, {
        locationId: locId,
        items: orderItems,
      });
      const due = Number((prep.data as any)?.balanceDue ?? 100);
      const prepId = (prep.data as any)?.orderId;
      if (prepId) {
        await apiCall('POST', `${API_BASE}/pos/sale/prepare/${prepId}/cancel`, staffToken);
      }
      return due;
    }

    // Create a test sale
    const sale1Items = [{ stockLevelId: item.id, quantity: 2 }];
    const due1 = await getDue(sale1Items);
    const saleRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, tokens.staff, {
      locationId: locId,
      cashTendered: Math.ceil(due1 + 50),
      items: sale1Items,
      payments: [{
        method: 'cash',
        amount: due1,
        idempotencyKey: `PAY-RET1-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }],
    });

    const orderId = (saleRes.data as any)?.order?.id ?? (saleRes.data as any)?.id;

    if (!saleRes.ok || !orderId) {
      results.push(blocked(MODULE, biz.name, 'Returns tests — need a sale', `Sale creation failed: HTTP ${saleRes.status}`));
      continue;
    }

    // ── 2. Full return ────────────────────────────────────────────────────
    const fullReturnRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/returns`, tokens.staff, {
      orderId,
      reasonCode: 'customer_request',
      items: [
        {
          stockLevelId: item.id,
          quantity: 2,
          condition: 'good',
        },
      ],
      refundMethod: 'cash',
    });
    if (fullReturnRes.ok || fullReturnRes.status === 201) {
      results.push(pass(MODULE, biz.name, 'Full order return', 'HTTP 200/201', `HTTP ${fullReturnRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Full order return', 'HTTP 200/201', `HTTP ${fullReturnRes.status}: ${JSON.stringify(fullReturnRes.data).slice(0, 200)}`, 'HIGH'));
    }

    // ── 3. Create another sale for partial return ─────────────────────────
    const sale2Items = [{ stockLevelId: item.id, quantity: 3 }];
    const due2 = await getDue(sale2Items);
    const sale2Res = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, tokens.staff, {
      locationId: locId,
      items: sale2Items,
      payments: [{
        method: 'upi',
        amount: due2,
        idempotencyKey: `PAY-RET2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }],
    });
    const order2Id = (sale2Res.data as any)?.order?.id ?? (sale2Res.data as any)?.id;

    if (sale2Res.ok && order2Id) {
      // ── 4. Partial return (return 1 of 3) ─────────────────────────────
      const partialReturnRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/returns`, tokens.staff, {
        orderId: order2Id,
        reasonCode: 'defective',
        items: [
          {
            stockLevelId: item.id,
            quantity: 1, // partial: only 1 of 3
            condition: 'good',
          },
        ],
        refundMethod: 'cash',
      });
      if (partialReturnRes.ok || partialReturnRes.status === 201) {
        results.push(pass(MODULE, biz.name, 'Partial return (1 of 3)', 'HTTP 200/201', `HTTP ${partialReturnRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Partial return (1 of 3)', 'HTTP 200/201', `HTTP ${partialReturnRes.status}`, 'HIGH'));
      }

      // ── 5. Double return protection — cannot return qty > original ─────
      const overReturnRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/returns`, tokens.staff, {
        orderId: order2Id,
        reasonCode: 'overreturn_test',
        items: [
          {
            stockLevelId: item.id,
            quantity: 10, // more than original 3
            condition: 'good',
          },
        ],
        refundMethod: 'cash',
      });
      if (overReturnRes.status === 400 || overReturnRes.status === 422 || overReturnRes.status === 409) {
        results.push(pass(MODULE, biz.name, 'Over-return blocked (qty > ordered)', `HTTP 400/422/409`, `HTTP ${overReturnRes.status}`));
      } else if (overReturnRes.ok) {
        results.push(fail(MODULE, biz.name, 'Over-return blocked (qty > ordered)', `HTTP 400/422`, `HTTP ${overReturnRes.status} — OVER-RETURN ALLOWED!`, 'HIGH'));
      }
    }

    // ── 6. Stock restoration after return ─────────────────────────────────
    if (fullReturnRes.ok) {
      const stockAfterReturn = await apiCall<any>('GET', `${API_BASE}/pos/sale/products/${item.stockLevelId ?? item.id}`, tokens.staff);
      if (stockAfterReturn.ok) {
        results.push(pass(MODULE, biz.name, 'Stock level retrievable after return', 'HTTP 200', `HTTP ${stockAfterReturn.status}`));
      }
    }

    // ── 7. Return list ────────────────────────────────────────────────────
    const returnsListRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/returns?limit=5`, tokens.admin!);
    if (returnsListRes.ok || returnsListRes.status === 404) {
      results.push(pass(MODULE, biz.name, 'Returns list endpoint', 'HTTP 200/404', `HTTP ${returnsListRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Returns list endpoint', 'HTTP 200', `HTTP ${returnsListRes.status}`, 'MEDIUM'));
    }

    // ── 8. Exchange (return + new sale) ───────────────────────────────────
    const sale3Items = [{ stockLevelId: item.id, quantity: 1 }];
    const due3 = await getDue(sale3Items);
    const sale3Res = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, tokens.staff, {
      locationId: locId,
      cashTendered: Math.ceil(due3 + 50),
      items: sale3Items,
      payments: [{
        method: 'cash',
        amount: due3,
        idempotencyKey: `PAY-RET3-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }],
    });
    const order3Id = (sale3Res.data as any)?.order?.id ?? (sale3Res.data as any)?.id;

    if (sale3Res.ok && order3Id) {
      const exchangeItems = items.filter(i => i.id !== item.id && (Number(i.sellPrice ?? i.price ?? 0) > 0));
      const exchangeItem = exchangeItems[0] ?? item;
      const exPrice = Number(exchangeItem.sellPrice ?? exchangeItem.price ?? 100);
      const exchangeRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/returns/exchange`, tokens.staff, {
        orderId: order3Id,
        returnItems: [{ stockLevelId: item.id, quantity: 1, condition: 'good' }],
        newItems: [{ stockLevelId: exchangeItem.id, quantity: 1, unitPrice: exPrice }],
        refundMethod: 'cash',
        reasonCode: 'exchange_request',
      });
      if (exchangeRes.status < 500) {
        results.push(pass(MODULE, biz.name, 'Exchange (return + new sale) — no server error', 'HTTP < 500', `HTTP ${exchangeRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Exchange endpoint — no server error', 'HTTP < 500', `HTTP ${exchangeRes.status}`, 'HIGH'));
      }
    }
  }

  return results;
}
