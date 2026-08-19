/**
 * Centralized enterprise entitlements — never scatter `if (plan === 'enterprise')`.
 * Stored on BusinessGroup.entitlements (string[]) and optionally Plan.features.entitlements.
 */
export const ENTERPRISE_ENTITLEMENTS = [
  'GROUP_DASHBOARD',
  'GROUP_PNL',
  'GROUP_INVENTORY',
  'GROUP_PROCUREMENT',
  'GROUP_CUSTOMERS',
  'APPROVAL_ENGINE',
  'ADVANCED_AUDIT',
  'EXCEPTION_ALERTS',
  'BUSINESS_COMPARISON',
  'INTERCOMPANY',
  'SPIN_OFF',
  'API_ACCESS',
  'WEBHOOKS',
  'SSO',
] as const;

export type EnterpriseEntitlement = (typeof ENTERPRISE_ENTITLEMENTS)[number];

/** P0/P1 capabilities a group owner needs for All Businesses to work */
export const DEFAULT_GROUP_ENTITLEMENTS: EnterpriseEntitlement[] = [
  'GROUP_DASHBOARD',
  'GROUP_PNL',
  'GROUP_INVENTORY',
  'GROUP_PROCUREMENT',
  'GROUP_CUSTOMERS',
  'APPROVAL_ENGINE',
  'ADVANCED_AUDIT',
  'EXCEPTION_ALERTS',
  'BUSINESS_COMPARISON',
  'INTERCOMPANY',
  'SPIN_OFF',
];

export const ENTERPRISE_PLAN_ENTITLEMENTS: EnterpriseEntitlement[] = [
  ...DEFAULT_GROUP_ENTITLEMENTS,
  'API_ACCESS',
  'WEBHOOKS',
  'SSO',
];

export function parseEntitlements(raw: unknown): Set<string> {
  const set = new Set<string>();
  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x === 'string' && x.trim()) set.add(x.trim());
    }
  }
  return set;
}

export function hasEntitlement(
  raw: unknown,
  code: EnterpriseEntitlement | string,
): boolean {
  return parseEntitlements(raw).has(code);
}
