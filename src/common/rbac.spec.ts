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

  it('captain can order on the floor but cannot refund, profit, or adjust stock', () => {
    const captain = SYSTEM_ROLE_PERMISSIONS.captain as string[];
    expect(captain).toContain('dining.floor');
    expect(captain).toContain('pos.checkout');
    expect(captain).not.toContain('refund.approve');
    expect(captain).not.toContain('reports.profit.read');
    expect(captain).not.toContain('catalog.cost.read');
    expect(captain).not.toContain('inventory.adjust');
  });

  it('kitchen can update KOT but cannot bill or see profit', () => {
    const kitchen = SYSTEM_ROLE_PERMISSIONS.kitchen as string[];
    expect(kitchen).toContain('kitchen.view');
    expect(kitchen).toContain('kitchen.update');
    expect(kitchen).not.toContain('pos.checkout');
    expect(kitchen).not.toContain('payments.take');
    expect(kitchen).not.toContain('reports.profit.read');
    expect(kitchen).not.toContain('refund.approve');
  });
});
