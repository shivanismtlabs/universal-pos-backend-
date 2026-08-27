import { ean13CheckDigit, parseScaleBarcode } from './barcode';

describe('parseScaleBarcode', () => {
  it('parses code*qty', () => {
    const p = parseScaleBarcode('RICE01*1.275');
    expect(p).toEqual({ itemCode: 'RICE01', quantity: '1.275' });
  });

  it('parses in-store EAN-13 grams (prefix 2)', () => {
    const d12 = '212345600127';
    const ean = d12 + ean13CheckDigit(d12);
    const p = parseScaleBarcode(ean);
    expect(p?.itemCode).toBe('123456');
    expect(p?.quantity).toBe('127');
    expect(p?.unitHint).toBe('g');
  });

  it('returns null for a plain SKU', () => {
    expect(parseScaleBarcode('SKU-100')).toBeNull();
  });
});
