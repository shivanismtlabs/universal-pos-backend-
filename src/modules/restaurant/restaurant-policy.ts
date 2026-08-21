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

export function nextTokenNumber(last: number | null | undefined): number {
  return Math.max(0, Number(last ?? 0)) + 1;
}

/** Guest QR never posts inventory; checkout still does once. */
export function qrOrderPostsInventory(): false {
  return false;
}
