/**
 * Universal POS — Universal Service Duration UOM Engine.
 *
 * Implements generic duration and validity semantics:
 * 1. Fixed-duration units (minute, hour, day, week): exact physical conversions.
 * 2. Calendar-duration units (month, quarter, year): calendar-aware date progression with
 *    timezone safety and business-safe month-end clamping (e.g. Jan 31 + 1 mo = Feb 28/29).
 * 3. Commercial count units (session, visit, service): discrete quantities that do not assume
 *    implicit time conversions unless an explicit session duration is configured.
 *
 * All operations are metadata/type driven without unit-name special casing.
 */

export type DurationUnitType = 'fixed_time' | 'calendar_period' | 'commercial_count';

export interface DurationSemantics {
  unitType: DurationUnitType;
  /** For fixed_time: duration in minutes per 1 unit */
  fixedMinutes?: number;
  /** For calendar_period: number of calendar months per 1 unit */
  calendarMonths?: number;
  /** Whether fractional quantities are allowed by default for this unit type */
  defaultAllowFraction?: boolean;
}

/**
 * Generic duration semantics registry.
 * Maps UOM symbols/codes to duration semantics.
 */
export const DURATION_SEMANTICS_REGISTRY: Record<string, DurationSemantics> = {
  // Fixed physical durations
  min: { unitType: 'fixed_time', fixedMinutes: 1, defaultAllowFraction: true },
  minute: { unitType: 'fixed_time', fixedMinutes: 1, defaultAllowFraction: true },
  minutes: { unitType: 'fixed_time', fixedMinutes: 1, defaultAllowFraction: true },
  m: { unitType: 'fixed_time', fixedMinutes: 1, defaultAllowFraction: true },
  hour: { unitType: 'fixed_time', fixedMinutes: 60, defaultAllowFraction: true },
  hours: { unitType: 'fixed_time', fixedMinutes: 60, defaultAllowFraction: true },
  hr: { unitType: 'fixed_time', fixedMinutes: 60, defaultAllowFraction: true },
  h: { unitType: 'fixed_time', fixedMinutes: 60, defaultAllowFraction: true },
  day: { unitType: 'fixed_time', fixedMinutes: 1440, defaultAllowFraction: true },
  days: { unitType: 'fixed_time', fixedMinutes: 1440, defaultAllowFraction: true },
  d: { unitType: 'fixed_time', fixedMinutes: 1440, defaultAllowFraction: true },
  week: { unitType: 'fixed_time', fixedMinutes: 10080, defaultAllowFraction: false },
  weeks: { unitType: 'fixed_time', fixedMinutes: 10080, defaultAllowFraction: false },
  wk: { unitType: 'fixed_time', fixedMinutes: 10080, defaultAllowFraction: false },

  // Calendar periods (calendar month arithmetic with month-end clamping)
  month: { unitType: 'calendar_period', calendarMonths: 1, defaultAllowFraction: false },
  months: { unitType: 'calendar_period', calendarMonths: 1, defaultAllowFraction: false },
  mo: { unitType: 'calendar_period', calendarMonths: 1, defaultAllowFraction: false },
  quarter: { unitType: 'calendar_period', calendarMonths: 3, defaultAllowFraction: false },
  quarters: { unitType: 'calendar_period', calendarMonths: 3, defaultAllowFraction: false },
  qtr: { unitType: 'calendar_period', calendarMonths: 3, defaultAllowFraction: false },
  year: { unitType: 'calendar_period', calendarMonths: 12, defaultAllowFraction: false },
  years: { unitType: 'calendar_period', calendarMonths: 12, defaultAllowFraction: false },
  yr: { unitType: 'calendar_period', calendarMonths: 12, defaultAllowFraction: false },

  // Commercial / Session count units
  session: { unitType: 'commercial_count', defaultAllowFraction: false },
  sessions: { unitType: 'commercial_count', defaultAllowFraction: false },
  visit: { unitType: 'commercial_count', defaultAllowFraction: false },
  visits: { unitType: 'commercial_count', defaultAllowFraction: false },
  service: { unitType: 'commercial_count', defaultAllowFraction: false },
  services: { unitType: 'commercial_count', defaultAllowFraction: false },
  pcs: { unitType: 'commercial_count', defaultAllowFraction: false },
};

/**
 * Resolve duration semantics generically from unit metadata or fallback registry.
 */
export function resolveDurationSemantics(opts: {
  unitCode?: string;
  unitGroupCode?: string;
  conversionToGroupBase?: number;
  meta?: Record<string, unknown>;
}): DurationSemantics {
  const code = (opts.unitCode ?? '').trim().toLowerCase();

  // 1. Direct registry match
  if (code && DURATION_SEMANTICS_REGISTRY[code]) {
    return DURATION_SEMANTICS_REGISTRY[code];
  }

  // 2. Explicit metadata declaration on the unit
  if (opts.meta) {
    if (opts.meta.durationType === 'calendar_period') {
      return {
        unitType: 'calendar_period',
        calendarMonths: Number(opts.meta.calendarMonths ?? 1) || 1,
        defaultAllowFraction: Boolean(opts.meta.allowFraction),
      };
    }
    if (opts.meta.durationType === 'fixed_time') {
      return {
        unitType: 'fixed_time',
        fixedMinutes: Number(opts.meta.fixedMinutes ?? opts.conversionToGroupBase ?? 1) || 1,
        defaultAllowFraction: opts.meta.allowFraction !== false,
      };
    }
    if (opts.meta.durationType === 'commercial_count') {
      return {
        unitType: 'commercial_count',
        defaultAllowFraction: Boolean(opts.meta.allowFraction),
      };
    }
  }

  // 3. Group-based fallback
  const group = (opts.unitGroupCode ?? '').toUpperCase();
  if (group === 'TIME') {
    return {
      unitType: 'fixed_time',
      fixedMinutes: Number(opts.conversionToGroupBase ?? 1) || 1,
      defaultAllowFraction: true,
    };
  }

  return {
    unitType: 'commercial_count',
    defaultAllowFraction: false,
  };
}

/**
 * Extract zoned calendar date parts using the Intl API.
 */
export function getZonedDateParts(date: Date, timeZone = 'UTC') {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour') === 24 ? 0 : get('hour'),
      minute: get('minute'),
      second: get('second'),
      ms: date.getUTCMilliseconds(),
    };
  } catch {
    // Fallback if timezone string is invalid
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      ms: date.getUTCMilliseconds(),
    };
  }
}

/**
 * Convert local date components in `timeZone` to UTC Date.
 */
export function zonedPartsToUtc(
  year: number,
  month1to12: number,
  day1to31: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone = 'UTC',
): Date {
  let utc = Date.UTC(year, month1to12 - 1, day1to31, hour, minute, second, ms);
  if (timeZone === 'UTC') return new Date(utc);

  try {
    for (let i = 0; i < 3; i++) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(utc));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
      const asUtc = Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour') === 24 ? 0 : get('hour'),
        get('minute'),
        get('second'),
      );
      const target = Date.UTC(year, month1to12 - 1, day1to31, hour, minute, second, ms);
      utc += target - asUtc;
    }
  } catch {
    // Fallback to naive UTC on error
  }
  return new Date(utc);
}

/**
 * Add service/membership duration using the duration semantics model.
 *
 * - Calendar durations advance by whole calendar months/years with timezone safety and month-end clamping.
 * - Fixed durations advance by exact millisecond intervals.
 * - Commercial count units (session, visit) do not perform implicit time conversions.
 */
export function addServiceDuration(opts: {
  startDate: Date;
  quantity: number;
  durationUnitCode?: string;
  semantics?: DurationSemantics;
  unitGroupCode?: string;
  timeZone?: string;
  /** Explicit duration configured for a session (e.g. 60 min per session) */
  sessionDurationMinutes?: number | null;
}): Date {
  const { startDate, quantity, timeZone = 'UTC' } = opts;
  if (!Number.isFinite(quantity) || quantity <= 0) return new Date(startDate);

  const semantics =
    opts.semantics ??
    resolveDurationSemantics({
      unitCode: opts.durationUnitCode,
      unitGroupCode: opts.unitGroupCode,
    });

  if (semantics.unitType === 'calendar_period') {
    const calendarMonthsPerUnit = semantics.calendarMonths ?? 1;
    const totalMonthsToAdd = Math.floor(quantity * calendarMonthsPerUnit);

    const parts = getZonedDateParts(startDate, timeZone);
    const targetMonthIndex = parts.month - 1 + totalMonthsToAdd;
    const targetYear = parts.year + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12 + 1; // 1-12

    // Month-end clamping (e.g. Jan 31 + 1 mo -> Feb 28/29)
    const maxDaysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
    const targetDay = Math.min(parts.day, maxDaysInTargetMonth);

    return zonedPartsToUtc(
      targetYear,
      targetMonth,
      targetDay,
      parts.hour,
      parts.minute,
      parts.second,
      parts.ms,
      timeZone,
    );
  }

  if (semantics.unitType === 'fixed_time') {
    const minutesPerUnit = semantics.fixedMinutes ?? 1;
    // For whole day/week intervals in service/membership context, advance calendar days preserving wall-clock time in timeZone
    if (minutesPerUnit >= 1440 && Number.isInteger(quantity * (minutesPerUnit / 1440))) {
      const daysToAdd = Math.round(quantity * (minutesPerUnit / 1440));
      const parts = getZonedDateParts(startDate, timeZone);
      const tempUtc = Date.UTC(parts.year, parts.month - 1, parts.day + daysToAdd);
      const tempDate = new Date(tempUtc);
      return zonedPartsToUtc(
        tempDate.getUTCFullYear(),
        tempDate.getUTCMonth() + 1,
        tempDate.getUTCDate(),
        parts.hour,
        parts.minute,
        parts.second,
        parts.ms,
        timeZone,
      );
    }
    const totalMinutes = quantity * minutesPerUnit;
    return new Date(startDate.getTime() + Math.round(totalMinutes * 60 * 1000));
  }

  // Commercial / Session count:
  // Only convert to time if the service configuration explicitly specified session duration
  if (semantics.unitType === 'commercial_count' && opts.sessionDurationMinutes != null && opts.sessionDurationMinutes > 0) {
    const totalMinutes = quantity * opts.sessionDurationMinutes;
    return new Date(startDate.getTime() + Math.round(totalMinutes * 60 * 1000));
  }

  // Without explicit session duration, return start date (no arbitrary time assumed)
  return new Date(startDate);
}
