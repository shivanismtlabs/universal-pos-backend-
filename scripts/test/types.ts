/**
 * Shared types and HTTP utilities for the Universal POS test suite.
 */

export type TestStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface TestResult {
  module: string;
  business: string;
  test: string;
  expected: string;
  actual: string;
  status: TestStatus;
  severity?: Severity;
  endpoint?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface BusinessTokens {
  admin: string | null;
  manager: string | null;
  staff: string | null;
  slug: string;
  name: string;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  durationMs: number;
  error?: string;
}

export async function apiCall<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  token?: string | null,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const start = Date.now();
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const durationMs = Date.now() - start;
    let data: T | null = null;
    try {
      const raw = await res.json() as any;
      if (raw && typeof raw === 'object' && raw.success === true && 'data' in raw) {
        data = raw.data as T;
      } else {
        data = raw as T;
      }
    } catch { /* empty */ }

    return {
      ok: res.ok,
      status: res.status,
      data,
      durationMs,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: null,
      durationMs: Date.now() - start,
      error: String(e),
    };
  }
}

export function pass(
  module: string,
  business: string,
  test: string,
  expected: string,
  actual: string,
  extra?: Partial<TestResult>,
): TestResult {
  return { module, business, test, expected, actual, status: 'PASS', severity: 'LOW', ...extra };
}

export function fail(
  module: string,
  business: string,
  test: string,
  expected: string,
  actual: string,
  severity: Severity = 'MEDIUM',
  extra?: Partial<TestResult>,
): TestResult {
  return { module, business, test, expected, actual, status: 'FAIL', severity, ...extra };
}

export function blocked(
  module: string,
  business: string,
  test: string,
  reason: string,
): TestResult {
  return {
    module, business, test,
    expected: 'Test executable',
    actual: `BLOCKED: ${reason}`,
    status: 'BLOCKED',
    severity: 'MEDIUM',
  };
}

export function partial(
  module: string,
  business: string,
  test: string,
  expected: string,
  actual: string,
  severity: Severity = 'MEDIUM',
): TestResult {
  return { module, business, test, expected, actual, status: 'PARTIAL', severity };
}

export function assertStatus(
  res: ApiResponse,
  expectedStatus: number,
  module: string,
  business: string,
  test: string,
  endpoint?: string,
): TestResult {
  const ok = res.status === expectedStatus;
  const result: TestResult = {
    module, business, test,
    expected: `HTTP ${expectedStatus}`,
    actual: `HTTP ${res.status}${res.error ? ` (${res.error})` : ''}`,
    status: ok ? 'PASS' : 'FAIL',
    severity: ok ? 'LOW' : 'HIGH',
    endpoint,
    durationMs: res.durationMs,
  };
  return result;
}

export function assertPerformance(
  durationMs: number,
  thresholdMs: number,
  module: string,
  business: string,
  test: string,
): TestResult {
  const ok = durationMs <= thresholdMs;
  return {
    module, business, test,
    expected: `< ${thresholdMs}ms`,
    actual: `${durationMs}ms`,
    status: ok ? 'PASS' : 'FAIL',
    severity: ok ? 'LOW' : 'MEDIUM',
    durationMs,
  };
}
