import { resolveFiscalStartMonth } from '../../common/fiscal-year';

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

/** Parse fiscal year start month (1–12) from tenant settings. */
export function parseFiscalStartMonth(settings: unknown): number {
  return resolveFiscalStartMonth(settings);
}

export const REPORT_SCHEDULE_KEYS = [
  'sales_summary',
  'daily_sales',
  'rental_ops',
  'subscriptions',
  'inventory_utilization',
] as const;

export type ReportScheduleKey = (typeof REPORT_SCHEDULE_KEYS)[number];

export type ReportScheduleCadence = 'daily' | 'weekly' | 'monthly';

export type ReportSchedule = {
  id: string;
  reportKey: ReportScheduleKey;
  cadence: ReportScheduleCadence;
  recipients: string[];
  enabled: boolean;
  lastSentFor: string | null;
};

export type ReportsSettings = {
  monthlyTargetAmount?: number | null;
  monthlyTargets?: Record<string, number>;
  monthlyEmail?: {
    enabled: boolean;
    recipients: string[];
    lastSentFor?: string | null;
  };
  schedules?: ReportSchedule[];
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
    schedules: parseReportSchedules(reports.schedules),
  };
}

export function parseReportSchedules(raw: unknown): ReportSchedule[] {
  if (!Array.isArray(raw)) return [];
  const keys = REPORT_SCHEDULE_KEYS as readonly string[];
  const out: ReportSchedule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const reportKey = String(row.reportKey ?? '');
    const cadence = String(row.cadence ?? '');
    if (!keys.includes(reportKey)) continue;
    if (cadence !== 'daily' && cadence !== 'weekly' && cadence !== 'monthly') {
      continue;
    }
    const recipients = Array.isArray(row.recipients)
      ? row.recipients.filter((x): x is string => typeof x === 'string')
      : [];
    out.push({
      id:
        typeof row.id === 'string' && row.id.trim()
          ? row.id
          : `sch-${out.length + 1}`,
      reportKey: reportKey as ReportScheduleKey,
      cadence,
      recipients,
      enabled: row.enabled !== false,
      lastSentFor:
        typeof row.lastSentFor === 'string' ? row.lastSentFor : null,
    });
  }
  return out;
}

function csvCell(v: string | number | null | undefined) {
  const s = v == null ? '' : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** UTF-8 CSV (with BOM) for report file downloads. */
export function rowsToCsv(
  rows: Array<Array<string | number | null | undefined>>,
) {
  return (
    '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}

export function salesSummaryToCsv(data: {
  from?: string | null;
  to?: string | null;
  locationId?: string | null;
  byStatus?: Array<{ status: string; count: number }>;
  byKind?: Array<{
    kind: string;
    count: number;
    subtotal?: unknown;
    taxTotal?: unknown;
    balanceDue?: unknown;
  }>;
  totals?: {
    orderCount?: number;
    subtotal?: unknown;
    taxTotal?: unknown;
    balanceDue?: unknown;
  };
}) {
  const rows: Array<Array<string | number | null | undefined>> = [
    ['section', 'metric', 'value'],
    ['sales', 'from', data.from ?? ''],
    ['sales', 'to', data.to ?? ''],
    ['sales', 'location_id', data.locationId ?? 'all'],
    ['sales', 'order_count', data.totals?.orderCount ?? 0],
    ['sales', 'subtotal', Number(data.totals?.subtotal ?? 0)],
    ['sales', 'tax_total', Number(data.totals?.taxTotal ?? 0)],
    ['sales', 'balance_due', Number(data.totals?.balanceDue ?? 0)],
  ];
  for (const r of data.byStatus ?? []) {
    rows.push(['orders_by_status', r.status, r.count]);
  }
  for (const r of data.byKind ?? []) {
    rows.push([
      'orders_by_kind',
      r.kind,
      `${r.count}|${Number(r.subtotal ?? 0)}`,
    ]);
  }
  return rowsToCsv(rows);
}
