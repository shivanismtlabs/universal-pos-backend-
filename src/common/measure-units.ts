/**
 * Tenant units of measure (Zoho-style Units).
 * Stored on tenant.settings.units — same catalog for any commerce mode.
 */

export type MeasureUnit = {
  code: string;
  name: string;
  decimalQty: boolean;
  active: boolean;
  system: boolean;
};

export const MEASURE_UNIT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

export const DEFAULT_MEASURE_UNITS: MeasureUnit[] = [
  { code: 'pcs', name: 'Piece', decimalQty: false, active: true, system: true },
  { code: 'pack', name: 'Pack / box', decimalQty: false, active: true, system: true },
  { code: 'box', name: 'Box', decimalQty: false, active: true, system: true },
  { code: 'carton', name: 'Carton', decimalQty: false, active: true, system: true },
  { code: 'dozen', name: 'Dozen', decimalQty: false, active: true, system: true },
  { code: 'pair', name: 'Pair', decimalQty: false, active: true, system: true },
  { code: 'set', name: 'Set', decimalQty: false, active: true, system: true },
  { code: 'kg', name: 'Kilogram', decimalQty: true, active: true, system: true },
  { code: 'g', name: 'Gram', decimalQty: false, active: true, system: true },
  { code: 'mg', name: 'Milligram', decimalQty: true, active: true, system: true },
  { code: 't', name: 'Tonne', decimalQty: true, active: true, system: true },
  { code: 'L', name: 'Litre', decimalQty: true, active: true, system: true },
  { code: 'ml', name: 'Millilitre', decimalQty: false, active: true, system: true },
  { code: 'm3', name: 'Cubic metre', decimalQty: true, active: true, system: true },
  { code: 'lb', name: 'Pound', decimalQty: true, active: true, system: true },
  { code: 'oz', name: 'Ounce', decimalQty: true, active: true, system: true },
  { code: 'm', name: 'Metre', decimalQty: true, active: true, system: true },
  { code: 'cm', name: 'Centimetre', decimalQty: true, active: true, system: true },
  { code: 'm2', name: 'Square metre', decimalQty: true, active: true, system: true },
  { code: 'hour', name: 'Hour', decimalQty: true, active: true, system: true },
  { code: 'day', name: 'Day', decimalQty: false, active: true, system: true },
  { code: 'week', name: 'Week', decimalQty: true, active: true, system: true },
  { code: 'month', name: 'Month', decimalQty: true, active: true, system: true },
  { code: 'service', name: 'Service', decimalQty: false, active: true, system: true },
];

export function isMeasureUnitCode(v: unknown): v is string {
  return typeof v === 'string' && MEASURE_UNIT_CODE_RE.test(v.trim());
}

function asUnit(raw: unknown): MeasureUnit | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const code = String(o.code ?? '').trim();
  if (!isMeasureUnitCode(code)) return null;
  const name = String(o.name ?? code).trim().slice(0, 80) || code;
  return {
    code,
    name,
    decimalQty: o.decimalQty === true,
    active: o.active !== false,
    system: o.system === true,
  };
}

export function parseMeasureUnits(settings: unknown): MeasureUnit[] {
  const root =
    settings && typeof settings === 'object'
      ? (settings as Record<string, unknown>)
      : {};
  const raw = root.units;
  const custom: MeasureUnit[] = [];
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const u = asUnit(row);
      if (u) custom.push(u);
    }
  }
  const byCode = new Map<string, MeasureUnit>();
  for (const d of DEFAULT_MEASURE_UNITS) byCode.set(d.code, { ...d });
  for (const u of custom) {
    const prev = byCode.get(u.code);
    if (prev?.system) {
      byCode.set(u.code, {
        ...prev,
        name: u.name || prev.name,
        decimalQty: u.decimalQty,
        active: u.active,
        system: true,
      });
    } else {
      byCode.set(u.code, { ...u, system: prev?.system ?? u.system });
    }
  }
  return [...byCode.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

export function decimalQtyForUnit(
  unit: string,
  units: MeasureUnit[] = DEFAULT_MEASURE_UNITS,
): boolean {
  const code = unit.trim();
  const found = units.find((u) => u.code === code);
  if (found) return found.decimalQty;
  return DEFAULT_MEASURE_UNITS.some((u) => u.code === code && u.decimalQty);
}
