/**
 * Seed a complete hybrid Rental & Sales shop on the live server.
 * Enables both 'rental' and 'sale' commerce modes and seeds sample rental and retail items.
 *
 * Usage: node scripts/seed-live-rental-sales-shop.mjs
 */

const API = process.env.API_URL || 'http://13.126.105.138:3001/v1';

const SUFFIX = Date.now().toString(36).toUpperCase().slice(-4);
const SLUG = `rental-sales-hub`;
const EMAIL = `owner@rentalsales.live`;
const PASSWORD = 'RentalSales@2026!';
const SHOP = 'Universal Rental & Sales Hub';

async function req(path, { method = 'GET', token, body } = {}) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = `${method} ${path} → ${res.status}: ${JSON.stringify(json)}`;
    const err = new Error(msg);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return json.data ?? json;
}

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.organizations)) return payload.organizations;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function enterShop(authData) {
  if (authData?.accessToken) {
    return authData.accessToken;
  }
  const identityToken = authData?.identityToken;
  if (!identityToken) return null;

  const listed = await req('/auth/organizations', { token: identityToken });
  const orgs = asList(listed?.organizations ?? listed);
  const match =
    orgs.find((o) => String(o.slug || o.tenantSlug || '') === SLUG) ||
    orgs.find((o) => /rental/i.test(String(o.name || o.organizationName || ''))) ||
    orgs[0];

  if (match?.tenantId || match?.id) {
    const selected = await req('/auth/select-organization', {
      method: 'POST',
      token: identityToken,
      body: { tenantId: match.tenantId || match.id },
    });
    if (selected?.accessToken) {
      return selected.accessToken;
    }
  }

  const created = await req('/auth/organizations', {
    method: 'POST',
    token: identityToken,
    body: {
      organizationName: SHOP,
      businessType: 'rental',
      businessLabel: 'Equipment rental & retail store',
      addressLine1: '100 Commercial Boulevard',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
      countryCode: 'US',
      currencyCode: 'USD',
      locale: 'en-US',
      phone: '+18005550199',
      storeName: 'Main Store',
    },
  });
  return created?.accessToken ?? null;
}

const RENTAL_CATALOG = [
  {
    category: 'Cameras & Video Gear',
    products: [
      {
        title: 'Canon EOS R5 C Cinema Camera',
        sku: `RNT-CAM-R5C-${SUFFIX}`, // 16 chars
        rentalPrice: 150,
        deposit: 500,
        units: [
          { barcode: `CAM-R5C-01-${SUFFIX}`, variant: 'Body Rig A' },
          { barcode: `CAM-R5C-02-${SUFFIX}`, variant: 'Body Rig B' },
        ],
      },
      {
        title: 'Sony FX3 Cinema Kit',
        sku: `RNT-CAM-FX3-${SUFFIX}`, // 16 chars
        rentalPrice: 180,
        deposit: 600,
        units: [
          { barcode: `CAM-FX3-01-${SUFFIX}`, variant: 'Cage + Handle A' },
          { barcode: `CAM-FX3-02-${SUFFIX}`, variant: 'Cage + Handle B' },
        ],
      },
      {
        title: 'DJI RS 3 Pro Gimbal Stabilizer',
        sku: `RNT-GIM-RS3-${SUFFIX}`, // 16 chars
        rentalPrice: 45,
        deposit: 150,
        units: [
          { barcode: `GIM-RS3P-01-${SUFFIX}`, variant: 'Combo Kit 1' },
          { barcode: `GIM-RS3P-02-${SUFFIX}`, variant: 'Combo Kit 2' },
        ],
      },
    ],
  },
  {
    category: 'Event & Audio Equipment',
    products: [
      {
        title: 'JBL PartyBox 710 High-Power Sound System',
        sku: `RNT-AUD-PB7-${SUFFIX}`, // 16 chars
        rentalPrice: 85,
        deposit: 200,
        units: [
          { barcode: `AUD-PB710-01-${SUFFIX}`, variant: 'Speaker Unit 1' },
          { barcode: `AUD-PB710-02-${SUFFIX}`, variant: 'Speaker Unit 2' },
        ],
      },
      {
        title: 'Shure BLX Dual Wireless Microphone System',
        sku: `RNT-AUD-SHR-${SUFFIX}`, // 16 chars
        rentalPrice: 35,
        deposit: 100,
        units: [
          { barcode: `AUD-SHR-01-${SUFFIX}`, variant: 'Dual Handheld' },
        ],
      },
      {
        title: '1500W High-Output Fog & Smoke Machine',
        sku: `RNT-EVT-FOG-${SUFFIX}`, // 16 chars
        rentalPrice: 40,
        deposit: 100,
        units: [
          { barcode: `EVT-FOG-01-${SUFFIX}`, variant: 'Machine + Remote' },
        ],
      },
    ],
  },
  {
    category: 'Power Tools & Machinery',
    products: [
      {
        title: 'DeWalt 60V Max Cordless Breaker Hammer',
        sku: `RNT-TOL-DWB-${SUFFIX}`, // 16 chars
        rentalPrice: 65,
        deposit: 200,
        units: [
          { barcode: `TOOL-DW-01-${SUFFIX}`, variant: 'Heavy Unit A' },
          { barcode: `TOOL-DW-02-${SUFFIX}`, variant: 'Heavy Unit B' },
        ],
      },
      {
        title: 'Commercial 3500 PSI Pressure Washer',
        sku: `RNT-TOL-PW3-${SUFFIX}`, // 16 chars
        rentalPrice: 75,
        deposit: 250,
        units: [
          { barcode: `TOOL-PW-01-${SUFFIX}`, variant: 'Gas 3500PSI #1' },
        ],
      },
      {
        title: 'Stihl 20" Commercial Chainsaw',
        sku: `RNT-TOL-STI-${SUFFIX}`, // 16 chars
        rentalPrice: 55,
        deposit: 180,
        units: [
          { barcode: `TOOL-ST-01-${SUFFIX}`, variant: 'Pro Saw #1' },
        ],
      },
    ],
  },
];

const SALE_CATALOG = [
  {
    category: 'Camera Accessories & Media',
    products: [
      {
        title: 'SanDisk Extreme Pro 128GB SDXC V90',
        sku: `SD-128-V90-${SUFFIX}`,
        price: 38.99,
        costPrice: 22.0,
        qty: 50,
      },
      {
        title: 'Canon LP-E6NH High-Capacity Battery Pack',
        sku: `BAT-LPE6NH-${SUFFIX}`,
        price: 79.0,
        costPrice: 48.0,
        qty: 30,
      },
      {
        title: 'Professional Lens & Sensor Cleaning Kit',
        sku: `ACC-CLN-KIT-${SUFFIX}`,
        price: 19.99,
        costPrice: 8.5,
        qty: 60,
      },
    ],
  },
  {
    category: 'Event Consumables & Supplies',
    products: [
      {
        title: 'High-Density Fog Machine Fluid (1 Gallon)',
        sku: `FLUID-FOG-${SUFFIX}`,
        price: 24.99,
        costPrice: 11.0,
        qty: 40,
      },
      {
        title: 'Pro Grade Gaffer Tape 2" x 50yd (Black)',
        sku: `TAPE-GAFF-${SUFFIX}`,
        price: 18.5,
        costPrice: 9.0,
        qty: 80,
      },
      {
        title: 'Heavy Duty 50ft Outdoor Extension Cord',
        sku: `CORD-EXT50-${SUFFIX}`,
        price: 39.99,
        costPrice: 20.0,
        qty: 25,
      },
      {
        title: 'Pro AA Rechargeable Batteries (8-Pack)',
        sku: `BAT-AA-8PK-${SUFFIX}`,
        price: 22.0,
        costPrice: 11.5,
        qty: 45,
      },
    ],
  },
  {
    category: 'Safety Gear & Consumables',
    products: [
      {
        title: 'ANSI Level 4 Heavy Duty Work Gloves (L)',
        sku: `PPE-GLV-L-${SUFFIX}`,
        price: 14.99,
        costPrice: 6.0,
        qty: 100,
      },
      {
        title: 'Anti-Fog Impact Resistant Safety Goggles',
        sku: `PPE-GGL-01-${SUFFIX}`,
        price: 9.99,
        costPrice: 3.8,
        qty: 90,
      },
      {
        title: '29-Piece Titanium Nitride Drill Bit Set',
        sku: `BIT-SET-29-${SUFFIX}`,
        price: 49.99,
        costPrice: 24.0,
        qty: 35,
      },
      {
        title: '2-Cycle Synthetic Engine Oil (6-Pack)',
        sku: `OIL-2CYC-6-${SUFFIX}`,
        price: 19.99,
        costPrice: 9.5,
        qty: 50,
      },
    ],
  },
];

const CUSTOMERS = [
  {
    fullName: 'John Doe',
    email: 'john.doe@example.com',
    phone: '+919876543210',
    notes: 'Preferred VIP customer for camera rentals',
    returnExisting: true,
  },
  {
    fullName: 'Apex Media Productions',
    email: 'contact@apexmedia.test',
    phone: '+919876543211',
    notes: 'Corporate client - Net 30 terms',
    returnExisting: true,
  },
  {
    fullName: 'Sarah Jenkins',
    email: 'sarah.j@example.com',
    phone: '+919876543212',
    notes: 'Event organizer & equipment renter',
    returnExisting: true,
  },
];

async function main() {
  console.log(`Connecting to: ${API}`);
  console.log(`Setting up shop: ${SHOP}`);
  console.log(`Owner login: ${EMAIL} / ${PASSWORD}\n`);

  let token = null;

  // 1. Try to login
  try {
    const loginRes = await req('/auth/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
    token = await enterShop(loginRes);
    if (token) console.log('✓ Logged in & selected organization');
  } catch (err) {
    console.log('Login attempt:', err.message?.slice(0, 80));
  }

  // 2. Register tenant if still no token
  if (!token) {
    try {
      const regRes = await req('/auth/register-tenant', {
        method: 'POST',
        body: {
          tenantName: SHOP,
          tenantSlug: `${SLUG}-${SUFFIX.toLowerCase()}`,
          storeName: 'Main Store',
          adminFullName: 'Rental & Sales Admin',
          adminEmail: EMAIL,
          adminPassword: PASSWORD,
          adminPhone: '+919876500001',
        },
      });
      token = await enterShop(regRes);
      console.log('✓ Registered new tenant & selected organization');
    } catch (regErr) {
      console.log('Registration attempt:', regErr.message?.slice(0, 80));
    }
  }

  if (!token) {
    throw new Error('Could not authenticate or register tenant.');
  }

  // 3. Set Commerce Modes to BOTH 'rental' and 'sale'
  console.log('\nConfiguring hybrid commerce modes [rental, sale]...');
  await req('/tenants/me/commerce-modes', {
    method: 'POST',
    token,
    body: {
      modes: ['rental', 'sale'],
      shopTitle: SHOP,
      tagline: 'Equipment Rentals & Retail Store',
    },
  });
  console.log('✓ Enabled Commerce Modes: [rental, sale]');

  // 4. Update Business Config
  try {
    await req('/tenants/me/business-config', {
      method: 'POST',
      token,
      body: {
        businessType: 'rental',
        applyDefaultModes: false,
      },
    });
    console.log('✓ Configured business config');
  } catch (err) {
    console.log('  (business-config note:', err.message?.slice(0, 80), ')');
  }

  // 5. Get primary Location / Store
  const locsRaw = await req('/locations', { token });
  const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
  const loc = locs[0];
  if (!loc?.id) {
    throw new Error('No default location found for tenant');
  }
  console.log(`✓ Store Location: "${loc.name}" (${loc.id})`);

  // 6. Seed Rental Categories & Products
  console.log('\n--- Seeding Rental Inventory ---');
  let rentalProdCount = 0;
  let rentalUnitCount = 0;

  for (const block of RENTAL_CATALOG) {
    let cat;
    try {
      cat = await req('/pos/rental/categories', {
        method: 'POST',
        token,
        body: { name: block.category },
      });
      console.log(`  ✓ Rental Category: ${cat.name}`);
    } catch {
      // Category may already exist
      const existing = await req('/pos/rental/categories', { token }).catch(() => []);
      cat = (Array.isArray(existing) ? existing : existing.items ?? []).find(
        (c) => c.name === block.category,
      ) || { id: null, name: block.category };
    }

    for (const p of block.products) {
      try {
        await req('/pos/rental/products', {
          method: 'POST',
          token,
          body: {
            categoryId: cat.id || undefined,
            title: p.title,
            description: `${p.title} - Commercial grade rental unit.`,
            sku: p.sku,
            rentalPrice: p.rentalPrice,
            deposit: p.deposit,
            barcode: p.units[0].barcode,
            variant: p.units[0].variant,
            locationId: loc.id,
          },
        });
        rentalProdCount++;
        rentalUnitCount += p.units.length;
        console.log(`    + [RENTAL] ${p.title} ($${p.rentalPrice}/day, $${p.deposit} deposit)`);
      } catch (err) {
        console.log(`    ! Error creating rental ${p.title}: ${err.message?.slice(0, 100)}`);
      }
    }
  }

  // 7. Seed Sale / Retail Categories & Products
  console.log('\n--- Seeding Sale / Retail Inventory ---');
  let saleProdCount = 0;

  for (const block of SALE_CATALOG) {
    let cat;
    try {
      cat = await req('/pos/sale/categories', {
        method: 'POST',
        token,
        body: { name: block.category },
      });
      console.log(`  ✓ Retail Category: ${cat.name}`);
    } catch {
      const existing = await req('/pos/sale/categories', { token }).catch(() => []);
      cat = (Array.isArray(existing) ? existing : existing.items ?? []).find(
        (c) => c.name === block.category,
      ) || { id: null, name: block.category };
    }

    for (const p of block.products) {
      try {
        await req('/pos/sale/products', {
          method: 'POST',
          token,
          body: {
            title: p.title,
            description: `${p.title} for direct retail sale.`,
            categoryId: cat.id || undefined,
            sku: p.sku,
            price: p.price,
            costPrice: p.costPrice,
            qty: p.qty,
            locationId: loc.id,
          },
        });
        saleProdCount++;
        console.log(`    + [SALE] ${p.title} ($${p.price} retail, stock: ${p.qty})`);
      } catch (err) {
        console.log(`    ! Error creating sale item ${p.title}: ${err.message?.slice(0, 100)}`);
      }
    }
  }

  // 8. Seed Demo Customers
  console.log('\n--- Seeding Demo Customers ---');
  for (const c of CUSTOMERS) {
    try {
      await req('/customers', {
        method: 'POST',
        token,
        body: c,
      });
      console.log(`  ✓ Customer: ${c.fullName} (${c.phone})`);
    } catch (err) {
      console.log(`  ! Customer note: ${err.message?.slice(0, 80)}`);
    }
  }

  console.log('\n========================================================');
  console.log('🎉 SUCCESS: Hybrid Rental & Sales Shop created on LIVE!');
  console.log('========================================================');
  console.log(`Shop Name:     ${SHOP}`);
  console.log(`Server:        ${API}`);
  console.log(`Email:         ${EMAIL}`);
  console.log(`Password:      ${PASSWORD}`);
  console.log(`Modes:         [rental, sale] (Full Rent + Sell support)`);
  console.log(`Rental Items:  ${rentalProdCount} products (${rentalUnitCount} serial units)`);
  console.log(`Retail Items:  ${saleProdCount} retail products`);
  console.log('========================================================\n');
}

main().catch((err) => {
  console.error('\n❌ Fatal error seeding shop:', err);
  process.exit(1);
});
