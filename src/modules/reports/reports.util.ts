/** Shared report date/money helpers */

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function pctChange(current: number, baseline: number): number | null {
  if (baseline === 0) return current === 0 ? 0 : null;
  return round2(((current - baseline) / Math.abs(baseline)) * 100);
}

/** Convert local wall-clock in `timeZone` on calendar day `ymd` to UTC Date. */
export function zonedLocalToUtc(
  ymd: string,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  const [y, mo, d] = ymd.split('-').map(Number);
  let utc = Date.UTC(y, mo - 1, d, hour, minute, second, ms);
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
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? '0');
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') === 24 ? 0 : get('hour'),
      get('minute'),
      get('second'),
    );
    const target = Date.UTC(y, mo - 1, d, hour, minute, second, ms);
    utc += target - asUtc;
  }
  return new Date(utc);
}

export function dayRange(
  ymd: string,
  timeZone: string,
): { start: Date; end: Date } {
  return {
    start: zonedLocalToUtc(ymd, 0, 0, 0, 0, timeZone),
    end: zonedLocalToUtc(ymd, 23, 59, 59, 999, timeZone),
  };
}

export function ymdInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function shiftMonth(
  year: number,
  month1to12: number,
  delta: number,
): { year: number; month: number } {
  const idx = year * 12 + (month1to12 - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

export function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export function monthLabel(year: number, month: number) {
  return `${year}-${pad2(month)}`;
}

/** Parse fiscal year start month (1–12) from tenant settings. Default April (4) if fiscal string set, else 1 (calendar). */
export function parseFiscalStartMonth(settings: unknown): number {
  const s =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {};
  if (typeof s.fiscalYearStartMonth === 'number') {
    const m = Math.floor(s.fiscalYearStartMonth);
    if (m >= 1 && m <= 12) return m;
  }
  const raw = s.fiscalYearStart;
  if (typeof raw === 'string' && raw.trim()) {
    const t = raw.trim();
    const mdy = t.match(/^(\d{1,2})/);
    if (mdy) {
      const m = Number(mdy[1]);
      if (m >= 1 && m <= 12) return m;
    }
    const names: Record<string, number> = {
      jan: 1,
      january: 1,
      feb: 2,
      february: 2,
      mar: 3,
      march: 3,
      apr: 4,
      april: 4,
      may: 5,
      jun: 6,
      june: 6,
      jul: 7,
      july: 7,
      aug: 8,
      august: 8,
      sep: 9,
      september: 9,
      oct: 10,
      october: 10,
      nov: 11,
      november: 11,
      dec: 12,
      december: 12,
    };
    const key = t.toLowerCase().split(/[^a-z]/)[0];
    if (names[key]) return names[key];
  }
  return 1;
}

export type ReportsSettings = {
  monthlyTargetAmount?: number | null;
  monthlyTargets?: Record<string, number>;
  monthlyEmail?: {
    enabled: boolean;
    recipients: string[];
    lastSentFor?: string | null;
  };
};

export function parseReportsSettings(settings: unknown): ReportsSettings {
  const root =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {};
  const reports =
    root.reports && typeof root.reports === 'object'
      ? (root.reports as Record<string, unknown>)
      : {};
  const email =
    reports.monthlyEmail && typeof reports.monthlyEmail === 'object'
      ? (reports.monthlyEmail as Record<string, unknown>)
      : {};
  const targets =
    reports.monthlyTargets && typeof reports.monthlyTargets === 'object'
      ? (reports.monthlyTargets as Record<string, number>)
      : {};
  return {
    monthlyTargetAmount:
      typeof reports.monthlyTargetAmount === 'number'
        ? reports.monthlyTargetAmount
        : null,
    monthlyTargets: targets,
    monthlyEmail: {
      enabled: Boolean(email.enabled),
      recipients: Array.isArray(email.recipients)
        ? email.recipients.filter((x): x is string => typeof x === 'string')
        : [],
      lastSentFor:
        typeof email.lastSentFor === 'string' ? email.lastSentFor : null,
    },
  };
}
