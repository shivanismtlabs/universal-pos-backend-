/**
 * Rental unit lifecycle helpers — maps operational labels to StockUnitStatus
 * without requiring a Prisma enum migration.
 *
 * Spec labels → DB enum:
 *   available → available
 *   reserved → reserved
 *   ready → available (+ reservation held until handover)
 *   checked_out → checked_out
 *   returned → cleaning | available (via return/inspect flow)
 *   inspection → cleaning (in_service used for maintenance)
 *   maintenance → repair
 *   damaged → repair (condition=damaged)
 *   lost → lost
 *   retired → retired
 */
import { StockUnitStatus } from "@prisma/client";

/** Statuses that may be considered for a date range (still subject to reservation overlap). */
export const RENTABLE_UNIT_STATUSES: StockUnitStatus[] = [
  StockUnitStatus.available,
  StockUnitStatus.reserved,
];

/** Statuses that block any new reservation / checkout regardless of dates. */
export const BLOCKED_UNIT_STATUSES: StockUnitStatus[] = [
  StockUnitStatus.checked_out,
  StockUnitStatus.in_service,
  StockUnitStatus.cleaning,
  StockUnitStatus.repair,
  StockUnitStatus.retired,
  StockUnitStatus.sold,
  StockUnitStatus.lost,
];

export type RentalFeeConfig = {
  lateFeePerDay: number;
  cleaningFee: number;
  damageFeeDefault: number;
  lateFeeEnabled: boolean;
};

export function readRentalFeeConfig(meta: unknown): RentalFeeConfig {
  const m =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  const lateFeePerDay = Number(m.lateFeePerDay ?? m.late_fee_per_day ?? 0);
  const cleaningFee = Number(m.cleaningFee ?? m.cleaning_fee ?? 0);
  const damageFeeDefault = Number(
    m.damageFeeDefault ?? m.damage_fee ?? m.replacementCharge ?? 0,
  );
  const lateFeeEnabled =
    m.lateFeeEnabled === false || m.late_fee_enabled === false
      ? false
      : true;
  return {
    lateFeePerDay: Number.isFinite(lateFeePerDay) ? Math.max(0, lateFeePerDay) : 0,
    cleaningFee: Number.isFinite(cleaningFee) ? Math.max(0, cleaningFee) : 0,
    damageFeeDefault: Number.isFinite(damageFeeDefault)
      ? Math.max(0, damageFeeDefault)
      : 0,
    lateFeeEnabled,
  };
}

/** Whole calendar days late (0 if on/before due). */
export function daysLate(returnDue: Date, actualReturn: Date): number {
  const a = Date.UTC(
    returnDue.getUTCFullYear(),
    returnDue.getUTCMonth(),
    returnDue.getUTCDate(),
  );
  const b = Date.UTC(
    actualReturn.getUTCFullYear(),
    actualReturn.getUTCMonth(),
    actualReturn.getUTCDate(),
  );
  return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000)));
}

export function calcLateFee(opts: {
  returnDue: Date | null | undefined;
  actualReturn?: Date;
  feeConfig: RentalFeeConfig;
  overrideAmount?: number | null;
}): { daysLate: number; suggested: number; applicable: boolean } {
  if (!opts.returnDue || !opts.feeConfig.lateFeeEnabled) {
    return { daysLate: 0, suggested: 0, applicable: false };
  }
  const late = daysLate(opts.returnDue, opts.actualReturn ?? new Date());
  if (late <= 0) {
    return { daysLate: 0, suggested: 0, applicable: false };
  }
  const suggested =
    opts.overrideAmount != null && Number.isFinite(opts.overrideAmount)
      ? Math.max(0, Number(opts.overrideAmount))
      : Math.round(late * opts.feeConfig.lateFeePerDay * 100) / 100;
  return { daysLate: late, suggested, applicable: suggested > 0 };
}
