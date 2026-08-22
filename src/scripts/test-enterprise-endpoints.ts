import { PrismaClient } from '@prisma/client';
import { EnterpriseMetricsService } from '../modules/enterprise/enterprise-metrics.service';
import { EnterprisePrincipal } from '../modules/enterprise/enterprise.types';
import { DEFAULT_GROUP_ENTITLEMENTS } from '../common/entitlements';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: 'wajowap@mailinator.com' },
    include: {
      tenant: true,
    },
  });
  if (!user) {
    console.log('User wajowap not found');
    return;
  }

  const membership = await prisma.identityTenantMembership.findFirst({
    where: { userId: user.id },
    include: { identity: true },
  });

  const group = await prisma.businessGroup.findFirst({
    where: { ownerIdentityId: membership?.identityId },
    include: { tenants: true },
  });

  console.log('User:', user.fullName, 'Tenant:', user.tenant.name);
  console.log('Identity:', membership?.identity.email);
  console.log('Group:', group?.name, 'Tenants:', group?.tenants.map((t) => t.name));

  const principal: EnterprisePrincipal = {
    identityId: membership!.identityId,
    email: membership!.identity.email,
    fullName: membership!.identity.fullName,
    groupId: group!.id,
    groupRole: 'owner',
    entitlements: [...DEFAULT_GROUP_ENTITLEMENTS],
    tenantIds: group!.tenants.map((t) => t.id),
    shopUser: null,
  };

  const metrics = new EnterpriseMetricsService(prisma as any);

  console.log('\n--- 1. Testing Dashboard ---');
  const dash = await metrics.dashboard(principal, {});
  console.log('Dashboard KPIs:', dash.kpis);

  console.log('\n--- 2. Testing Group P&L ---');
  const pnl = await metrics.groupPnl(principal, {});
  console.log('Group P&L Totals:', pnl.group);
  console.log('Group P&L Businesses:', pnl.businesses);

  console.log('\n--- 3. Testing Comparison ---');
  const cmp = await metrics.comparison(principal, {});
  console.log('Comparison Rows:', cmp.rows);
}

main().finally(() => prisma.$disconnect());
