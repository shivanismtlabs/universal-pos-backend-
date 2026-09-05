import {
  addServiceDuration,
  resolveDurationSemantics,
  getZonedDateParts,
  type DurationSemantics,
} from '../../common/service-duration';
import { calculateLineAmount, type ProductPricingRef, type UnitRef } from '../catalog/pricing-engine';

describe('Universal Service Duration UOM Engine & Calendar Arithmetic', () => {
  describe('Duration Semantics Resolution (Metadata-Driven)', () => {
    it('resolves fixed_time semantics for minute, hour, day, week without hardcoded branch statements', () => {
      const minSem = resolveDurationSemantics({ unitCode: 'min' });
      expect(minSem.unitType).toBe('fixed_time');
      expect(minSem.fixedMinutes).toBe(1);
      expect(minSem.defaultAllowFraction).toBe(true);

      const hourSem = resolveDurationSemantics({ unitCode: 'hour' });
      expect(hourSem.unitType).toBe('fixed_time');
      expect(hourSem.fixedMinutes).toBe(60);
      expect(hourSem.defaultAllowFraction).toBe(true);

      const daySem = resolveDurationSemantics({ unitCode: 'day' });
      expect(daySem.unitType).toBe('fixed_time');
      expect(daySem.fixedMinutes).toBe(1440);

      const weekSem = resolveDurationSemantics({ unitCode: 'week' });
      expect(weekSem.unitType).toBe('fixed_time');
      expect(weekSem.fixedMinutes).toBe(10080);
    });

    it('resolves calendar_period semantics for month, quarter, year', () => {
      const monthSem = resolveDurationSemantics({ unitCode: 'month' });
      expect(monthSem.unitType).toBe('calendar_period');
      expect(monthSem.calendarMonths).toBe(1);

      const qtrSem = resolveDurationSemantics({ unitCode: 'quarter' });
      expect(qtrSem.unitType).toBe('calendar_period');
      expect(qtrSem.calendarMonths).toBe(3);

      const yearSem = resolveDurationSemantics({ unitCode: 'year' });
      expect(yearSem.unitType).toBe('calendar_period');
      expect(yearSem.calendarMonths).toBe(12);
    });

    it('resolves commercial_count semantics for session and visit without implicit time conversion', () => {
      const sessionSem = resolveDurationSemantics({ unitCode: 'session' });
      expect(sessionSem.unitType).toBe('commercial_count');

      const visitSem = resolveDurationSemantics({ unitCode: 'visit' });
      expect(visitSem.unitType).toBe('commercial_count');
    });

    it('resolves custom duration units from explicit metadata', () => {
      const customSem = resolveDurationSemantics({
        unitCode: 'bi-month',
        meta: { durationType: 'calendar_period', calendarMonths: 2, allowFraction: false },
      });
      expect(customSem.unitType).toBe('calendar_period');
      expect(customSem.calendarMonths).toBe(2);
    });
  });

  describe('Calendar Validity & Month-End Clamping', () => {
    it('calculates Jan 15 + 1 month = Feb 15', () => {
      const start = new Date('2026-01-15T10:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'month',
        timeZone: 'UTC',
      });
      expect(end.toISOString()).toBe('2026-02-15T10:00:00.000Z');
    });

    it('calculates Sep 15 + 1 month = Oct 15', () => {
      const start = new Date('2026-09-15T00:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'month',
        timeZone: 'UTC',
      });
      expect(end.toISOString()).toBe('2026-10-15T00:00:00.000Z');
    });

    it('calculates Sep 15 + 3 months = Dec 15', () => {
      const start = new Date('2026-09-15T00:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 3,
        durationUnitCode: 'month',
        timeZone: 'UTC',
      });
      expect(end.toISOString()).toBe('2026-12-15T00:00:00.000Z');
    });

    it('calculates Sep 15, 2026 + 1 year = Sep 15, 2027', () => {
      const start = new Date('2026-09-15T00:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'year',
        timeZone: 'UTC',
      });
      expect(end.toISOString()).toBe('2027-09-15T00:00:00.000Z');
    });

    it('clamps Jan 31 + 1 month to Feb 28 in non-leap years (2026)', () => {
      const start = new Date('2026-01-31T12:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'month',
        timeZone: 'UTC',
      });
      expect(end.toISOString()).toBe('2026-02-28T12:00:00.000Z');
    });

    it('clamps Jan 31 + 1 month to Feb 29 in leap years (2028)', () => {
      const start = new Date('2028-01-31T12:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'month',
        timeZone: 'UTC',
      });
      expect(end.toISOString()).toBe('2028-02-29T12:00:00.000Z');
    });

    it('clamps Aug 31 + 1 month to Sep 30', () => {
      const start = new Date('2026-08-31T09:30:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'month',
        timeZone: 'UTC',
      });
      expect(end.toISOString()).toBe('2026-09-30T09:30:00.000Z');
    });
  });

  describe('Fixed Physical Duration Date Progression', () => {
    it('advances 1 hour by 60 minutes', () => {
      const start = new Date('2026-09-15T10:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'hour',
      });
      expect(end.toISOString()).toBe('2026-09-15T11:00:00.000Z');
    });

    it('advances 1.5 hours by 90 minutes', () => {
      const start = new Date('2026-09-15T10:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1.5,
        durationUnitCode: 'hour',
      });
      expect(end.toISOString()).toBe('2026-09-15T11:30:00.000Z');
    });

    it('advances 1 day by 24 hours (1440 minutes)', () => {
      const start = new Date('2026-09-15T10:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'day',
      });
      expect(end.toISOString()).toBe('2026-09-16T10:00:00.000Z');
    });

    it('advances 7 days and 1 week identically', () => {
      const start = new Date('2026-09-15T10:00:00.000Z');
      const end7d = addServiceDuration({
        startDate: start,
        quantity: 7,
        durationUnitCode: 'day',
      });
      const end1w = addServiceDuration({
        startDate: start,
        quantity: 1,
        durationUnitCode: 'week',
      });
      expect(end7d.toISOString()).toBe('2026-09-22T10:00:00.000Z');
      expect(end1w.toISOString()).toBe(end7d.toISOString());
    });
  });

  describe('Session / Commercial Count Separation', () => {
    it('does NOT convert session/visit count to time unless configured', () => {
      const start = new Date('2026-09-15T10:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 2,
        durationUnitCode: 'session',
      });
      // Start date is preserved without arbitrary minute progression
      expect(end.getTime()).toBe(start.getTime());
    });

    it('applies explicit session duration if configured (e.g. 60 min per session)', () => {
      const start = new Date('2026-09-15T10:00:00.000Z');
      const end = addServiceDuration({
        startDate: start,
        quantity: 2,
        durationUnitCode: 'session',
        sessionDurationMinutes: 60,
      });
      expect(end.toISOString()).toBe('2026-09-15T12:00:00.000Z');
    });
  });

  describe('Service Duration Pricing & Universal UOM Calculations', () => {
    const unitHour: UnitRef = {
      id: 'u-hour',
      symbol: 'hour',
      unitGroupId: 'grp-time',
      unitGroupCode: 'TIME',
      conversionToGroupBase: '60',
      isActive: true,
    };

    const unitDay: UnitRef = {
      id: 'u-day',
      symbol: 'day',
      unitGroupId: 'grp-time',
      unitGroupCode: 'TIME',
      conversionToGroupBase: '1440',
      isActive: true,
    };

    const unitMonth: UnitRef = {
      id: 'u-month',
      symbol: 'month',
      unitGroupId: 'grp-time',
      unitGroupCode: 'TIME',
      conversionToGroupBase: '43200',
      isActive: true,
    };

    const unitYear: UnitRef = {
      id: 'u-year',
      symbol: 'year',
      unitGroupId: 'grp-time',
      unitGroupCode: 'TIME',
      conversionToGroupBase: '525600',
      isActive: true,
    };

    const unitsById = new Map<string, UnitRef>([
      [unitHour.id, unitHour],
      [unitDay.id, unitDay],
      [unitMonth.id, unitMonth],
      [unitYear.id, unitYear],
    ]);

    it('Example A: Annual Pool Membership ₹15,000/year (1 year = ₹15,000)', () => {
      const annualPoolService: ProductPricingRef = {
        id: 'prod-annual-pool',
        baseUnitId: unitYear.id,
        pricingUnitId: unitYear.id,
        pricePerPricingUnit: '15000.00',
        basePrice: '15000.00',
        productUnits: [
          {
            unitId: unitYear.id,
            conversionToBase: '1',
            fixedPrice: null,
            effectiveFrom: new Date('2020-01-01'),
            effectiveTo: null,
            isDefaultSellingUnit: true,
          },
        ],
      };

      const result = calculateLineAmount({
        product: annualPoolService,
        enteredQty: 1,
        sellingUnit: unitYear,
        unitsById,
      });

      expect(result.orderedQuantity.toString()).toBe('1');
      expect(result.orderedUnitSymbol).toBe('year');
      expect(result.lineTotal.toFixed(2)).toBe('15000.00');
      expect(result.finalAmount.toFixed(2)).toBe('15000.00');
    });

    it('Example B: Monthly Membership ₹1,500/month (3 months = ₹4,500)', () => {
      const monthlyGymService: ProductPricingRef = {
        id: 'prod-monthly-gym',
        baseUnitId: unitMonth.id,
        pricingUnitId: unitMonth.id,
        pricePerPricingUnit: '1500.00', // ₹1,500 / month
        basePrice: '1500.00',
        productUnits: [
          {
            unitId: unitMonth.id,
            conversionToBase: '1',
            fixedPrice: null,
            effectiveFrom: new Date('2020-01-01'),
            effectiveTo: null,
            isDefaultSellingUnit: true,
          },
        ],
      };

      const result = calculateLineAmount({
        product: monthlyGymService,
        enteredQty: 3,
        sellingUnit: unitMonth,
        unitsById,
      });

      expect(result.orderedQuantity.toString()).toBe('3');
      expect(result.orderedUnitSymbol).toBe('month');
      expect(result.lineTotal.toFixed(2)).toBe('4500.00');
      expect(result.finalAmount.toFixed(2)).toBe('4500.00');
    });

    it('Example C: Daily Pool Pass ₹500/day (2 days = ₹1,000)', () => {
      const dailyPassService: ProductPricingRef = {
        id: 'prod-daily-pass',
        baseUnitId: unitDay.id,
        pricingUnitId: unitDay.id,
        pricePerPricingUnit: '500.00',
        basePrice: '500.00',
        productUnits: [
          {
            unitId: unitDay.id,
            conversionToBase: '1',
            fixedPrice: null,
            effectiveFrom: new Date('2020-01-01'),
            effectiveTo: null,
            isDefaultSellingUnit: true,
          },
        ],
      };

      const result = calculateLineAmount({
        product: dailyPassService,
        enteredQty: 2,
        sellingUnit: unitDay,
        unitsById,
      });

      expect(result.orderedQuantity.toString()).toBe('2');
      expect(result.orderedUnitSymbol).toBe('day');
      expect(result.lineTotal.toFixed(2)).toBe('1000.00');
      expect(result.finalAmount.toFixed(2)).toBe('1000.00');
    });

    it('Example D: Swimming Coaching ₹500/hour (1.5 hours = ₹750 when fractional allowed)', () => {
      const coachingService: ProductPricingRef = {
        id: 'prod-swim-coaching',
        baseUnitId: unitHour.id,
        pricingUnitId: unitHour.id,
        pricePerPricingUnit: '500.00',
        basePrice: '500.00',
        productUnits: [
          {
            unitId: unitHour.id,
            conversionToBase: '1',
            fixedPrice: null,
            effectiveFrom: new Date('2020-01-01'),
            effectiveTo: null,
            allowFraction: true,
            isDefaultSellingUnit: true,
          },
        ],
      };

      const result = calculateLineAmount({
        product: coachingService,
        enteredQty: 1.5,
        sellingUnit: unitHour,
        unitsById,
      });

      expect(result.orderedQuantity.toString()).toBe('1.5');
      expect(result.orderedUnitSymbol).toBe('hour');
      expect(result.lineTotal.toFixed(2)).toBe('750.00');
      expect(result.finalAmount.toFixed(2)).toBe('750.00');
    });
  });
});
