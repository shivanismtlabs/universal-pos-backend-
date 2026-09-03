/**
 * Rental Tests — reserve, pickup, return, deposit, late fee, serial unit lifecycle
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked } from './types';

export async function runRentalTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Rental';

  const rentalBiz = BUSINESSES.find(b => b.hasRental);
  if (!rentalBiz) {
    results.push(blocked(MODULE, 'All', 'Rental tests', 'No rental business in BUSINESSES list'));
    return results;
  }

  const tokens = tokenMap.get(rentalBiz.slug);
  if (!tokens?.staff) {
    results.push(blocked(MODULE, rentalBiz.name, 'All rental tests', 'No staff token'));
    return results;
  }

  const bizName = rentalBiz.name;

  // ── 1. Rental catalog ────────────────────────────────────────────────────
  const catalogRes = await apiCall<any>('GET', `${API_BASE}/pos/rental/catalog?limit=10`, tokens.admin!);
  if (catalogRes.ok) {
    const items = (catalogRes.data as any)?.items ?? catalogRes.data ?? [];
    results.push(pass(MODULE, bizName, 'Rental catalog endpoint', 'HTTP 200', `${Array.isArray(items) ? items.length : '?'} rental items`));
  } else {
    results.push(fail(MODULE, bizName, 'Rental catalog endpoint', 'HTTP 200', `HTTP ${catalogRes.status}`, 'HIGH'));
  }

  // ── 2. Available units list ───────────────────────────────────────────────
  const unitsRes = await apiCall<any>('GET', `${API_BASE}/pos/rental/units?status=available&limit=5`, tokens.admin!);
  let availableUnit: any = null;
  if (unitsRes.ok) {
    const units = (unitsRes.data as any)?.items ?? unitsRes.data ?? [];
    availableUnit = Array.isArray(units) ? units[0] : null;
    results.push(pass(MODULE, bizName, 'Rental units — available list', 'HTTP 200', `${Array.isArray(units) ? units.length : '?'} available units`));
  } else {
    results.push(fail(MODULE, bizName, 'Rental units — available list', 'HTTP 200', `HTTP ${unitsRes.status}`, 'HIGH'));
  }

  if (!availableUnit) {
    results.push(blocked(MODULE, bizName, 'Rental reservation tests', 'No available units found'));
    return results;
  }

  // ── 3. Get rental customers ───────────────────────────────────────────────
  const custRes = await apiCall<any>('GET', `${API_BASE}/customers?limit=5`, tokens.staff);
  const customers = (custRes.data as any)?.items ?? custRes.data ?? [];
  const customer = Array.isArray(customers) ? customers[0] : null;

  // ── 4. Create rental (reservation) ───────────────────────────────────────
  const startDate = new Date();
  const endDate = new Date(Date.now() + 3 * 86400000); // 3 days
  const rentalCreateRes = await apiCall<any>('POST', `${API_BASE}/pos/rental/checkout`, tokens.staff, {
    customerId: customer?.id ?? null,
    stockUnitId: availableUnit.id,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    depositAmount: availableUnit.depositAmount ?? 500,
    payments: [
      {
        method: 'cash',
        amount: availableUnit.depositAmount ?? 500,
        type: 'deposit',
      },
    ],
    notes: 'Automated test rental',
  });

  let rentalOrderId: string | undefined;
  if (rentalCreateRes.ok || rentalCreateRes.status === 201) {
    rentalOrderId = (rentalCreateRes.data as any)?.id ?? (rentalCreateRes.data as any)?.order?.id;
    results.push(pass(MODULE, bizName, 'Create rental reservation', 'HTTP 200/201', `HTTP ${rentalCreateRes.status}, orderId: ${rentalOrderId?.slice(0, 8)}...`));
  } else {
    results.push(fail(MODULE, bizName, 'Create rental reservation', 'HTTP 200/201', `HTTP ${rentalCreateRes.status}: ${JSON.stringify(rentalCreateRes.data).slice(0, 300)}`, 'HIGH'));
  }

  // ── 5. Unit status changed to reserved/rented ─────────────────────────────
  if (rentalOrderId) {
    const unitCheckRes = await apiCall<any>('GET', `${API_BASE}/pos/rental/units/${availableUnit.id}`, tokens.admin!);
    const unitStatus = (unitCheckRes.data as any)?.status;
    if (unitStatus && unitStatus !== 'available') {
      results.push(pass(MODULE, bizName, 'Unit status changed after rental creation', 'Status changed from available', `Status: ${unitStatus}`));
    } else if (unitStatus === 'available') {
      results.push(fail(MODULE, bizName, 'Unit status changed after rental creation', 'Status should be reserved/rented', 'Status still: available', 'HIGH'));
    }
  }

  // ── 6. Return rental ──────────────────────────────────────────────────────
  if (rentalOrderId) {
    const returnRes = await apiCall<any>('POST', `${API_BASE}/pos/rental/orders/${rentalOrderId}/return`, tokens.staff, {
      returnedAt: new Date().toISOString(),
      condition: 'good',
      notes: 'Test return — automated',
    });
    if (returnRes.ok || returnRes.status === 200) {
      results.push(pass(MODULE, bizName, 'Return rental order', 'HTTP 200', `HTTP ${returnRes.status}`));
    } else {
      results.push(fail(MODULE, bizName, 'Return rental order', 'HTTP 200', `HTTP ${returnRes.status}: ${JSON.stringify(returnRes.data).slice(0, 200)}`, 'HIGH'));
    }

    // ── 7. Verify unit back to available ───────────────────────────────────
    if (returnRes.ok) {
      const unitAfterReturn = await apiCall<any>('GET', `${API_BASE}/pos/rental/units/${availableUnit.id}`, tokens.admin!);
      const statusAfter = (unitAfterReturn.data as any)?.status;
      if (statusAfter === 'available') {
        results.push(pass(MODULE, bizName, 'Unit status restored to available after return', 'Status: available', `Status: ${statusAfter}`));
      } else {
        results.push(fail(MODULE, bizName, 'Unit status restored to available after return', 'Status: available', `Status: ${statusAfter}`, 'MEDIUM'));
      }
    }
  }

  // ── 8. Rental history ────────────────────────────────────────────────────
  const historyRes = await apiCall<any>('GET', `${API_BASE}/pos/rental/orders?limit=5`, tokens.staff);
  if (historyRes.ok) {
    const orders = (historyRes.data as any)?.items ?? historyRes.data ?? [];
    results.push(pass(MODULE, bizName, 'Rental order history list', 'HTTP 200', `${Array.isArray(orders) ? orders.length : '?'} orders`));
  } else {
    results.push(fail(MODULE, bizName, 'Rental order history list', 'HTTP 200', `HTTP ${historyRes.status}`, 'MEDIUM'));
  }

  // ── 9. Overdue rental check ────────────────────────────────────────────────
  const overdueRes = await apiCall<any>('GET', `${API_BASE}/pos/rental/orders?status=overdue&limit=5`, tokens.admin!);
  if (overdueRes.ok || overdueRes.status === 404) {
    results.push(pass(MODULE, bizName, 'Overdue rentals query', 'HTTP 200/404', `HTTP ${overdueRes.status}`));
  } else {
    results.push(fail(MODULE, bizName, 'Overdue rentals query', 'HTTP 200', `HTTP ${overdueRes.status}`, 'MEDIUM'));
  }

  // ── 10. Rental mode unavailable for non-rental business ───────────────────
  const saleBiz = BUSINESSES.find(b => !b.hasRental);
  if (saleBiz) {
    const saleBizTokens = tokenMap.get(saleBiz.slug);
    if (saleBizTokens?.admin) {
      const noRentalRes = await apiCall<any>('GET', `${API_BASE}/pos/rental/catalog`, saleBizTokens.admin);
      if (noRentalRes.status === 403 || noRentalRes.status === 404 || noRentalRes.status === 400) {
        results.push(pass(MODULE, `${saleBiz.name} (non-rental)`, 'Non-rental business blocked from rental catalog', `HTTP 403/404/400`, `HTTP ${noRentalRes.status}`));
      } else {
        const noRentalItems = (noRentalRes.data as any)?.items ?? noRentalRes.data ?? [];
        if (Array.isArray(noRentalItems) && noRentalItems.length === 0) {
          results.push(pass(MODULE, `${saleBiz.name} (non-rental)`, 'Non-rental business returns empty rental catalog', 'Empty list', '0 rental items (mode-gated)'));
        } else {
          results.push(fail(MODULE, `${saleBiz.name} (non-rental)`, 'Non-rental blocked from rental mode', 'HTTP 403 or empty', `HTTP ${noRentalRes.status} with ${Array.isArray(noRentalItems) ? noRentalItems.length : '?'} items`, 'HIGH'));
        }
      }
    }
  }

  return results;
}
