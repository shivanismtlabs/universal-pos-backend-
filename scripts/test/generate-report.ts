/**
 * Report generator — produces a markdown + JSON test report
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TestResult, BusinessTokens } from './types';
import { API_BASE } from './test-runner';

export interface TestReport {
  path: string;
  verdict: string;
  passRate: number;
  summary: Record<string, { pass: number; fail: number; blocked: number; partial: number }>;
}

export async function generateReport(
  results: TestResult[],
  tokenMap: Map<string, BusinessTokens>,
): Promise<TestReport> {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const blocked = results.filter(r => r.status === 'BLOCKED').length;
  const partial = results.filter(r => r.status === 'PARTIAL').length;
  const total = results.length;
  const passRate = total ? Math.round((pass / total) * 100) : 0;

  const criticalFails = results.filter(r => r.status === 'FAIL' && r.severity === 'CRITICAL');
  const highFails = results.filter(r => r.status === 'FAIL' && r.severity === 'HIGH');

  let verdict: string;
  if (criticalFails.length > 0) {
    verdict = `❌ CRITICAL FAILURES (${criticalFails.length} critical issues require immediate attention)`;
  } else if (highFails.length > 5) {
    verdict = `⚠️  HIGH FAILURE RATE (${highFails.length} high-severity failures)`;
  } else if (passRate >= 90) {
    verdict = `✅ PASS (${passRate}% pass rate)`;
  } else if (passRate >= 70) {
    verdict = `⚠️  PARTIAL (${passRate}% pass rate — some issues need attention)`;
  } else {
    verdict = `❌ FAIL (${passRate}% pass rate — significant failures)`;
  }

  // Group by module
  const byModule = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byModule.has(r.module)) byModule.set(r.module, []);
    byModule.get(r.module)!.push(r);
  }

  // Group by business
  const byBusiness: Record<string, { pass: number; fail: number; blocked: number; partial: number }> = {};
  for (const r of results) {
    if (!byBusiness[r.business]) byBusiness[r.business] = { pass: 0, fail: 0, blocked: 0, partial: 0 };
    byBusiness[r.business][r.status.toLowerCase() as 'pass' | 'fail' | 'blocked' | 'partial']++;
  }

  // ─── Build markdown report ────────────────────────────────────────────
  const timestamp = new Date().toISOString();
  const lines: string[] = [];

  lines.push('# Universal POS — Automated Test Report');
  lines.push('');
  lines.push(`**Target:** \`${API_BASE}\``);
  lines.push(`**Generated:** ${timestamp}`);
  lines.push(`**Verdict:** ${verdict}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Tests | ${total} |`);
  lines.push(`| PASS | ${pass} (${passRate}%) |`);
  lines.push(`| FAIL | ${fail} |`);
  lines.push(`| BLOCKED | ${blocked} |`);
  lines.push(`| PARTIAL | ${partial} |`);
  lines.push(`| Critical Fails | ${criticalFails.length} |`);
  lines.push(`| High Fails | ${highFails.length} |`);
  lines.push('');

  // By business
  lines.push('## Results by Business');
  lines.push('');
  lines.push(`| Business | PASS | FAIL | BLOCKED | PARTIAL |`);
  lines.push(`|----------|------|------|---------|---------|`);
  for (const [biz, counts] of Object.entries(byBusiness)) {
    lines.push(`| ${biz} | ${counts.pass} | ${counts.fail} | ${counts.blocked} | ${counts.partial} |`);
  }
  lines.push('');

  // By module
  lines.push('## Results by Module');
  lines.push('');
  for (const [module, moduleResults] of byModule.entries()) {
    const mPass = moduleResults.filter(r => r.status === 'PASS').length;
    const mFail = moduleResults.filter(r => r.status === 'FAIL').length;
    const mBlocked = moduleResults.filter(r => r.status === 'BLOCKED').length;
    lines.push(`### ${module} — ${mPass}✅ ${mFail}❌ ${mBlocked}🚫`);
    lines.push('');
    lines.push(`| Status | Business | Test | Expected | Actual | Severity |`);
    lines.push(`|--------|----------|------|----------|--------|----------|`);
    for (const r of moduleResults) {
      const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : r.status === 'BLOCKED' ? '🚫' : '⚠️';
      const sev = r.severity ?? 'LOW';
      const actual = r.actual.replace(/\|/g, '\\|').slice(0, 80);
      const expected = r.expected.replace(/\|/g, '\\|').slice(0, 60);
      lines.push(`| ${icon} ${r.status} | ${r.business} | ${r.test} | ${expected} | ${actual} | ${sev} |`);
    }
    lines.push('');
  }

  // Critical failures section
  if (criticalFails.length > 0) {
    lines.push('## 🚨 Critical Failures');
    lines.push('');
    lines.push('> These MUST be fixed before production deployment.');
    lines.push('');
    for (const r of criticalFails) {
      lines.push(`- **[${r.module}] ${r.business} — ${r.test}**`);
      lines.push(`  - Expected: ${r.expected}`);
      lines.push(`  - Actual: ${r.actual}`);
      if (r.endpoint) lines.push(`  - Endpoint: \`${r.endpoint}\``);
      lines.push('');
    }
  }

  // High severity failures
  if (highFails.length > 0) {
    lines.push('## ⚠️ High Severity Failures');
    lines.push('');
    for (const r of highFails) {
      lines.push(`- **[${r.module}] ${r.business} — ${r.test}**: ${r.actual}`);
    }
    lines.push('');
  }

  // Performance results
  const perfResults = results.filter(r => r.test.includes('under') || r.test.includes('ms') || r.test.includes('—'));
  if (perfResults.length > 0) {
    lines.push('## ⚡ Performance Results');
    lines.push('');
    lines.push(`| Test | Business | Result | Status |`);
    lines.push(`|------|----------|--------|--------|`);
    for (const r of perfResults.filter(r => r.durationMs != null)) {
      lines.push(`| ${r.test} | ${r.business} | ${r.actual} | ${r.status === 'PASS' ? '✅' : '❌'} ${r.status} |`);
    }
    lines.push('');
  }

  // Business credentials
  lines.push('## Demo Credentials');
  lines.push('');
  lines.push(`All passwords: \`WalitShop@2026\``);
  lines.push('');
  lines.push(`| Business | Admin | Manager | Staff |`);
  lines.push(`|----------|-------|---------|-------|`);
  lines.push(`| Gym | gym.admin@gym.demo | gym.manager@gym.demo | gym.staff@gym.demo |`);
  lines.push(`| Grocery | grocery.admin@grocery.demo | grocery.manager@grocery.demo | grocery.staff@grocery.demo |`);
  lines.push(`| Rental | rental.admin@rental.demo | rental.manager@rental.demo | rental.staff@rental.demo |`);
  lines.push(`| Swimming | swimming.admin@swimming.demo | swimming.manager@swimming.demo | swimming.staff@swimming.demo |`);
  lines.push(`| Salon | salon.admin@salon.demo | salon.manager@salon.demo | salon.staff@salon.demo |`);
  lines.push('');

  // Save markdown
  const reportsDir = path.resolve(process.cwd(), 'test-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const mdPath = path.join(reportsDir, `test-report-${dateStr}.md`);
  const jsonPath = path.join(reportsDir, `test-report-${dateStr}.json`);

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8');
  fs.writeFileSync(jsonPath, JSON.stringify({ timestamp, verdict, passRate, pass, fail, blocked, partial, total, criticalFails, highFails, results }, null, 2), 'utf-8');

  // Also write a latest symlink-style copy
  fs.writeFileSync(path.join(reportsDir, 'latest.md'), lines.join('\n'), 'utf-8');
  fs.writeFileSync(path.join(reportsDir, 'latest.json'), JSON.stringify({ timestamp, verdict, passRate, pass, fail, blocked, partial, total, criticalFails, results }, null, 2), 'utf-8');

  console.log(`\n  📄 Report saved: ${mdPath}`);
  console.log(`  📊 JSON saved:   ${jsonPath}`);

  return { path: mdPath, verdict, passRate, summary: byBusiness };
}
