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
  commerceModes: string[];
  businessType?: string;
};

export function reportContextFromSettings(settings: unknown): ReportContext {
  const s = (settings ?? {}) as Record<string, unknown>;
  const modes = Array.isArray(s.commerceModes)
    ? s.commerceModes.filter((m): m is string => typeof m === 'string')
    : [];
  return {
    capabilities: resolveTenantCapabilities(settings),
    commerceModes: modes,
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
  return (
    reportHas(ctx, 'MEMBERSHIP') ||
    reportHas(ctx, 'SUBSCRIPTION') ||
    reportHas(ctx, 'CHECK_IN') ||
    ctx.commerceModes.includes('subscription')
  );
}

/** Rental utilization pack — any rentable-asset business, not clothing-only */
export function isRentalContext(ctx: ReportContext): boolean {
  return (
    reportHas(ctx, 'AVAILABILITY') ||
    reportHas(ctx, 'DAMAGE') ||
    reportHas(ctx, 'DEPOSIT') ||
    ctx.commerceModes.includes('rental')
  );
}

/** Which extra report packs this tenant should see (unknown industry OK). */
export function enabledReportPacks(ctx: ReportContext) {
  return {
    sale:
      ctx.commerceModes.includes('sale') ||
      ctx.commerceModes.length === 0 ||
      reportHas(ctx, 'INVENTORY') ||
      reportHas(ctx, 'BARCODE'),
    rental: isRentalContext(ctx),
    service:
      isServiceRevenueContext(ctx) || ctx.commerceModes.includes('service'),
    subscription: isMembershipContext(ctx),
    inventory: reportHas(ctx, 'INVENTORY'),
    kitchen: isKitchenContext(ctx),
  };
}
