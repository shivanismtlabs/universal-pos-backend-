import { parseEntitlements, hasEntitlement } from './entitlements';

describe('enterprise entitlements', () => {
  it('does not scatter plan === enterprise checks — uses entitlement codes', () => {
    const raw = ['GROUP_DASHBOARD', 'GROUP_PNL', 'APPROVAL_ENGINE'];
    expect(hasEntitlement(raw, 'GROUP_PNL')).toBe(true);
    expect(hasEntitlement(raw, 'SSO')).toBe(false);
    expect(parseEntitlements(raw).size).toBe(3);
  });

  it('ignores junk values', () => {
    expect(hasEntitlement([1, null, ''] as unknown[], 'GROUP_DASHBOARD')).toBe(
      false,
    );
  });
});
