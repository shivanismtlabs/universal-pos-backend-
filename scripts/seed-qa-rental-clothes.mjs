/**
 * Create rental-clothes shop only (fix for QA four shops).
 *   API_URL=http://13.126.105.138:3001/v1 node scripts/seed-qa-rental-clothes.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://13.126.105.138:3001/v1';
const FE = 'http://13.126.105.138:3000/login';
const PASSWORD = process.env.QA_PASSWORD ?? 'DemoShop@2026';
const STAMP = Date.now().toString(36).slice(-6).toUpperCase();
const EMAIL = `rent.owner.${STAMP.toLowerCase()}@upos.demo`;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'qa-results');
mkdirSync(OUT_DIR, { recursive: true });

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
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json).slice(0, 320)}`,
    );
  }
  return data;
}

function sku(prefix, n) {
  return `${prefix}${STAMP}${n}`
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 18)
    .padEnd(15, '0');
}

const IMG = {
  tuxedo:
    'https://images.unsplash.com/photo-1594938298603-c8148c4dae35?w=400&h=400&fit=crop',
  gown: 'https://images.unsplash.com/photo-1594552072238-b8a33785b261?w=400&h=400&fit=crop',
  jacket:
    'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=400&h=400&fit=crop',
  saree:
    'https://images.unsplash.com/photo-1610030469983-98e550d6193c?w=400&h=400&fit=crop',
};

const products = [
  {
    title: 'Midnight Tuxedo',
    price: 1500,
    dep: 2000,
    image: IMG.tuxedo,
    vars: ['40R', '42R'],
  },
  {
    title: 'Ivory Wedding Gown',
    price: 3500,
    dep: 5000,
    image: IMG.gown,
    vars: ['S', 'M'],
  },
  {
    title: 'Navy Dinner Jacket',
    price: 999,
    dep: 1500,
    image: IMG.jacket,
    vars: ['40R', '42R'],
  },
  {
    title: 'Banarasi Saree set',
    price: 2200,
    dep: 3000,
    image: IMG.saree,
    vars: ['ONESIZE'],
  },
];

const signup = await api('POST', '/auth/signup', {
  body: {
    email: EMAIL,
    password: PASSWORD,
    fullName: 'Kabir Rent Owner',
    phone: '9800100099',
  },
});
const created = await api('POST', '/auth/organizations', {
  token: signup.identityToken,
  body: {
    organizationName: `Velvet Rental Closet ${STAMP}`,
    businessType: 'rental',
    businessLabel: 'Clothes rental',
    sells: ['products'],
    commerceModes: ['rental'],
    addressLine1: '8 Fashion Lane',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400050',
    currencyCode: 'INR',
    fiscalYearStart: 'April',
    inventoryStartDate: '2026-04-01',
    storeName: 'Bandra Studio',
    phone: '9800100099',
  },
});
const token = created.accessToken;
const locsRaw = await api('GET', '/locations', { token });
const loc = (Array.isArray(locsRaw) ? locsRaw : locsRaw.items ?? [])[0];
const cat = await api('POST', '/pos/rental/categories', {
  token,
  body: { name: 'Formal wear' },
});

let n = 1;
let units = 0;
let images = 0;
for (const p of products) {
  const code = sku('REN', n++);
  const bar = sku('BAR', n);
  const createdP = await api('POST', '/pos/rental/products', {
    token,
    body: {
      categoryId: cat.id,
      title: p.title,
      description: `${p.title} rental`,
      sku: code,
      rentalPrice: p.price,
      deposit: p.dep,
      barcode: bar,
      variant: p.vars[0],
      locationId: loc.id,
    },
  });
  const pid = createdP.product?.id;
  if (pid && p.image) {
    try {
      await api('PATCH', `/catalog/products/${pid}`, {
        token,
        body: { photoUrl: p.image, images: [p.image] },
      });
      images += 1;
    } catch {
      /* image optional */
    }
  }
  units += 1;
  for (let i = 1; i < p.vars.length; i++) {
    await api('POST', '/pos/rental/units', {
      token,
      body: {
        productId: pid,
        barcode: sku('U', n * 10 + i),
        variant: p.vars[i],
        locationId: loc.id,
      },
    });
    units += 1;
  }
  console.log(`+ ${p.title}`);
}

await api('POST', '/customers', {
  token,
  body: { fullName: 'Wedding Guest', phone: '9811200091', marketingOptIn: true },
});
await api('POST', '/customers', {
  token,
  body: { fullName: 'Party Host', phone: '9811200092', marketingOptIn: true },
});

const row = {
  business: `Velvet Rental Closet ${STAMP}`,
  type: 'Clothes rental',
  store: 'Bandra Studio',
  email: EMAIL,
  password: PASSWORD,
  units,
  images,
  login: FE,
};
writeFileSync(
  join(OUT_DIR, `qa-rental-${STAMP}.json`),
  JSON.stringify(row, null, 2),
);
console.log('\n========== RENTAL LOGIN ==========');
console.log(JSON.stringify(row, null, 2));
