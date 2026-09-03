/**
 * Inventory Tests — stock adjustments, purchase orders, GRN, low stock
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked } from './types';

export async function runInventoryTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Inventory';

  for (const biz of BUSINESSES) {
    if (biz.hasRental) continue; // rental uses serial units, not qty stock
    const tokens = tokenMap.get(biz.slug);
    if (!tokens?.admin) { results.push(blocked(MODULE, biz.name, 'All inventory tests', 'No admin token')); continue; }

    // ── 1. Get catalog to find a stocked product ──────────────────────────
    const catalogRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/catalog?limit=50`, tokens.admin);
    const catalogData = catalogRes.data as any;
    const items: any[] = Array.isArray(catalogData) ? catalogData : (Array.isArray(catalogData?.items) ? catalogData.items : []);
    const physicalItems = items.filter((i: any) => i.trackQty !== false && (Number(i.qtyOnHand ?? i.qty ?? 0) > 0));
    const firstItem = physicalItems[0];

    if (!firstItem) {
      results.push(blocked(MODULE, biz.name, 'Inventory tests — physical item needed', 'No physical stock found'));
      continue;
    }

    const productId = firstItem.id ?? firstItem.stockLevelId;
    const initialQty = firstItem.qty ?? firstItem.qtyOnHand ?? 0;

    // ── 2. Stock adjustment (increase) ────────────────────────────────────
    const adjRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/products/${productId}/adjust-stock`, tokens.admin, {
      delta: 5,
      reason: 'Test stock increase',
    });
    if (adjRes.ok) {
      results.push(pass(MODULE, biz.name, 'Stock adjustment (increase +5)', 'HTTP 200', `HTTP ${adjRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Stock adjustment (increase +5)', 'HTTP 200', `HTTP ${adjRes.status}: ${JSON.stringify(adjRes.data).slice(0, 200)}`, 'HIGH'));
    }

    // ── 3. Verify stock increased ─────────────────────────────────────────
    if (adjRes.ok) {
      const verifyRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/products/${productId}`, tokens.admin);
      const verifyData = verifyRes.data as any;
      const newQty = verifyData?.qty ?? verifyData?.qtyOnHand ?? -1;
      if (newQty >= initialQty + 5) {
        results.push(pass(MODULE, biz.name, 'Stock verification after +5 adjustment', `qty >= ${initialQty + 5}`, `qty = ${newQty}`));
      } else if (newQty >= 0) {
        results.push(fail(MODULE, biz.name, 'Stock verification after +5 adjustment', `qty >= ${initialQty + 5}`, `qty = ${newQty}`, 'MEDIUM'));
      }
    }

    // ── 4. Stock adjustment (decrease) ────────────────────────────────────
    const adjDecRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/products/${productId}/adjust-stock`, tokens.admin, {
      delta: -3,
      reason: 'Test stock decrease',
    });
    if (adjDecRes.ok) {
      results.push(pass(MODULE, biz.name, 'Stock adjustment (decrease -3)', 'HTTP 200', `HTTP ${adjDecRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Stock adjustment (decrease -3)', 'HTTP 200', `HTTP ${adjDecRes.status}`, 'MEDIUM'));
    }

    // ── 5. Stock adjustment history ───────────────────────────────────────
    const historyRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/stock-adjustments`, tokens.admin);
    if (historyRes.ok) {
      results.push(pass(MODULE, biz.name, 'Stock adjustment history list', 'HTTP 200', `HTTP ${historyRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Stock adjustment history list', 'HTTP 200', `HTTP ${historyRes.status}`, 'MEDIUM'));
    }

    // ── 6. Low stock query ────────────────────────────────────────────────
    const lowStockRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/catalog?lowStock=true`, tokens.admin);
    if (lowStockRes.ok) {
      const lowItems = (lowStockRes.data as any)?.items ?? lowStockRes.data ?? [];
      results.push(pass(MODULE, biz.name, 'Low stock filter', 'HTTP 200 with filtered list', `${Array.isArray(lowItems) ? lowItems.length : '?'} low stock items`));
    } else {
      results.push(fail(MODULE, biz.name, 'Low stock filter', 'HTTP 200', `HTTP ${lowStockRes.status}`, 'MEDIUM'));
    }

    // ── 7. Purchase order (opening stock) ─────────────────────────────────
    const suppliersRes = await apiCall<any>('GET', `${API_BASE}/suppliers?limit=1`, tokens.admin);
    const supplierData = suppliersRes.data as any;
    const supplierId = supplierData?.items?.[0]?.id ?? supplierData?.[0]?.id;

    if (supplierId) {
      const poRes = await apiCall<any>('POST', `${API_BASE}/purchase-orders`, tokens.admin, {
        supplierId,
        poNumber: `PO-TEST-${biz.slug}-${Date.now()}`,
        lines: [
          {
            stockLevelId: firstItem.stockLevelId ?? firstItem.id,
            qtyOrdered: 10,
            unitCost: firstItem.costPrice ?? firstItem.price * 0.55,
          },
        ],
        notes: 'Automated test purchase order',
      });

      if (poRes.ok || poRes.status === 201) {
        results.push(pass(MODULE, biz.name, 'Create purchase order', 'HTTP 200/201', `HTTP ${poRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Create purchase order', 'HTTP 200/201', `HTTP ${poRes.status}`, 'MEDIUM'));
      }
    } else {
      results.push(blocked(MODULE, biz.name, 'Create purchase order', 'No supplier found'));
    }
  }

  // ── Rental inventory specific checks ─────────────────────────────────
  const rentalBiz = BUSINESSES.find(b => b.hasRental);
  if (rentalBiz) {
    const tokens = tokenMap.get(rentalBiz.slug);
    if (tokens?.admin) {
      const unitsRes = await apiCall<any>('GET', `${API_BASE}/pos/rental/units?status=available&limit=10`, tokens.admin);
      if (unitsRes.ok) {
        const units = (unitsRes.data as any)?.items ?? unitsRes.data ?? [];
        results.push(pass(MODULE, rentalBiz.name, 'Rental units — available list', 'HTTP 200', `${Array.isArray(units) ? units.length : '?'} available units`));
      } else {
        results.push(fail(MODULE, rentalBiz.name, 'Rental units — available list', 'HTTP 200', `HTTP ${unitsRes.status}`, 'HIGH'));
      }

      const rentalCatalogRes = await apiCall<any>('GET', `${API_BASE}/pos/rental/catalog?limit=10`, tokens.admin);
      if (rentalCatalogRes.ok) {
        results.push(pass(MODULE, rentalBiz.name, 'Rental catalog endpoint', 'HTTP 200', `HTTP ${rentalCatalogRes.status}`));
      } else {
        results.push(fail(MODULE, rentalBiz.name, 'Rental catalog endpoint', 'HTTP 200', `HTTP ${rentalCatalogRes.status}`, 'HIGH'));
      }
    }
  }

  return results;
}
