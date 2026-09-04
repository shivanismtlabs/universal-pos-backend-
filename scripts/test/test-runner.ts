/**
 * Universal POS — Complete Automated Test Suite
 *
 * Target: http://13.126.105.138:3001
 *
 * Tests:
 *   - Authentication (all 5 businesses, 3 roles each)
 *   - Catalog (CRUD, SKU uniqueness, search, barcode)
 *   - Inventory (stock adjustments, purchase orders, GRN)
 *   - Sales (checkout, tax, discount, multi-payment)
 *   - Customer (create, edit, search, history, loyalty)
 *   - Rental (reserve, pickup, return, deposit, late fee)
 *   - Membership (create, assign, renew, expire)
 *   - Permissions (role-based access, unauthorized routes)
 *   - Tenant Isolation (cross-tenant data leakage checks)
 *   - Reports (sales, inventory, payments — number reconciliation)
 *   - Returns (full, partial, exchange, refund, stock restoration)
 *   - Performance (login, POS, search, checkout, reports)
 *
 * Usage:
 *   cd backend
 *   npx ts-node -r tsconfig-paths/register scripts/test/test-runner.ts
 *   npx ts-node -r tsconfig-paths/register scripts/test/test-runner.ts --module=auth
 */

import { generateReport } from './generate-report';
import { runAuthTests } from './auth-tests';
import { runCatalogTests } from './catalog-tests';
import { runInventoryTests } from './inventory-tests';
import { runSalesTests } from './sales-tests';
import { runCustomerTests } from './customer-tests';
import { runRentalTests } from './rental-tests';
import { runMembershipTests } from './membership-tests';
import { runPermissionsTests } from './permissions-tests';
import { runTenantIsolationTests } from './tenant-isolation-tests';
import { runReportsTests } from './reports-tests';
import { runReturnsTests } from './returns-tests';
import { runPricingUomTests } from './pricing-uom-tests';
import { apiCall, type TestResult, type BusinessTokens } from './types';

export const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:3001/v1';

export const BUSINESSES: Array<{
  name: string;
  slug: string;
  adminEmail: string;
  managerEmail: string;
  staffEmail: string;
  password: string;
  commerceModes: string[];
  hasRental: boolean;
  hasMembership: boolean;
}> = [
  {
    name: 'Gym',
    slug: 'gym-demo',
    adminEmail: 'gym.admin@gym.demo',
    managerEmail: 'gym.manager@gym.demo',
    staffEmail: 'gym.staff@gym.demo',
    password: 'WalitShop@2026',
    commerceModes: ['service', 'subscription'],
    hasRental: false,
    hasMembership: true,
  },
  {
    name: 'Grocery',
    slug: 'grocery-demo',
    adminEmail: 'grocery.admin@grocery.demo',
    managerEmail: 'grocery.manager@grocery.demo',
    staffEmail: 'grocery.staff@grocery.demo',
    password: 'WalitShop@2026',
    commerceModes: ['sale'],
    hasRental: false,
    hasMembership: false,
  },
  {
    name: 'Rental',
    slug: 'rental-demo',
    adminEmail: 'rental.admin@rental.demo',
    managerEmail: 'rental.manager@rental.demo',
    staffEmail: 'rental.staff@rental.demo',
    password: 'WalitShop@2026',
    commerceModes: ['rental', 'sale'],
    hasRental: true,
    hasMembership: false,
  },
  {
    name: 'Swimming',
    slug: 'swimming-demo',
    adminEmail: 'swimming.admin@swimming.demo',
    managerEmail: 'swimming.manager@swimming.demo',
    staffEmail: 'swimming.staff@swimming.demo',
    password: 'WalitShop@2026',
    commerceModes: ['service', 'subscription'],
    hasRental: false,
    hasMembership: true,
  },
  {
    name: 'Salon',
    slug: 'salon-demo',
    adminEmail: 'salon.admin@salon.demo',
    managerEmail: 'salon.manager@salon.demo',
    staffEmail: 'salon.staff@salon.demo',
    password: 'WalitShop@2026',
    commerceModes: ['service', 'sale'],
    hasRental: false,
    hasMembership: false,
  },
];

async function loginBusiness(
  slug: string,
  email: string,
  password: string,
): Promise<string | null> {
  const res = await apiCall<{ accessToken?: string }>('POST', `${API_BASE}/auth/login`, null, {
    tenantSlug: slug,
    email,
    password,
  });
  if (res.ok && res.data) {
    return (res.data as any)?.accessToken ?? null;
  }
  return null;
}

async function buildTokenMap(): Promise<Map<string, BusinessTokens>> {
  const map = new Map<string, BusinessTokens>();
  console.log('\n🔐 Building authentication token map...');
  for (const biz of BUSINESSES) {
    const [adminToken, managerToken, staffToken] = await Promise.all([
      loginBusiness(biz.slug, biz.adminEmail, biz.password),
      loginBusiness(biz.slug, biz.managerEmail, biz.password),
      loginBusiness(biz.slug, biz.staffEmail, biz.password),
    ]);
    map.set(biz.slug, {
      admin: adminToken,
      manager: managerToken,
      staff: staffToken,
      slug: biz.slug,
      name: biz.name,
    });
    const adminOk = adminToken ? '✅' : '❌';
    const mgrOk = managerToken ? '✅' : '❌';
    const stfOk = staffToken ? '✅' : '❌';
    console.log(`  ${biz.name.padEnd(12)} admin:${adminOk} manager:${mgrOk} staff:${stfOk}`);
  }
  return map;
}

async function runModule(
  moduleName: string,
  runner: () => Promise<TestResult[]>,
  allResults: TestResult[],
) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Running: ${moduleName}`);
  console.log('─'.repeat(60));
  try {
    const results = await runner();
    allResults.push(...results);
    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const blocked = results.filter(r => r.status === 'BLOCKED').length;
    console.log(`  Results: ${passed} PASS / ${failed} FAIL / ${blocked} BLOCKED (${results.length} total)`);
    return results;
  } catch (e) {
    console.error(`  [ERROR] ${moduleName} runner crashed:`, e);
    allResults.push({
      module: moduleName,
      business: 'All',
      test: `${moduleName} Runner`,
      expected: 'Tests complete',
      actual: `Runner crashed: ${String(e)}`,
      status: 'FAIL',
      severity: 'CRITICAL',
    });
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  const moduleFilter = args.find(a => a.startsWith('--module='))?.split('=')[1];

  console.log('');
  console.log('═'.repeat(60));
  console.log('  Universal POS — Automated Test Suite');
  console.log(`  Target: ${API_BASE}`);
  console.log(`  Time:   ${new Date().toISOString()}`);
  if (moduleFilter) console.log(`  Module: ${moduleFilter} (filtered)`);
  console.log('═'.repeat(60));

  const tokenMap = await buildTokenMap();
  const allResults: TestResult[] = [];

  const modules: Array<[string, () => Promise<TestResult[]>]> = [
    ['Authentication', () => runAuthTests(tokenMap)],
    ['Catalog', () => runCatalogTests(tokenMap)],
    ['Inventory', () => runInventoryTests(tokenMap)],
    ['Sales', () => runSalesTests(tokenMap)],
    ['Customer', () => runCustomerTests(tokenMap)],
    ['Rental', () => runRentalTests(tokenMap)],
    ['Membership', () => runMembershipTests(tokenMap)],
    ['Permissions', () => runPermissionsTests(tokenMap)],
    ['Tenant Isolation', () => runTenantIsolationTests(tokenMap)],
    ['Reports', () => runReportsTests(tokenMap)],
    ['Returns', () => runReturnsTests(tokenMap)],
    ['Pricing & UOM', () => runPricingUomTests(Object.fromEntries(tokenMap))],
  ];

  for (const [name, runner] of modules) {
    if (moduleFilter && !name.toLowerCase().includes(moduleFilter.toLowerCase())) continue;
    await runModule(name, runner, allResults);
  }

  const report = await generateReport(allResults, tokenMap);

  console.log('');
  console.log('═'.repeat(60));
  console.log('  FINAL RESULTS');
  console.log('═'.repeat(60));
  console.log(`  Total:   ${allResults.length}`);
  console.log(`  PASS:    ${allResults.filter(r => r.status === 'PASS').length}`);
  console.log(`  FAIL:    ${allResults.filter(r => r.status === 'FAIL').length}`);
  console.log(`  BLOCKED: ${allResults.filter(r => r.status === 'BLOCKED').length}`);
  console.log(`  PARTIAL: ${allResults.filter(r => r.status === 'PARTIAL').length}`);
  const passRate = allResults.length
    ? Math.round((allResults.filter(r => r.status === 'PASS').length / allResults.length) * 100)
    : 0;
  console.log(`  Pass %:  ${passRate}%`);
  console.log('');
  console.log(`  Verdict: ${report.verdict}`);
  console.log('');
  console.log(`  Report saved: ${report.path}`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
