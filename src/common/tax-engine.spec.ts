import { TaxMode } from '@prisma/client';
import {
  buildTaxProfile,
  computeInvoiceTax,
  computeLineTax,
} from './tax-engine';

describe('tax-engine', () => {
  it('applies exclusive GST 5% on line', () => {
    const profile = buildTaxProfile({
      taxMode: TaxMode.in_gst,
      settings: { tax: { ratePercent: 5, inclusive: false } },
    });
    const line = computeLineTax(profile, { lineGross: 100 });
    expect(line.lineTotal.toFixed(2)).toBe('100.00');
    expect(line.taxAmount.toFixed(2)).toBe('5.00');
  });

  it('extracts inclusive tax from line', () => {
    const profile = buildTaxProfile({
      taxMode: TaxMode.in_gst,
      settings: { tax: { ratePercent: 18, inclusive: true } },
    });
    const line = computeLineTax(profile, { lineGross: 118 });
    expect(line.lineTotal.toFixed(2)).toBe('100.00');
    expect(line.taxAmount.toFixed(2)).toBe('18.00');
  });

  it('returns zero tax when taxMode is none', () => {
    const profile = buildTaxProfile({
      taxMode: TaxMode.none,
      settings: { tax: { ratePercent: 18 } },
    });
    expect(profile.rate).toBe(0);
    const line = computeLineTax(profile, { lineGross: 100 });
    expect(line.taxAmount.toFixed(2)).toBe('0.00');
  });

  it('computes invoice tax from profile', () => {
    const profile = buildTaxProfile({
      taxMode: TaxMode.in_gst,
      settings: { tax: { ratePercent: 5 } },
    });
    expect(computeInvoiceTax(profile, 200).totalTax).toBe(10);
  });
});
