/**
 * Reports Tests — sales summary, inventory, payments, numeric reconciliation
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked, assertPerformance } from './types';

export async function runReportsTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Reports';

  for (const biz of BUSINESSES) {
    const tokens = tokenMap.get(biz.slug);
    if (!tokens?.admin && !tokens?.manager) {
      results.push(blocked(MODULE, biz.name, 'All reports tests', 'No admin/manager token'));
      continue;
    }
    const token = tokens.admin ?? tokens.manager!;

    // Date range for queries
    const today = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const dateFrom = thirtyDaysAgo.toISOString().split('T')[0];
    const dateTo = today.toISOString().split('T')[0];

    // ── 1. Sales summary report ───────────────────────────────────────────
    const t0 = Date.now();
    const salesRes = await apiCall<any>('GET', `${API_BASE}/reports/sales-summary?from=${dateFrom}&to=${dateTo}`, token);
    const salesDuration = Date.now() - t0;
    if (salesRes.ok) {
      results.push(pass(MODULE, biz.name, 'Sales summary report', 'HTTP 200', `HTTP ${salesRes.status}`));
      results.push(assertPerformance(salesDuration, 5000, MODULE, biz.name, 'Sales report — under 5s'));

      // Numeric reconciliation: grandTotal >= subtotal
      const summary = salesRes.data as any;
      if (summary?.totalRevenue != null && summary?.netRevenue != null) {
        if (summary.totalRevenue >= summary.netRevenue) {
          results.push(pass(MODULE, biz.name, 'Sales report — totalRevenue >= netRevenue', 'totalRevenue ≥ netRevenue', `total: ${summary.totalRevenue}, net: ${summary.netRevenue}`));
        } else {
          results.push(fail(MODULE, biz.name, 'Sales report — totalRevenue >= netRevenue', 'totalRevenue ≥ netRevenue', `total: ${summary.totalRevenue} < net: ${summary.netRevenue}`, 'HIGH'));
        }
      }
    } else {
      results.push(fail(MODULE, biz.name, 'Sales summary report', 'HTTP 200', `HTTP ${salesRes.status}`, 'HIGH'));
    }

    // ── 2. Orders report / list ───────────────────────────────────────────
    const ordersRes = await apiCall<any>('GET', `${API_BASE}/orders?from=${dateFrom}&to=${dateTo}&limit=50`, token);
    if (ordersRes.ok) {
      const orders = (ordersRes.data as any)?.items ?? ordersRes.data ?? [];
      results.push(pass(MODULE, biz.name, 'Orders report list', 'HTTP 200', `${Array.isArray(orders) ? orders.length : '?'} orders in date range`));

      // Verify all orders have expected fields
      if (Array.isArray(orders) && orders.length > 0) {
        const hasRequiredFields = orders.every((o: any) => o.orderNumber && o.status && o.createdAt);
        if (hasRequiredFields) {
          results.push(pass(MODULE, biz.name, 'Orders list — all records have required fields', 'orderNumber, status, createdAt present', 'Fields validated'));
        } else {
          results.push(fail(MODULE, biz.name, 'Orders list — all records have required fields', 'orderNumber, status, createdAt present', 'Some orders missing required fields', 'MEDIUM'));
        }
      }
    } else {
      results.push(fail(MODULE, biz.name, 'Orders report list', 'HTTP 200', `HTTP ${ordersRes.status}`, 'HIGH'));
    }

    // ── 3. Payments report ───────────────────────────────────────────────
    const paymentsRes = await apiCall<any>('GET', `${API_BASE}/reports/payments-summary?from=${dateFrom}&to=${dateTo}`, token);
    if (paymentsRes.ok) {
      results.push(pass(MODULE, biz.name, 'Payments report', 'HTTP 200', `HTTP ${paymentsRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Payments report', 'HTTP 200', `HTTP ${paymentsRes.status}`, 'MEDIUM'));
    }

    // ── 4. Inventory report ──────────────────────────────────────────────
    const t1 = Date.now();
    const invRes = await apiCall<any>('GET', `${API_BASE}/reports/inventory/current-stock`, token);
    const invDuration = Date.now() - t1;
    if (invRes.ok) {
      results.push(pass(MODULE, biz.name, 'Inventory report', 'HTTP 200', `HTTP ${invRes.status}`));
      results.push(assertPerformance(invDuration, 5000, MODULE, biz.name, 'Inventory report — under 5s'));
    } else {
      results.push(fail(MODULE, biz.name, 'Inventory report', 'HTTP 200', `HTTP ${invRes.status}`, 'MEDIUM'));
    }

    // ── 5. Dashboard / overview ──────────────────────────────────────────
    const t2 = Date.now();
    const dashRes = await apiCall<any>('GET', `${API_BASE}/reports/dashboard-finance?from=${dateFrom}&to=${dateTo}`, token);
    const dashDuration = Date.now() - t2;
    if (dashRes.ok) {
      results.push(pass(MODULE, biz.name, 'Dashboard report', 'HTTP 200', `HTTP ${dashRes.status}`));
      results.push(assertPerformance(dashDuration, 3000, MODULE, biz.name, 'Dashboard report — under 3s'));
    } else {
      results.push(fail(MODULE, biz.name, 'Dashboard report', 'HTTP 200', `HTTP ${dashRes.status}`, 'MEDIUM'));
    }

    // ── 6. Expenses report ───────────────────────────────────────────────
    const expRes = await apiCall<any>('GET', `${API_BASE}/reports/expenses?from=${dateFrom}&to=${dateTo}`, token);
    if (expRes.ok) {
      results.push(pass(MODULE, biz.name, 'Expenses list', 'HTTP 200', `HTTP ${expRes.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Expenses list', 'HTTP 200', `HTTP ${expRes.status}`, 'LOW'));
    }

    // ── 7. Staff (cashier) cannot see reports ─────────────────────────────
    if (tokens.staff) {
      const staffReportRes = await apiCall('GET', `${API_BASE}/reports/sales-summary`, tokens.staff);
      if (staffReportRes.status === 403 || staffReportRes.status === 401) {
        results.push(pass(MODULE, biz.name, 'Staff blocked from reports', 'HTTP 403', `HTTP ${staffReportRes.status}`));
      } else if (staffReportRes.ok) {
        results.push(fail(MODULE, biz.name, 'Staff blocked from reports', 'HTTP 403', `HTTP ${staffReportRes.status} — STAFF CAN SEE REPORTS!`, 'HIGH'));
      }
    }

    // ── 8. Payment method breakdown ───────────────────────────────────────
    const breakdown = await apiCall<any>('GET', `${API_BASE}/reports/payments/breakdown?from=${dateFrom}&to=${dateTo}`, token);
    if (breakdown.ok || breakdown.status === 404) {
      results.push(pass(MODULE, biz.name, 'Payment breakdown report', 'HTTP 200/404', `HTTP ${breakdown.status}`));
    } else {
      results.push(fail(MODULE, biz.name, 'Payment breakdown report', 'HTTP 200/404', `HTTP ${breakdown.status}`, 'LOW'));
    }

    // ── 9. Revenue figure cross-check ─────────────────────────────────────
    // Get total from orders list vs total from sales report
    if (ordersRes.ok && salesRes.ok) {
      const orders: any[] = (ordersRes.data as any)?.items ?? ordersRes.data ?? [];
      if (Array.isArray(orders) && orders.length > 0) {
        const ordersTotal = orders.reduce((sum: number, o: any) => sum + (Number(o.grandTotal) || 0), 0);
        const reportTotal = (salesRes.data as any)?.totalRevenue ?? 0;
        // Allow ±5% deviation (pagination, date boundary differences)
        const deviation = ordersTotal > 0 ? Math.abs(ordersTotal - reportTotal) / ordersTotal : 0;
        if (deviation <= 0.05 || reportTotal === 0) {
          results.push(pass(MODULE, biz.name, 'Revenue reconciliation — orders vs report within 5%', `Deviation ≤ 5%`, `Deviation: ${(deviation * 100).toFixed(1)}%`));
        } else {
          results.push(fail(MODULE, biz.name, 'Revenue reconciliation — orders vs report', `Deviation ≤ 5%`, `Deviation: ${(deviation * 100).toFixed(1)}% (orders: ${ordersTotal}, report: ${reportTotal})`, 'HIGH'));
        }
      }
    }
  }

  return results;
}
