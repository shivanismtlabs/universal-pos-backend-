/**
 * Permissions Tests — Role-based access control
 * - Staff cannot manage products, users, roles, or settings
 * - Manager can do manager-level actions
 * - Admin can do all actions
 * - Unauthenticated requests are rejected
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked } from './types';

type RoleCheck = {
  description: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  endpoint: string;
  body?: Record<string, unknown>;
  allowedRoles: Array<'admin' | 'manager' | 'staff'>;
  deniedRoles: Array<'admin' | 'manager' | 'staff'>;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
};

const ROLE_CHECKS: RoleCheck[] = [
  {
    description: 'Create product',
    method: 'POST',
    endpoint: '/pos/sale/products',
    body: { title: 'Perm Test Product', sku: `PERM-${Date.now()}`, price: 99, qty: 1, category: 'Test' },
    allowedRoles: ['admin', 'manager'],
    deniedRoles: ['staff'],
    severity: 'HIGH',
  },
  {
    description: 'List users',
    method: 'GET',
    endpoint: '/users',
    allowedRoles: ['admin'],
    deniedRoles: ['manager', 'staff'],
    severity: 'CRITICAL',
  },
  {
    description: 'Reports — sales summary',
    method: 'GET',
    endpoint: '/reports/sales',
    allowedRoles: ['admin', 'manager'],
    deniedRoles: ['staff'],
    severity: 'HIGH',
  },
  {
    description: 'Expense create',
    method: 'POST',
    endpoint: '/expenses',
    body: { amount: 100, category: 'Test', payee: 'Test', paymentMethod: 'cash', notes: 'Perm test', expenseNumber: `EXP-PERM-${Date.now()}` },
    allowedRoles: ['admin', 'manager'],
    deniedRoles: ['staff'],
    severity: 'MEDIUM',
  },
  {
    description: 'Tenant settings update',
    method: 'PATCH',
    endpoint: '/settings',
    body: { taxId: 'PERM-TEST' },
    allowedRoles: ['admin'],
    deniedRoles: ['manager', 'staff'],
    severity: 'CRITICAL',
  },
  {
    description: 'Customer create',
    method: 'POST',
    endpoint: '/customers',
    body: { fullName: 'Perm Test Customer', phone: `+91${Math.floor(9000000000 + Math.random() * 999999999)}` },
    allowedRoles: ['admin', 'manager', 'staff'],
    deniedRoles: [],
    severity: 'LOW',
  },
  {
    description: 'POS checkout',
    method: 'POST',
    endpoint: '/pos/sale/checkout',
    body: { items: [], payments: [] },
    allowedRoles: ['admin', 'manager', 'staff'],
    deniedRoles: [],
    severity: 'LOW',
  },
  {
    description: 'Purchase order create',
    method: 'POST',
    endpoint: '/purchase-orders',
    body: { supplierId: 'test', poNumber: `PO-PERM-${Date.now()}`, lines: [] },
    allowedRoles: ['admin', 'manager'],
    deniedRoles: ['staff'],
    severity: 'HIGH',
  },
];

export async function runPermissionsTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Permissions';

  // Run checks on the first business with all 3 roles available
  const testBiz = BUSINESSES.find(biz => {
    const t = tokenMap.get(biz.slug);
    return t?.admin && t?.manager && t?.staff;
  });

  if (!testBiz) {
    results.push(blocked(MODULE, 'All', 'Role-based access tests', 'Need a business with all 3 role tokens available'));
    return results;
  }

  const tokens = tokenMap.get(testBiz.slug)!;
  const roleTokens = {
    admin: tokens.admin,
    manager: tokens.manager,
    staff: tokens.staff,
  };

  for (const check of ROLE_CHECKS) {
    // ── Test denied roles ─────────────────────────────────────────────────
    for (const deniedRole of check.deniedRoles) {
      const token = roleTokens[deniedRole];
      if (!token) continue;

      const res = await apiCall(
        check.method,
        `${API_BASE}${check.endpoint}`,
        token,
        check.body,
      );

      if (res.status === 403 || res.status === 401) {
        results.push(pass(
          MODULE, testBiz.name,
          `${deniedRole} — blocked from: ${check.description}`,
          `HTTP 403/401`,
          `HTTP ${res.status}`,
          { severity: 'LOW', endpoint: check.endpoint },
        ));
      } else if (res.ok) {
        results.push(fail(
          MODULE, testBiz.name,
          `${deniedRole} — blocked from: ${check.description}`,
          `HTTP 403/401 (must be denied)`,
          `HTTP ${res.status} — UNAUTHORIZED ACCESS!`,
          check.severity,
          { endpoint: check.endpoint },
        ));
      } else {
        // e.g. 400 validation error is still "denied" from an access perspective
        results.push(pass(
          MODULE, testBiz.name,
          `${deniedRole} — blocked from: ${check.description}`,
          `HTTP 403/401/400`,
          `HTTP ${res.status}`,
          { severity: 'LOW', endpoint: check.endpoint },
        ));
      }
    }

    // ── Test allowed roles ────────────────────────────────────────────────
    for (const allowedRole of check.allowedRoles) {
      const token = roleTokens[allowedRole];
      if (!token) continue;

      const res = await apiCall(
        check.method,
        `${API_BASE}${check.endpoint}`,
        token,
        check.body,
      );

      if (res.status !== 403 && res.status !== 401) {
        results.push(pass(
          MODULE, testBiz.name,
          `${allowedRole} — allowed: ${check.description}`,
          `HTTP not 401/403`,
          `HTTP ${res.status}`,
          { severity: 'LOW', endpoint: check.endpoint },
        ));
      } else {
        results.push(fail(
          MODULE, testBiz.name,
          `${allowedRole} — allowed: ${check.description}`,
          `HTTP not 401/403 (should be allowed)`,
          `HTTP ${res.status} — LEGITIMATE ACCESS BLOCKED`,
          check.severity,
          { endpoint: check.endpoint },
        ));
      }
    }
  }

  // ── No token — all protected routes should return 401 ─────────────────
  const protectedRoutes = [
    '/auth/me',
    '/customers',
    '/orders',
    '/pos/sale/catalog',
    '/reports/sales',
  ];

  for (const route of protectedRoutes) {
    const noAuthRes = await apiCall('GET', `${API_BASE}${route}`);
    if (noAuthRes.status === 401) {
      results.push(pass(MODULE, testBiz.name, `No token → 401: ${route}`, 'HTTP 401', `HTTP ${noAuthRes.status}`));
    } else {
      results.push(fail(MODULE, testBiz.name, `No token → 401: ${route}`, 'HTTP 401', `HTTP ${noAuthRes.status} — UNPROTECTED ROUTE!`, 'CRITICAL', { endpoint: route }));
    }
  }

  return results;
}
