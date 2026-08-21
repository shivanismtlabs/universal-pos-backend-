import {
  canMergeTables,
  canTransitionKot,
  foodCostPercent,
  foodMargin,
  isRecipePurpose,
  kotAgingBand,
  kotPostsInventory,
  nextTokenNumber,
  normalizeDiningModes,
  normalizeWastageReason,
  qrOrderPostsInventory,
  recipeConsumeQty,
  recipeCostTotal,
  shouldPostConsumption,
  canSeatReservation,
} from './restaurant-policy';

describe('restaurant pack policy', () => {
  it('does not treat restaurant as a commerce mode — dining modes are pack config', () => {
    expect(normalizeDiningModes(['dine_in', 'bogus', 'takeaway'])).toEqual([
      'dine_in',
      'takeaway',
    ]);
  });

  it('KOT creation never posts inventory', () => {
    expect(kotPostsInventory()).toBe(false);
    expect(
      shouldPostConsumption({
        policy: 'order_finalize',
        event: 'kot_create',
        alreadyPosted: false,
      }),
    ).toBe(false);
    expect(
      shouldPostConsumption({
        policy: 'kot_confirm',
        event: 'kot_create',
        alreadyPosted: false,
      }),
    ).toBe(false);
  });

  it('default policy posts consumption once at order finalize', () => {
    expect(
      shouldPostConsumption({
        policy: 'order_finalize',
        event: 'order_finalize',
        alreadyPosted: false,
      }),
    ).toBe(true);
    expect(
      shouldPostConsumption({
        policy: 'order_finalize',
        event: 'order_finalize',
        alreadyPosted: true,
      }),
    ).toBe(false);
  });

  it('does not allow illegal KOT transitions or silent cancel', () => {
    expect(canTransitionKot('new', 'served')).toBe(false);
    expect(canTransitionKot('new', 'cancelled')).toBe(true);
    expect(canTransitionKot('cancelled', 'new')).toBe(false);
    expect(canTransitionKot('ready', 'preparing')).toBe(true);
  });

  it('uses configured aging thresholds', () => {
    const createdAt = new Date('2026-08-21T10:00:00Z');
    expect(
      kotAgingBand({
        createdAt,
        now: new Date('2026-08-21T10:05:00Z'),
        warnMinutes: 10,
        criticalMinutes: 20,
      }),
    ).toBe('waiting');
    expect(
      kotAgingBand({
        createdAt,
        now: new Date('2026-08-21T10:12:00Z'),
        warnMinutes: 10,
        criticalMinutes: 20,
      }),
    ).toBe('delayed');
    expect(
      kotAgingBand({
        createdAt,
        now: new Date('2026-08-21T10:25:00Z'),
        warnMinutes: 10,
        criticalMinutes: 20,
      }),
    ).toBe('critical');
  });

  it('refuses merge that would duplicate or invent orders', () => {
    expect(
      canMergeTables({
        sourceStatus: 'occupied',
        targetStatus: 'occupied',
        sourceOrderId: 'a',
        targetOrderId: 'a',
      }).ok,
    ).toBe(false);
    expect(
      canMergeTables({
        sourceStatus: 'occupied',
        targetStatus: 'available',
        sourceOrderId: 'a',
        targetOrderId: null,
      }).ok,
    ).toBe(true);
  });

  it('recipe consumption includes wastage percent and never treats grocery as recipe', () => {
    expect(isRecipePurpose('recipe')).toBe(true);
    expect(isRecipePurpose('bundle')).toBe(false);
    expect(isRecipePurpose(undefined)).toBe(false);
    expect(
      recipeConsumeQty({ componentQty: 0.1, parentQty: 2, wastagePercent: 10 }),
    ).toBeCloseTo(0.22);
    expect(
      recipeCostTotal([
        { quantity: 0.2, unitCost: 50, wastagePercent: 0 },
        { quantity: 0.05, unitCost: 100, wastagePercent: 20 },
      ]),
    ).toBeCloseTo(16);
    expect(foodCostPercent(40, 100)).toBe(40);
    expect(foodMargin(100, 40)).toEqual({ amount: 60, percent: 60 });
    expect(normalizeWastageReason('burnt')).toBe('burnt');
    expect(normalizeWastageReason('mystery')).toBe('other');
  });

  it('Phase 3: token sequence, reservations, QR never deducts stock', () => {
    expect(nextTokenNumber(null)).toBe(1);
    expect(nextTokenNumber(7)).toBe(8);
    expect(canSeatReservation('booked')).toBe(true);
    expect(canSeatReservation('cancelled')).toBe(false);
    expect(qrOrderPostsInventory()).toBe(false);
    expect(kotPostsInventory()).toBe(false);
  });
});
