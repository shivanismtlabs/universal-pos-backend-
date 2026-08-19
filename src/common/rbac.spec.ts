import { SYSTEM_ROLE_PERMISSIONS, hasPermission } from './rbac';

describe('granular ACL atoms', () => {
  it('cashier can sell but cannot see profit or cost', () => {
    const cashier = SYSTEM_ROLE_PERMISSIONS.cashier as string[];
    expect(cashier).toContain('pos.checkout');
    expect(cashier).not.toContain('reports.profit.read');
    expect(cashier).not.toContain('catalog.cost.read');
    expect(cashier).not.toContain('refund.approve');
    expect(hasPermission(cashier, 'reports.profit.read')).toBe(false);
  });

  it('manager does not automatically receive profit/cost read', () => {
    const manager = SYSTEM_ROLE_PERMISSIONS.manager as string[];
    expect(manager).toContain('pos.checkout');
    expect(manager).not.toContain('reports.profit.read');
    expect(manager).not.toContain('catalog.cost.read');
    expect(manager).toContain('refund.approve');
  });

  it('accountant can read group finance', () => {
    const acc = SYSTEM_ROLE_PERMISSIONS.accountant as string[];
    expect(acc).toContain('reports.profit.read');
    expect(acc).toContain('reports.finance.read');
    expect(acc).toContain('catalog.cost.read');
  });
});
