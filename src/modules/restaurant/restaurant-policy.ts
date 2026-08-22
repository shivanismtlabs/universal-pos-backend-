/**
 * Pure restaurant-pack rules — no Prisma, no businessType branching.
 * Inventory: KOT never deducts. Checkout posts consumption once.
 */

export const DINING_MODES = [
  'dine_in',
  'takeaway',
  'delivery',
  'pickup',
  'online',
] as const;

export type DiningModeCode = (typeof DINING_MODES)[number];

export const CONSUMPTION_POLICIES = ['order_finalize', 'kot_confirm'] as const;
export type ConsumptionPolicy = (typeof CONSUMPTION_POLICIES)[number];

export const KOT_STATUSES = [
  'new',
  'accepted',
  'preparing',
  'ready',
  'served',
  'cancelled',
] as const;

export type KotStatusCode = (typeof KOT_STATUSES)[number];

export const TABLE_STATUSES = [
  'available',
  'occupied',
  'reserved',
  'cleaning',
  'blocked',
] as const;

const KOT_TRANSITIONS: Record<KotStatusCode, KotStatusCode[]> = {
  new: ['accepted', 'preparing', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served', 'preparing', 'cancelled'],
  served: ['preparing'],
  cancelled: [],
};

export function isDiningMode(value: unknown): value is DiningModeCode {
  return (
    typeof value === 'string' &&
    (DINING_MODES as readonly string[]).includes(value)
  );
}

export function normalizeDiningModes(input: unknown): DiningModeCode[] {
  const raw = Array.isArray(input) ? input : [];
  const out = raw.filter(isDiningMode);
  return out.length ? [...new Set(out)] : ['dine_in', 'takeaway'];
}

export function normalizeConsumptionPolicy(value: unknown): ConsumptionPolicy {
  if (value === 'kot_confirm') return 'kot_confirm';
  return 'order_finalize';
}

/** KOT creation never posts inventory, regardless of policy. */
export function kotPostsInventory(): false {
  return false;
}

/**
 * Whether this event may post recipe/stock consumption.
 * Default: only order finalization (POS checkout). Configurable kot_confirm
 * is reserved for a future production event — still never both.
 */
export function shouldPostConsumption(opts: {
  policy: ConsumptionPolicy;
  event: 'kot_create' | 'kot_confirm' | 'order_finalize';
  alreadyPosted: boolean;
}): boolean {
  if (opts.alreadyPosted) return false;
  if (opts.event === 'kot_create') return false;
  if (opts.policy === 'order_finalize') {
    return opts.event === 'order_finalize';
  }
  return opts.event === 'kot_confirm';
}

export function canTransitionKot(
  from: KotStatusCode,
  to: KotStatusCode,
): boolean {
  if (from === to) return true;
  return (KOT_TRANSITIONS[from] ?? []).includes(to);
}

export function kotAgingBand(opts: {
  createdAt: Date;
  now?: Date;
  warnMinutes: number;
  criticalMinutes: number;
}): 'waiting' | 'delayed' | 'critical' {
  const now = opts.now ?? new Date();
  const warn = Math.max(1, opts.warnMinutes);
  const critical = Math.max(warn, opts.criticalMinutes);
  const elapsed = (now.getTime() - opts.createdAt.getTime()) / 60000;
  if (elapsed >= critical) return 'critical';
  if (elapsed >= warn) return 'delayed';
  return 'waiting';
}

export const WASTAGE_REASONS = [
  'spoilage',
  'overproduction',
  'burnt',
  'damaged',
  'expired',
  'complimentary',
  'staff_meal',
  'other',
] as const;

export type WastageReason = (typeof WASTAGE_REASONS)[number];

export const STOCK_CLASSES = [
  'raw_material',
  'ingredient',
  'packaging',
  'consumable',
  'semi_finished',
  'finished',
] as const;

export type StockClass = (typeof STOCK_CLASSES)[number];

const RECIPE_PURPOSES = new Set(['recipe', 'production']);

export function isRecipePurpose(purpose: string | null | undefined): boolean {
  return RECIPE_PURPOSES.has(String(purpose ?? '').trim().toLowerCase());
}

/** Qty to deduct from an ingredient, including recipe wastage %. */
export function recipeConsumeQty(opts: {
  componentQty: number;
  parentQty: number;
  wastagePercent?: number;
}): number {
  const pct = Math.max(0, Number(opts.wastagePercent ?? 0));
  return Number(opts.componentQty) * Number(opts.parentQty) * (1 + pct / 100);
}

export function recipeCostTotal(
  lines: Array<{ quantity: number; unitCost: number; wastagePercent?: number }>,
): number {
  return lines.reduce(
    (sum, l) =>
      sum +
      recipeConsumeQty({
        componentQty: l.quantity,
        parentQty: 1,
        wastagePercent: l.wastagePercent,
      }) *
        Number(l.unitCost ?? 0),
    0,
  );
}

export function foodCostPercent(
  recipeCost: number,
  sellPrice: number,
): number | null {
  if (!(sellPrice > 0)) return null;
  return (recipeCost / sellPrice) * 100;
}

export function foodMargin(
  sellPrice: number,
  recipeCost: number,
): { amount: number; percent: number | null } {
  const amount = sellPrice - recipeCost;
  return {
    amount,
    percent: sellPrice > 0 ? (amount / sellPrice) * 100 : null,
  };
}

export function normalizeWastageReason(raw: string | undefined): WastageReason {
  const v = String(raw ?? '').trim().toLowerCase();
  return (WASTAGE_REASONS as readonly string[]).includes(v)
    ? (v as WastageReason)
    : 'other';
}

export function canOpenTable(status: string): boolean {
  return status === 'available' || status === 'cleaning';
}

export function canMergeTables(opts: {
  sourceStatus: string;
  targetStatus: string;
  sourceOrderId?: string | null;
  targetOrderId?: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (opts.sourceStatus === 'blocked' || opts.targetStatus === 'blocked') {
    return { ok: false, reason: 'Blocked tables cannot be merged' };
  }
  if (!opts.sourceOrderId) {
    return { ok: false, reason: 'Source table has no open order' };
  }
  if (opts.sourceOrderId && opts.targetOrderId && opts.sourceOrderId === opts.targetOrderId) {
    return { ok: false, reason: 'Tables already share this order' };
  }
  return { ok: true };
}

/** Move/merge must keep a single order id — never clone. */
export function assertSingleOrderId(ids: Array<string | null | undefined>): string {
  const uniq = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (uniq.length !== 1) {
    throw new Error('Table operation would create or duplicate orders');
  }
  return uniq[0];
}

export const RESERVATION_STATUSES = [
  'booked',
  'seated',
  'cancelled',
  'no_show',
] as const;

export function canSeatReservation(status: string): boolean {
  return status === 'booked';
}

/** Guest table specials (water, cake, décor) — not a restaurant-only catalog. */
export const GUEST_OCCASIONS = [
  'none',
  'birthday',
  'anniversary',
  'celebration',
] as const;

export type GuestOccasion = (typeof GUEST_OCCASIONS)[number];

export const GUEST_REQUESTS = [
  'water',
  'cake',
  'decor',
  'candles',
  'extra_cutlery',
  'complimentary',
] as const;

export type GuestRequest = (typeof GUEST_REQUESTS)[number];

const GUEST_REQUEST_LABEL: Record<GuestRequest, string> = {
  water: 'Bottled water',
  cake: 'Cake',
  decor: 'Decoration',
  candles: 'Candles',
  extra_cutlery: 'Extra plates / cutlery',
  complimentary: 'Complimentary',
};

export type GuestSpecials = {
  occasion: Exclude<GuestOccasion, 'none'> | null;
  requests: GuestRequest[];
  note: string;
};

export function parseGuestSpecials(meta: unknown): GuestSpecials {
  const root =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  const raw =
    root.guestSpecials && typeof root.guestSpecials === 'object'
      ? (root.guestSpecials as Record<string, unknown>)
      : root;
  const occasionRaw = String(raw.occasion ?? 'none');
  const occasion =
    occasionRaw === 'birthday' ||
    occasionRaw === 'anniversary' ||
    occasionRaw === 'celebration'
      ? occasionRaw
      : null;
  const requests = Array.isArray(raw.requests)
    ? raw.requests.filter((x): x is GuestRequest =>
        GUEST_REQUESTS.includes(x as GuestRequest),
      )
    : [];
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  return { occasion, requests, note };
}

export function formatGuestSpecials(specials: GuestSpecials): string {
  const bits: string[] = [];
  if (specials.occasion) {
    bits.push(
      `Occasion: ${specials.occasion.replace(/^\w/, (c) => c.toUpperCase())}`,
    );
  }
  if (specials.requests.length) {
    bits.push(specials.requests.map((r) => GUEST_REQUEST_LABEL[r]).join(', '));
  }
  if (specials.note) bits.push(specials.note);
  return bits.join(' · ');
}

export function applyGuestSpecialsNote(
  existing: string | null | undefined,
  specialsText: string,
): string {
  const stripped = String(existing ?? '')
    .replace(/(?:^|\n)\s*\[Guest\][^\n]*/g, '')
    .trim();
  const guest = specialsText ? `[Guest] ${specialsText}` : '';
  return [stripped, guest].filter(Boolean).join('\n');
}

export function nextTokenNumber(last: number | null | undefined): number {
  return Math.max(0, Number(last ?? 0)) + 1;
}

/** Guest QR never posts inventory; checkout still does once. */
export function qrOrderPostsInventory(): false {
  return false;
}

export type DiningFeeLine = {
  feeCode: string;
  reason: string;
  amount: number;
};

/**
 * Dining pack extras on a ticket. Service is dine-in % of food after discount.
 * Packaging is takeaway/pickup/delivery/online. Delivery fee is delivery only.
 * Never keyed off businessType.
 */
export function diningFeesFromConfig(opts: {
  diningMode?: string | null;
  merchandiseAfterDiscount: number;
  serviceChargePercent?: number | null;
  packagingCharge?: number | null;
  deliveryCharge?: number | null;
  areaTaxPercent?: number | null;
}): DiningFeeLine[] {
  const mode = opts.diningMode ?? '';
  const base = Math.max(0, Number(opts.merchandiseAfterDiscount) || 0);
  const fees: DiningFeeLine[] = [];
  const servicePct = Number(opts.serviceChargePercent);
  if (
    mode === 'dine_in' &&
    Number.isFinite(servicePct) &&
    servicePct > 0 &&
    base > 0
  ) {
    const amount = Math.round(((base * servicePct) / 100) * 100) / 100;
    if (amount > 0) {
      fees.push({
        feeCode: 'service_charge',
        reason: `Service ${servicePct}%`,
        amount,
      });
    }
  }
  const pack = Number(opts.packagingCharge);
  if (
    (mode === 'takeaway' ||
      mode === 'pickup' ||
      mode === 'delivery' ||
      mode === 'online') &&
    Number.isFinite(pack) &&
    pack > 0
  ) {
    fees.push({
      feeCode: 'packaging',
      reason: 'Packaging',
      amount: Math.round(pack * 100) / 100,
    });
  }
  const delivery = Number(opts.deliveryCharge);
  if (mode === 'delivery' && Number.isFinite(delivery) && delivery > 0) {
    fees.push({
      feeCode: 'delivery',
      reason: 'Delivery',
      amount: Math.round(delivery * 100) / 100,
    });
  }
  const areaTax = Number(opts.areaTaxPercent);
  if (Number.isFinite(areaTax) && areaTax > 0 && base > 0) {
    const amount = Math.round(((base * areaTax) / 100) * 100) / 100;
    if (amount > 0) {
      fees.push({
        feeCode: 'area_tax',
        reason: `Area tax ${areaTax}%`,
        amount,
      });
    }
  }
  return fees;
}

export type FloorDiningSettings = {
  categoryIds: string[];
  taxRatePercent: number | null;
  serviceChargePercent: number | null;
};

function optionalPercent(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseFloorDiningSettings(meta: unknown): FloorDiningSettings {
  const m =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  const categoryIds = Array.isArray(m.categoryIds)
    ? m.categoryIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return {
    categoryIds,
    taxRatePercent: optionalPercent(m.taxRatePercent),
    serviceChargePercent: optionalPercent(m.serviceChargePercent),
  };
}

export function parseTableLayout(meta: unknown): {
  layoutX: number | null;
  layoutY: number | null;
} {
  const m =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  const x = Number(m.layoutX);
  const y = Number(m.layoutY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { layoutX: null, layoutY: null };
  }
  return {
    layoutX: Math.min(90, Math.max(0, x)),
    layoutY: Math.min(90, Math.max(0, y)),
  };
}

export type StationKitchenSettings = {
  categoryIds: string[];
  printerName: string | null;
};

export function parseStationKitchenSettings(meta: unknown): StationKitchenSettings {
  const m =
    meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : {};
  const categoryIds = Array.isArray(m.categoryIds)
    ? m.categoryIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const printer =
    typeof m.printerName === 'string' ? m.printerName.trim() : '';
  return {
    categoryIds,
    printerName: printer.length ? printer : null,
  };
}

/** First station whose area menu includes this category; else fallback. */
export function routeItemToStationId(
  categoryId: string | null | undefined,
  stations: Array<{ id: string; categoryIds: string[] }>,
  fallbackStationId?: string | null,
): string | null {
  if (categoryId) {
    const hit = stations.find((s) => s.categoryIds.includes(categoryId));
    if (hit) return hit.id;
  }
  return fallbackStationId ?? stations[0]?.id ?? null;
}

export type SellingMenu = {
  id: string;
  name: string;
  categoryIds: string[];
  locationId: string | null;
  channel: 'pos' | 'qr' | 'all';
  isActive: boolean;
  days: number[];
  startTime: string | null;
  endTime: string | null;
};

export function parseSellingMenus(input: unknown): SellingMenu[] {
  const raw = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).sellingMenus
      : null;
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const r = row as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name.trim() : '';
      if (!name) return null;
      const channel =
        r.channel === 'pos' || r.channel === 'qr' || r.channel === 'all'
          ? r.channel
          : 'all';
      const days = Array.isArray(r.days)
        ? r.days
            .map((d) => Number(d))
            .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
      const start = typeof r.startTime === 'string' ? r.startTime : '';
      const end = typeof r.endTime === 'string' ? r.endTime : '';
      return {
        id:
          typeof r.id === 'string' && r.id.length > 0
            ? r.id
            : `menu-${name.toLowerCase().replace(/\s+/g, '-')}`,
        name,
        categoryIds: Array.isArray(r.categoryIds)
          ? r.categoryIds.filter(
              (id): id is string => typeof id === 'string' && id.length > 0,
            )
          : [],
        locationId:
          typeof r.locationId === 'string' && r.locationId.length > 0
            ? r.locationId
            : null,
        channel,
        isActive: r.isActive !== false,
        days,
        startTime: start.length >= 4 ? start : null,
        endTime: end.length >= 4 ? end : null,
      } satisfies SellingMenu;
    })
    .filter((m): m is SellingMenu => m != null);
}

export function sellingMenuIsLive(
  menu: SellingMenu,
  opts: {
    channel: 'pos' | 'qr';
    locationId?: string | null;
    now?: Date;
  },
): boolean {
  if (!menu.isActive) return false;
  if (menu.channel !== 'all' && menu.channel !== opts.channel) return false;
  if (menu.locationId && menu.locationId !== opts.locationId) return false;
  const now = opts.now ?? new Date();
  if (menu.days.length && !menu.days.includes(now.getDay())) return false;
  if (menu.startTime && menu.endTime) {
    const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const start = menu.startTime.slice(0, 5);
    const end = menu.endTime.slice(0, 5);
    if (t < start || t > end) return false;
  }
  return true;
}

/** No lists configured → no restriction. Lists exist but none live → empty set. */
export function sellingMenuCategoryFilter(opts: {
  menus: SellingMenu[];
  channel: 'pos' | 'qr';
  locationId?: string | null;
  now?: Date;
}): { restrict: false } | { restrict: true; categoryIds: string[] } {
  const defined = opts.menus.filter(
    (m) =>
      (m.channel === 'all' || m.channel === opts.channel) &&
      (!m.locationId || m.locationId === opts.locationId),
  );
  if (!defined.length) return { restrict: false };
  const live = defined.filter((m) => sellingMenuIsLive(m, opts));
  if (!live.length) return { restrict: true, categoryIds: [] };
  if (live.some((m) => m.categoryIds.length === 0)) return { restrict: false };
  return {
    restrict: true,
    categoryIds: [...new Set(live.flatMap((m) => m.categoryIds))],
  };
}
