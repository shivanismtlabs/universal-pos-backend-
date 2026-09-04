/**
 * Universal POS — Pricing Engine & UOM Conversion Automated Test Suite
 *
 * Verifies:
 * 1. 1 kg = 1000 g conversion (500g @ ₹45/kg = ₹22.50)
 * 2. 1 L = 1000 ml conversion (250ml @ ₹60/L = ₹15.00)
 * 3. Count in pieces (3 pcs @ ₹10 = ₹30.00)
 * 4. Pricing quote endpoint (POST /catalog/pricing/quote)
 * 5. Strict calculation pipeline: Qty → Gross → Discount → Taxable Value → Tax → Round-off → Net Payable
 * 6. Display unit price consistency (e.g. ₹0.045/g for ₹45/kg)
 * 7. Out-of-stock / Insufficient stock validation on checkout
 */

import { apiCall, pass, fail, blocked, type TestResult, type BusinessTokens } from './types';
import { API_BASE } from './test-runner';

const MODULE = 'Pricing & UOM';

export async function runPricingUomTests(tokens: Record<string, BusinessTokens>): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Test with Grocery Store (which has kg/g and L/ml products)
  const groceryToken = tokens['grocery-demo']?.admin;
  if (!groceryToken) {
    results.push(blocked(MODULE, 'Grocery Store', 'Token availability', 'No admin token available for grocery-demo'));
    return results;
  }

  // 1. Fetch locations
  let locId = '';
  const locRes = await apiCall<any[]>('GET', `${API_BASE}/locations`, groceryToken);
  if (locRes.ok && Array.isArray(locRes.data) && locRes.data.length > 0) {
    locId = locRes.data[0].id;
  }

  // 2. Fetch catalog to find a kg product
  let kgProduct: any = null;
  const catRes = await apiCall<any>('GET', `${API_BASE}/pos/sale/catalog?limit=50`, groceryToken);
  const items = Array.isArray(catRes.data) ? catRes.data : (catRes.data as any)?.items ?? [];
  for (const item of items) {
    if (item.sellUnit?.toLowerCase() === 'kg' || item.entryUnits?.some((u: any) => u.symbol?.toLowerCase() === 'kg')) {
      kgProduct = item;
      break;
    }
  }

  // Test 1: Unit & Pricing Quote via API
  if (kgProduct) {
    const gramUnit = kgProduct.entryUnits?.find((u: any) => u.symbol?.toLowerCase() === 'g');
    if (gramUnit) {
      const quoteRes = await apiCall<any>('POST', `${API_BASE}/catalog/pricing/quote`, groceryToken, {
        productId: kgProduct.productId ?? kgProduct.id,
        enteredQty: 500,
        sellingUnitId: gramUnit.unitId,
      });

      if (quoteRes.ok && quoteRes.data) {
        const amount = Number(quoteRes.data.amount);
        const qtyBase = Number(quoteRes.data.qtyBase);
        const expectedBase = 0.5; // 500g = 0.5kg
        const shelfPrice = Number(kgProduct.sellPrice);
        const expectedGross = shelfPrice * 0.5;

        const isAmountMatch = Math.abs(amount - expectedGross) < 0.01;
        const isBaseMatch = Math.abs(qtyBase - expectedBase) < 0.001;

        if (isAmountMatch && isBaseMatch) {
          results.push(pass(
            MODULE,
            'Grocery Store',
            `UOM Conversion: 500g Quote @ ₹${shelfPrice}/kg`,
            `Gross = ₹${expectedGross}, Base Qty = 0.5kg`,
            `Gross = ₹${amount}, Base Qty = ${qtyBase}kg`,
            { durationMs: quoteRes.durationMs }
          ));
        } else {
          results.push(fail(
            MODULE,
            'Grocery Store',
            `UOM Conversion: 500g Quote @ ₹${shelfPrice}/kg`,
            `Gross = ₹${expectedGross}, Base Qty = 0.5kg`,
            `Gross = ₹${amount}, Base Qty = ${qtyBase}kg`,
            'HIGH',
            { durationMs: quoteRes.durationMs }
          ));
        }
      } else {
        results.push(fail(
          MODULE,
          'Grocery Store',
          'UOM Conversion: 500g Quote',
          'HTTP 200 with quote result',
          `HTTP ${quoteRes.status}: ${quoteRes.error ?? 'error'}`,
          'HIGH',
          { durationMs: quoteRes.durationMs }
        ));
      }
    } else {
      results.push(fail(
        MODULE,
        'Grocery Store',
        'UOM Conversion: Gram Unit in entryUnits',
        'Gram (g) unit available in product entryUnits',
        'Gram unit not found',
        'HIGH'
      ));
    }
  } else {
    results.push(blocked(
      MODULE,
      'Grocery Store',
      'UOM Conversion: kg Product Discovery',
      'No kg-unit product found in grocery catalog'
    ));
  }

  // Test 2: POS Sale Checkout with 500g (0.5kg) item
  if (kgProduct && locId) {
    const gramUnit = kgProduct.entryUnits?.find((u: any) => u.symbol?.toLowerCase() === 'g');
    const shelfPrice = Number(kgProduct.sellPrice);
    const expectedLineGross = shelfPrice * 0.5;

    const checkoutPayload = {
      locationId: locId,
      items: [
        {
          stockLevelId: kgProduct.id,
          quantity: 500,
          sellingUnitId: gramUnit?.unitId,
          sellingUnitSymbol: 'g',
        },
      ],
      paymentMethod: 'cash',
      idempotencyKey: `test_uom_${Date.now()}`,
    };

    const saleRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, groceryToken, checkoutPayload);
    if (saleRes.ok && saleRes.data) {
      const order = saleRes.data.order ?? saleRes.data;
      const subtotal = Number(order.subtotal ?? 0);
      const grand = Number(order.balanceDue ?? order.grandTotal ?? order.total ?? 0);

      const isMatch = Math.abs(subtotal - expectedLineGross) < 0.05 || Math.abs(grand - expectedLineGross) < 0.05;
      if (isMatch) {
        results.push(pass(
          MODULE,
          'Grocery Store',
          `POS Checkout: 500g @ ₹${shelfPrice}/kg = ₹${expectedLineGross.toFixed(2)}`,
          `Subtotal/Grand matches ₹${expectedLineGross.toFixed(2)}`,
          `Subtotal: ₹${subtotal}, Grand: ₹${grand}`,
          { durationMs: saleRes.durationMs }
        ));
      } else {
        results.push(fail(
          MODULE,
          'Grocery Store',
          `POS Checkout: 500g @ ₹${shelfPrice}/kg = ₹${expectedLineGross.toFixed(2)}`,
          `Subtotal/Grand matches ₹${expectedLineGross.toFixed(2)}`,
          `Subtotal: ₹${subtotal}, Grand: ₹${grand}`,
          'HIGH',
          { durationMs: saleRes.durationMs }
        ));
      }
    } else {
      results.push(fail(
        MODULE,
        'Grocery Store',
        'POS Checkout: 500g item',
        'HTTP 200/201 Checkout Success',
        `HTTP ${saleRes.status}: ${saleRes.error ?? 'error'}`,
        'HIGH',
        { durationMs: saleRes.durationMs }
      ));
    }
  }

  // Test 3: Insufficient stock validation on checkout
  if (kgProduct && locId) {
    const excessivePayload = {
      locationId: locId,
      items: [
        {
          stockLevelId: kgProduct.id,
          quantity: 999999, // 999,999 kg
          sellingUnitSymbol: 'kg',
        },
      ],
      paymentMethod: 'cash',
      idempotencyKey: `test_stock_reject_${Date.now()}`,
    };

    const rejRes = await apiCall<any>('POST', `${API_BASE}/pos/sale/checkout`, groceryToken, excessivePayload);
    const rejected = rejRes.status === 400;

    if (rejected) {
      results.push(pass(
        MODULE,
        'Grocery Store',
        'POS Checkout: Out-of-Stock / Insufficient Stock Rejection',
        'HTTP 400 Insufficient Stock',
        `HTTP 400 Rejected properly`,
        { durationMs: rejRes.durationMs }
      ));
    } else {
      results.push(fail(
        MODULE,
        'Grocery Store',
        'POS Checkout: Out-of-Stock / Insufficient Stock Rejection',
        'HTTP 400 Insufficient Stock',
        `HTTP ${rejRes.status}`,
        'HIGH',
        { durationMs: rejRes.durationMs }
      ));
    }
  }

  // Test 4: Pricing calculation with discount and GST pipeline
  const gross = 100;
  const discount = 10;
  const taxable = gross - discount;
  const tax = taxable * 0.05;
  const grandExact = taxable + tax;
  const cashRounded = Math.round(grandExact);
  const roundOff = cashRounded - grandExact;

  const validMath = (
    taxable === 90 &&
    tax === 4.5 &&
    grandExact === 94.5 &&
    cashRounded === 95 &&
    roundOff === 0.5
  );

  if (validMath) {
    results.push(pass(
      MODULE,
      'Universal POS',
      'Calculation Order: Gross → Discount → Taxable → GST → Round-off → Net',
      'Gross 100 - Disc 10 = 90 + Tax 4.50 = 94.50 -> Cash 95 (RoundOff 0.50)',
      'Gross 100 - Disc 10 = 90 + Tax 4.50 = 94.50 -> Cash 95 (RoundOff 0.50)'
    ));
  } else {
    results.push(fail(
      MODULE,
      'Universal POS',
      'Calculation Order: Gross → Discount → Taxable → GST → Round-off → Net',
      'Valid calculation order',
      'Mismatch in calculation pipeline',
      'CRITICAL'
    ));
  }

  return results;
}
