/**
 * Capability-driven report helpers — prefer these over businessType === 'salon'.
 */

import {
  hasCapability,
  resolveTenantCapabilities,
  type CapabilityCode,
} from './capabilities';

export type ReportContext = {
  capabilities: CapabilityCode[];
  businessType?: string;
};

export function reportContextFromSettings(settings: unknown): ReportContext {
  const s = (settings ?? {}) as Record<string, unknown>;
  return {
    capabilities: resolveTenantCapabilities(settings),
    businessType:
      typeof s.businessType === 'string' ? s.businessType : undefined,
  };
}

export function reportHas(
  ctx: ReportContext | CapabilityCode[],
  code: CapabilityCode,
): boolean {
  const list = Array.isArray(ctx) ? ctx : ctx.capabilities;
  return hasCapability(list, code);
}

/** Service-shaped revenue (appointments / staff performance columns) */
export function isServiceRevenueContext(ctx: ReportContext): boolean {
  return (
    reportHas(ctx, 'BOOKING') ||
    reportHas(ctx, 'STAFF_ASSIGNMENT') ||
    reportHas(ctx, 'REPAIR_JOB')
  );
}

/** F&B / kitchen-shaped columns */
export function isKitchenContext(ctx: ReportContext): boolean {
  return reportHas(ctx, 'KITCHEN') || reportHas(ctx, 'KOT') || reportHas(ctx, 'TABLE');
}

/** Membership / subscription report pack */
export function isMembershipContext(ctx: ReportContext): boolean {
  return reportHas(ctx, 'MEMBERSHIP') || reportHas(ctx, 'SUBSCRIPTION');
}

/** Rental utilization pack */
export function isRentalContext(ctx: ReportContext): boolean {
  return reportHas(ctx, 'AVAILABILITY') || reportHas(ctx, 'DAMAGE');
}
