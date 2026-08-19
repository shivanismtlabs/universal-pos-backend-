import type { AuthUser } from '../auth/types';

export type GroupRole = 'owner' | 'finance' | 'auditor' | 'member';

export type EnterprisePrincipal = {
  identityId: string;
  email: string;
  fullName: string;
  groupId: string;
  groupRole: GroupRole;
  entitlements: string[];
  tenantIds: string[];
  /** Shop session when caller used access token; null for identity-only */
  shopUser: AuthUser | null;
};

export function canSeeGroupFinance(p: EnterprisePrincipal) {
  return p.groupRole === 'owner' || p.groupRole === 'finance';
}

export function canSeeGroupAudit(p: EnterprisePrincipal) {
  return (
    p.groupRole === 'owner' ||
    p.groupRole === 'auditor' ||
    p.groupRole === 'finance'
  );
}

export function canOperateGroup(p: EnterprisePrincipal) {
  return p.groupRole === 'owner';
}

export function isGroupMemberOfTenant(
  p: EnterprisePrincipal,
  tenantId: string,
) {
  return p.tenantIds.includes(tenantId);
}
