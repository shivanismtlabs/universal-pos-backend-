/**
 * Catalog Tests — CRUD, SKU uniqueness, categories, search, barcode
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked, assertPerformance } from './types';

export async function runCatalogTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Catalog';

  for (const biz of BUSINESSES) {
    const tokens = tokenMap.get(biz.slug);
    if (!tokens?.admin) { results.push(blocked(MODULE, biz.name, 'All catalog tests', 'No admin token')); continue; }

    // ── 1. List products ─────────────────────────────────────────────────
    const t0 = Date.now();
    const listRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/catalog?limit=10`, tokens.admin);
    const searchDuration = Date.now() - t0;
    if (listRes.ok) {
      results.push(pass(MODULE, biz.name, 'List products — catalog returns', 'HTTP 200', `HTTP ${listRes.status}`));
      results.push(assertPerformance(searchDuration, 500, MODULE, biz.name, 'Product search — under 500ms'));
    } else {
      results.push(fail(MODULE, biz.name, 'List products', 'HTTP 200', `HTTP ${listRes.status}`, 'HIGH'));
    }

    // ── 2. Category list ─────────────────────────────────────────────────
    const catRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/categories`, tokens.admin);
    if (catRes.ok) {
      const cats = (catRes.data as any)?.items ?? catRes.data ?? [];
      results.push(pass(MODULE, biz.name, 'Category list', `Categories returned`, `${Array.isArray(cats) ? cats.length : '?'} categories`));
    } else {
      results.push(fail(MODULE, biz.name, 'Category list', 'HTTP 200', `HTTP ${catRes.status}`, 'MEDIUM'));
    }

    // ── 3. Create a test product ─────────────────────────────────────────
    const testSku = `TEST-CAT-${biz.slug.toUpperCase()}-${Date.now()}`;
    const createRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/products`, tokens.admin, {
      title: `Test Product ${biz.name}`,
      sku: testSku,
      price: 99.00,
      qty: 10,
      category: `Test Category ${biz.name}`,
    });
    let createdProductId: string | undefined;
    if (createRes.ok || createRes.status === 201) {
      createdProductId = (createRes.data as any)?.id;
      results.push(pass(MODULE, biz.name, 'Create product', 'Product created', `HTTP ${createRes.status}, id: ${createdProductId?.slice(0, 8)}...`));
    } else {
      results.push(fail(MODULE, biz.name, 'Create product', 'HTTP 200/201', `HTTP ${createRes.status}: ${JSON.stringify(createRes.data).slice(0, 200)}`, 'HIGH'));
    }

    // ── 4. SKU uniqueness check ──────────────────────────────────────────
    const dupRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/products`, tokens.admin, {
      title: `Duplicate SKU Test`,
      sku: testSku,
      price: 50.00,
      qty: 5,
      category: `Test Category ${biz.name}`,
    });
    if (dupRes.status === 409 || dupRes.status === 400 || dupRes.status === 422) {
      results.push(pass(MODULE, biz.name, 'SKU uniqueness — duplicate rejected', 'HTTP 409/400/422', `HTTP ${dupRes.status}`));
    } else if (dupRes.status === 200 || dupRes.status === 201) {
      results.push(fail(MODULE, biz.name, 'SKU uniqueness — duplicate rejected', 'HTTP 409/400', `HTTP ${dupRes.status} — DUPLICATE SKU ALLOWED!`, 'HIGH'));
    }

    // ── 5. Update product ────────────────────────────────────────────────
    if (createdProductId) {
      const updateRes = await apiCall('PATCH', `${API_BASE}/pos/sale/products/${createdProductId}`, tokens.admin, {
        price: 149.00,
        qty: 20,
      });
      if (updateRes.ok) {
        results.push(pass(MODULE, biz.name, 'Update product price + qty', 'HTTP 200', `HTTP ${updateRes.status}`));
      } else {
        results.push(fail(MODULE, biz.name, 'Update product', 'HTTP 200', `HTTP ${updateRes.status}`, 'MEDIUM'));
      }
    }

    // ── 6. SKU/barcode lookup ─────────────────────────────────────────────
    const lookupRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/lookup?sku=${testSku}`, tokens.admin);
    if (lookupRes.ok || lookupRes.status === 404) {
      results.push(pass(MODULE, biz.name, 'SKU barcode lookup', `HTTP 200/404`, `HTTP ${lookupRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'SKU barcode lookup', 'HTTP 200/404', `HTTP ${lookupRes.status}`, 'MEDIUM'));
    }

    // ── 7. Search with q param ────────────────────────────────────────────
    const t1 = Date.now();
    const searchRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/products?q=test`, tokens.admin);
    const searchDur = Date.now() - t1;
    if (searchRes.ok) {
      results.push(pass(MODULE, biz.name, 'Product search with q param', 'HTTP 200', `HTTP ${searchRes.status}`));
      results.push(assertPerformance(searchDur, 500, MODULE, biz.name, 'Product search ?q= — under 500ms'));
    } else {
      results.push(fail(MODULE, biz.name, 'Product search with q param', 'HTTP 200', `HTTP ${searchRes.status}`, 'MEDIUM'));
    }

    // ── 8. Catalog (full catalog) endpoint ────────────────────────────────
    const floorRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/floor`, tokens.admin);
    if (floorRes.ok) {
      results.push(pass(MODULE, biz.name, 'POS floor endpoint', 'HTTP 200', `HTTP ${floorRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'POS floor endpoint', 'HTTP 200', `HTTP ${floorRes.status}`, 'HIGH'));
    }

    // ── 9. Staff cannot create products (permissions check) ──────────────
    if (tokens.staff) {
      const staffCreateRes = await apiCall('POST', `${API_BASE}/pos/sale/products`, tokens.staff, {
        title: 'Staff Product Attempt',
        sku: `STAFF-UNAUTH-${Date.now()}`,
        price: 99,
        qty: 1,
        category: 'Test',
      });
      // Staff (cashier) should NOT be able to create products
      if (staffCreateRes.status === 403) {
        results.push(pass(MODULE, biz.name, 'Staff cannot create products — 403', 'HTTP 403', `HTTP ${staffCreateRes.status}`));
      } else if (staffCreateRes.ok) {
        results.push(fail(MODULE, biz.name, 'Staff cannot create products — 403', 'HTTP 403', `HTTP ${staffCreateRes.status} — UNAUTHORIZED WRITE!`, 'HIGH'));
      } else {
        results.push(pass(MODULE, biz.name, 'Staff cannot create products — blocked', `HTTP 403`, `HTTP ${staffCreateRes.status}`));
      }
    }
  }

  return results;
}
