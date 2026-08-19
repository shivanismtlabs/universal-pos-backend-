/**
 * Provision 5 distinct Universal POS businesses with catalog + customers + a sale.
 * Usage: node scripts/seed-five-businesses.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const PASSWORD = 'DemoShop@2026';
const STAMP = Date.now().toString(36).slice(-5).toUpperCase();

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  const data = json?.data ?? json;
  if (!res.ok) {
    const msg =
      json?.message ||
      (Array.isArray(json?.message) ? json.message.join(', ') : null) ||
      text.slice(0, 240);
    throw new Error(`${method} ${path} → ${res.status} ${msg}`);
  }
  return data;
}

function sku(prefix, n) {
  return `${prefix}${STAMP}${n}`.replace(/[^A-Z0-9-]/g, '').slice(0, 18);
}

const SHOPS = [
  {
    key: 'retail',
    email: `aisha.retail.${STAMP.toLowerCase()}@upos.demo`,
    fullName: 'Aisha Khan',
    org: 'Urban Thread',
    store: 'Bandra Boutique',
    businessType: 'retail',
    sells: ['products'],
    phone: '+919800100001',
    customers: [
      { fullName: 'Priya Mehta', phone: '+919811100001', email: 'priya.mehta@example.com' },
      { fullName: 'Rohan Shah', phone: '+919811100002', email: 'rohan.shah@example.com' },
      { fullName: 'Neha Kapoor', phone: '+919811100003' },
    ],
    catalog: [
      {
        category: 'Apparel',
        items: [
          { title: 'Blue Cotton T-shirt', price: 599, qty: 40, brand: 'UrbanWear' },
          { title: 'Slim Fit Jeans', price: 1499, qty: 25, brand: 'UrbanWear' },
          { title: 'Linen Shirt White', price: 1299, qty: 18, brand: 'UrbanWear' },
        ],
      },
      {
        category: 'Accessories',
        items: [
          { title: 'Canvas Tote', price: 449, qty: 30, brand: 'UrbanWear' },
          { title: 'Cap Classic', price: 299, qty: 22, brand: 'UrbanWear' },
        ],
      },
    ],
  },
  {
    key: 'grocery',
    email: `ravi.grocery.${STAMP.toLowerCase()}@upos.demo`,
    fullName: 'Ravi Patel',
    org: 'FreshMart Grocery',
    store: 'Andheri Store',
    businessType: 'grocery',
    sells: ['products'],
    phone: '+919800100002',
    customers: [
      { fullName: 'Sanjay Iyer', phone: '+919811200001' },
      { fullName: 'Anita Desai', phone: '+919811200002' },
      { fullName: 'Kiran Joshi', phone: '+919811200003' },
    ],
    catalog: [
      {
        category: 'Dairy',
        items: [
          { title: 'Full Cream Milk 1L', price: 62, qty: 80, unit: 'pcs' },
          { title: 'Curd 400g', price: 45, qty: 50, unit: 'pcs' },
        ],
      },
      {
        category: 'Staples',
        items: [
          { title: 'Basmati Rice 1kg', price: 145, qty: 60, unit: 'kg' },
          { title: 'Sunflower Oil 1L', price: 168, qty: 40, unit: 'L' },
          { title: 'Toor Dal 1kg', price: 132, qty: 35, unit: 'kg' },
        ],
      },
    ],
  },
  {
    key: 'restaurant',
    email: `meera.cafe.${STAMP.toLowerCase()}@upos.demo`,
    fullName: 'Meera Nair',
    org: 'Spice Garden Café',
    store: 'Bandra Outlet',
    businessType: 'restaurant',
    sells: ['products'],
    phone: '+919800100003',
    customers: [
      { fullName: 'Walk-in Regular', phone: '+919811300001' },
      { fullName: 'Amit Kulkarni', phone: '+919811300002' },
      { fullName: 'Sara Ali', phone: '+919811300003' },
    ],
    catalog: [
      {
        category: 'Mains',
        items: [
          { title: 'Paneer Butter Masala', price: 280, qty: 99, track: false },
          { title: 'Veg Biryani', price: 220, qty: 99, track: false },
          { title: 'Butter Naan', price: 45, qty: 99, track: false },
        ],
      },
      {
        category: 'Beverages',
        items: [
          { title: 'Masala Chai', price: 40, qty: 99, track: false },
          { title: 'Fresh Lime Soda', price: 70, qty: 99, track: false },
        ],
      },
    ],
  },
  {
    key: 'salon',
    email: `nina.salon.${STAMP.toLowerCase()}@upos.demo`,
    fullName: 'Nina Fernandes',
    org: 'Luxe Cuts Salon',
    store: 'Linking Road',
    businessType: 'salon',
    sells: ['services', 'products'],
    phone: '+919800100004',
    customers: [
      { fullName: 'Riya Sharma', phone: '+919811400001' },
      { fullName: 'Aditi Rao', phone: '+919811400002' },
      { fullName: 'Vikram Singh', phone: '+919811400003' },
    ],
    catalog: [
      {
        category: 'Hair',
        items: [
          {
            title: 'Haircut – Women',
            price: 650,
            qty: 0,
            service: true,
          },
          {
            title: 'Haircut – Men',
            price: 350,
            qty: 0,
            service: true,
          },
          {
            title: 'Keratin Treatment',
            price: 4500,
            qty: 0,
            service: true,
          },
        ],
      },
      {
        category: 'Retail',
        items: [
          { title: 'Argan Hair Serum', price: 890, qty: 12 },
          { title: 'Salon Shampoo 250ml', price: 420, qty: 18 },
        ],
      },
    ],
  },
  {
    key: 'pharmacy',
    email: `arjun.pharma.${STAMP.toLowerCase()}@upos.demo`,
    fullName: 'Arjun Reddy',
    org: 'CarePlus Pharmacy',
    store: 'Powai Counter',
    businessType: 'pharmacy',
    sells: ['products'],
    phone: '+919800100005',
    customers: [
      { fullName: 'Lakshmi Pillai', phone: '+919811500001' },
      { fullName: 'Farhan Qureshi', phone: '+919811500002' },
      { fullName: 'Deepa Menon', phone: '+919811500003' },
    ],
    catalog: [
      {
        category: 'OTC',
        items: [
          { title: 'Paracetamol 500mg', price: 28, qty: 200 },
          { title: 'ORS Sachet', price: 18, qty: 150 },
          { title: 'Cough Syrup 100ml', price: 95, qty: 40 },
        ],
      },
      {
        category: 'Wellness',
        items: [
          { title: 'Vitamin C 60 tabs', price: 249, qty: 30 },
          { title: 'Digital Thermometer', price: 199, qty: 15 },
        ],
      },
    ],
  },
];

async function checkoutOne(token, locationId, item) {
  try {
    await api('POST', '/pos/sale/register/open', {
      token,
      body: { locationId, openingFloat: 1000 },
    });
  } catch {
    /* already open */
  }

  const body = {
    locationId,
    items: [
      {
        stockLevelId: item.stockLevelId,
        quantity: 1,
        unitPrice: item.price,
      },
    ],
    payments: [
      {
        method: 'cash',
        amount: item.price,
        idempotencyKey: `five-${STAMP}-${item.sku}`,
      },
    ],
    cashTendered: item.price + 50,
  };

  try {
    const sale = await api('POST', '/pos/sale/checkout', { token, body });
    return sale.order?.orderNumber || sale.orderNumber || 'ok';
  } catch (e) {
    const m = String(e.message).match(/(\d+(\.\d+)?)/);
    if (!m) throw e;
    const due = Number(m[1]);
    const sale = await api('POST', '/pos/sale/checkout', {
      token,
      body: {
        ...body,
        payments: [
          {
            method: 'cash',
            amount: due,
            idempotencyKey: `five-${STAMP}-${item.sku}-r`,
          },
        ],
        cashTendered: due + 20,
      },
    });
    return sale.order?.orderNumber || sale.orderNumber || 'ok';
  }
}

async function provisionShop(shop) {
  const signup = await api('POST', '/auth/signup', {
    body: {
      email: shop.email,
      password: PASSWORD,
      fullName: shop.fullName,
      phone: shop.phone,
    },
  });
  const identityToken = signup.identityToken;
  if (!identityToken) throw new Error(`No identityToken for ${shop.email}`);

  const created = await api('POST', '/auth/organizations', {
    token: identityToken,
    body: {
      organizationName: shop.org,
      businessType: shop.businessType,
      businessLabel: shop.org,
      sells: shop.sells,
      addressLine1: '12 Universal Road',
      city: 'Mumbai',
      state: 'Maharashtra',
      postalCode: '400001',
      currencyCode: 'INR',
      fiscalYearStart: 'April',
      inventoryStartDate: '2026-04-01',
      storeName: shop.store,
      phone: shop.phone,
    },
  });
  const token = created.accessToken;
  if (!token) throw new Error(`No accessToken for ${shop.org}`);

  const locsRaw = await api('GET', '/locations', { token });
  const locs = Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [];
  const loc = locs[0];
  if (!loc?.id) throw new Error(`No location for ${shop.org}`);

  const createdItems = [];
  let n = 1;
  for (const block of shop.catalog) {
    const cat = await api('POST', '/pos/sale/categories', {
      token,
      body: { name: block.category },
    });
    for (const p of block.items) {
      const isService = Boolean(p.service);
      const track = isService ? false : p.track !== false;
      const createdP = await api('POST', '/pos/sale/products', {
        token,
        body: {
          title: p.title,
          categoryId: cat.id,
          sku: sku(shop.key.slice(0, 2).toUpperCase(), n++),
          price: p.price,
          qty: track ? Math.max(1, p.qty ?? 10) : 0,
          locationId: loc.id,
          sellUnit: p.unit || 'pcs',
          manufacturer: p.brand,
          trackInventory: track,
          itemType: isService ? 'service' : 'goods',
        },
      });
      createdItems.push({
        title: p.title,
        sku: createdP.product?.sku || createdP.sku,
        price: p.price,
        stockLevelId:
          createdP.stockLevel?.id ||
          createdP.posItem?.id ||
          createdP.stockLevelId,
      });
    }
  }

  for (const c of shop.customers) {
    await api('POST', '/customers', {
      token,
      body: {
        fullName: c.fullName,
        phone: c.phone,
        email: c.email,
        marketingOptIn: true,
        notes: `${shop.org} sample customer`,
      },
    });
  }

  const saleSku = createdItems.find((i) => i.stockLevelId);
  let orderNo = null;
  if (saleSku) {
    orderNo = await checkoutOne(token, loc.id, saleSku);
  }

  return {
    business: shop.org,
    type: shop.businessType,
    store: shop.store,
    owner: shop.fullName,
    email: shop.email,
    password: PASSWORD,
    items: createdItems.length,
    customers: shop.customers.length,
    sampleSale: orderNo,
  };
}

async function main() {
  console.log(`\nSeeding 5 businesses against ${API}\n`);
  const rows = [];
  for (const shop of SHOPS) {
    process.stdout.write(`· ${shop.org} (${shop.businessType})… `);
    const row = await provisionShop(shop);
    rows.push(row);
    console.log(`ok (${row.items} items, sale ${row.sampleSale || '—'})`);
  }

  console.log('\n========== LOGIN ACCOUNTS ==========');
  console.log(`Password for all owners:  ${PASSWORD}\n`);
  for (const r of rows) {
    console.log(`${r.business.padEnd(22)}  ${r.type.padEnd(12)}  ${r.email}`);
    console.log(
      `  store: ${r.store}  ·  ${r.items} items  ·  ${r.customers} customers  ·  sale ${r.sampleSale || '—'}`,
    );
  }
  console.log('\nLogin at /login with the email + password above.\n');
}

main().catch((e) => {
  console.error('\nFAILED:', e.message || e);
  process.exit(1);
});
