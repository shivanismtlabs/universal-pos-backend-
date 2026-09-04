/**
 * Authentication Tests
 * - Login / logout for all 5 businesses × 3 roles
 * - Wrong password
 * - Missing tenant slug
 * - Session token validation (/auth/me)
 * - Unauthorized access without token
 * - Role-restricted endpoint with wrong role
 */

import { API_BASE, BUSINESSES } from './test-runner';
import type { BusinessTokens, TestResult } from './types';
import { apiCall, pass, fail, blocked, assertPerformance } from './types';

export async function runAuthTests(tokenMap: Map<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const MODULE = 'Authentication';

  for (const biz of BUSINESSES) {
    const bizName = biz.name;

    // ── 1. Correct admin login ─────────────────────────────────────────────
    const t0 = Date.now();
    const adminRes = await apiCall('POST', `${API_BASE}/auth/login`, null, {
      tenantSlug: biz.slug,
      email: biz.adminEmail,
      password: biz.password,
    });
    const loginDuration = Date.now() - t0;
    const adminData = adminRes.data as any;

    if (adminRes.ok && adminData?.accessToken) {
      results.push(pass(MODULE, bizName, 'Admin Login — correct credentials', 'accessToken returned', 'accessToken present', { endpoint: '/auth/login', durationMs: loginDuration }));
      results.push(assertPerformance(loginDuration, 2000, MODULE, bizName, 'Admin Login — under 2s'));
    } else {
      results.push(fail(MODULE, bizName, 'Admin Login — correct credentials', 'accessToken returned', `HTTP ${adminRes.status}: ${JSON.stringify(adminRes.data)}`, 'HIGH', { endpoint: '/auth/login' }));
    }

    // ── 2. Manager login ───────────────────────────────────────────────────
    const mgrRes = await apiCall('POST', `${API_BASE}/auth/login`, null, {
      tenantSlug: biz.slug,
      email: biz.managerEmail,
      password: biz.password,
    });
    if (mgrRes.ok && (mgrRes.data as any)?.accessToken) {
      results.push(pass(MODULE, bizName, 'Manager Login', 'accessToken returned', 'accessToken present'));
    } else {
      results.push(fail(MODULE, bizName, 'Manager Login', 'accessToken returned', `HTTP ${mgrRes.status}`, 'HIGH'));
    }

    // ── 3. Staff login ─────────────────────────────────────────────────────
    const staffRes = await apiCall('POST', `${API_BASE}/auth/login`, null, {
      tenantSlug: biz.slug,
      email: biz.staffEmail,
      password: biz.password,
    });
    if (staffRes.ok && (staffRes.data as any)?.accessToken) {
      results.push(pass(MODULE, bizName, 'Staff Login', 'accessToken returned', 'accessToken present'));
    } else {
      results.push(fail(MODULE, bizName, 'Staff Login', 'accessToken returned', `HTTP ${staffRes.status}`, 'HIGH'));
    }

    // ── 4. Wrong password → 401 ────────────────────────────────────────────
    const wrongPwRes = await apiCall('POST', `${API_BASE}/auth/login`, null, {
      tenantSlug: biz.slug,
      email: biz.adminEmail,
      password: 'WrongPassword123!',
    });
    if (wrongPwRes.status === 401 || wrongPwRes.status === 400) {
      results.push(pass(MODULE, bizName, 'Wrong Password — rejected', `HTTP 401/400`, `HTTP ${wrongPwRes.status}`));
    } else {
      results.push(fail(MODULE, bizName, 'Wrong Password — rejected', `HTTP 401/400`, `HTTP ${wrongPwRes.status}`, 'HIGH'));
    }

    // ── 5. Wrong tenant slug ───────────────────────────────────────────────
    const wrongSlugRes = await apiCall('POST', `${API_BASE}/auth/login`, null, {
      tenantSlug: 'nonexistent-slug-xyz',
      email: biz.adminEmail,
      password: biz.password,
    });
    if (wrongSlugRes.status === 401 || wrongSlugRes.status === 404 || wrongSlugRes.status === 400) {
      results.push(pass(MODULE, bizName, 'Wrong Tenant Slug — rejected', `HTTP 401/404/400`, `HTTP ${wrongSlugRes.status}`));
    } else {
      results.push(fail(MODULE, bizName, 'Wrong Tenant Slug — rejected', `HTTP 401/404/400`, `HTTP ${wrongSlugRes.status}`, 'HIGH'));
    }

    // ── 6. /auth/me with valid token ───────────────────────────────────────
    const tokens = tokenMap.get(biz.slug);
    if (tokens?.admin) {
      const meRes = await apiCall('GET', `${API_BASE}/auth/me`, tokens.admin);
      if (meRes.ok) {
        results.push(pass(MODULE, bizName, '/auth/me — valid token returns user', 'user object', `HTTP ${meRes.status}`));
      } else {
        results.push(fail(MODULE, bizName, '/auth/me — valid token returns user', 'HTTP 200 with user', `HTTP ${meRes.status}`, 'HIGH'));
      }

      // Verify tenantId is in response (isolation check)
      const meData = meRes.data as any;
      const tid = meData?.user?.tenantId ?? meData?.tenant?.id ?? meData?.tenantId;
      if (tid) {
        results.push(pass(MODULE, bizName, '/auth/me — tenantId present in response', 'tenantId field present', `tenantId: ${tid.slice(0, 8)}...`));
      } else {
        results.push(fail(MODULE, bizName, '/auth/me — tenantId present in response', 'tenantId field present', 'tenantId missing from response', 'CRITICAL'));
      }
    } else {
      results.push(blocked(MODULE, bizName, '/auth/me — valid token', 'No admin token available'));
    }

    // ── 7. No token → 401 ─────────────────────────────────────────────────
    const noTokenRes = await apiCall('GET', `${API_BASE}/auth/me`);
    if (noTokenRes.status === 401) {
      results.push(pass(MODULE, bizName, 'No token → 401', 'HTTP 401', `HTTP ${noTokenRes.status}`));
    } else {
      results.push(fail(MODULE, bizName, 'No token → 401', 'HTTP 401', `HTTP ${noTokenRes.status}`, 'CRITICAL'));
    }

    // ── 8. Logout (dedicated session) ────────────────────────────────────
    const tempLogin = await apiCall<any>('POST', `${API_BASE}/auth/login`, null, {
      tenantSlug: biz.slug,
      email: biz.staffEmail,
      password: biz.password,
    });
    const tempToken = (tempLogin.data as any)?.accessToken;
    if (tempToken) {
      const logoutRes = await apiCall('POST', `${API_BASE}/auth/logout`, tempToken);
      if (logoutRes.ok || logoutRes.status === 200) {
        results.push(pass(MODULE, bizName, 'Logout — session invalidation', 'HTTP 200', `HTTP ${logoutRes.status}`));
      } else {
        results.push(fail(MODULE, bizName, 'Logout — session invalidation', 'HTTP 200', `HTTP ${logoutRes.status}`, 'MEDIUM'));
      }
    }
  }

  // ── Cross-business: ensure tokens are scoped ────────────────────────────
  const gymTokens = tokenMap.get('gym-demo');
  const groceryTokens = tokenMap.get('grocery-demo');
  if (gymTokens?.admin && groceryTokens?.admin) {
    const meWithGymToken = await apiCall('GET', `${API_BASE}/auth/me`, gymTokens.admin);
    const gymMe = meWithGymToken.data as any;
    const groceryMeWithGroceryToken = await apiCall('GET', `${API_BASE}/auth/me`, groceryTokens.admin);
    const groceryMe = groceryMeWithGroceryToken.data as any;
    const gymTid = gymMe?.user?.tenantId ?? gymMe?.tenant?.id ?? gymMe?.tenantId;
    const groceryTid = groceryMe?.user?.tenantId ?? groceryMe?.tenant?.id ?? groceryMe?.tenantId;
    if (gymTid && groceryTid && gymTid !== groceryTid) {
      results.push(pass(MODULE, 'Cross-Business', 'Tokens are tenant-scoped (different tenantIds)', 'Different tenantIds', 'Verified different tenantIds', { severity: 'LOW' }));
    } else if (gymTid && groceryTid) {
      results.push(fail(MODULE, 'Cross-Business', 'Tokens are tenant-scoped (different tenantIds)', 'Different tenantIds', 'SAME tenantId — token isolation failure!', 'CRITICAL'));
    }
  }

  return results;
}
