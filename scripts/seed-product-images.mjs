/**
 * Attach soft product-style placeholder images to sale + rental demo products.
 *
 * Usage:
 *   node scripts/seed-product-images.mjs
 */
const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';

const SALE = {
  slug: process.env.SALE_SLUG ?? 'sale-demo-msda2hj1',
  email: process.env.SALE_EMAIL ?? 'owner@sale-demo-msda2hj1.test',
  password: process.env.SALE_PASSWORD ?? 'SaleDemo@2026!',
};
const RENT = {
  slug: process.env.RENT_SLUG ?? 'rent-demo-msd8kdp2',
  email: process.env.RENT_EMAIL ?? 'owner@rent-demo-msd8kdp2.test',
  password: process.env.RENT_PASSWORD ?? 'RentDemo@2026!',
};

/** Muted studio palettes — no neon solids */
const PALETTES = [
  { bg: '#e8f2ef', mid: '#c5ddd6', ink: '#0f3d36' },
  { bg: '#eef1f6', mid: '#cfd6e4', ink: '#1e293b' },
  { bg: '#f3efe8', mid: '#e0d4c4', ink: '#3f2f1e' },
  { bg: '#eceff3', mid: '#d0d7e0', ink: '#243447' },
  { bg: '#f0ebe7', mid: '#dccfc6', ink: '#4a3428' },
  { bg: '#e9f0f2', mid: '#c5d8de', ink: '#1a3a42' },
  { bg: '#f1eee9', mid: '#ddd4c5', ink: '#3a3328' },
  { bg: '#ebeaf1', mid: '#d0cee0', ink: '#2c2842' },
  { bg: '#eef2ea', mid: '#d2ddc8', ink: '#2f3d24' },
];

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initials(title) {
  const words = String(title || 'P')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'P';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function shortLabel(title) {
  const t = String(title || 'Product').trim();
  return t.length > 22 ? `${t.slice(0, 20)}…` : t;
}

/** Soft product card SVG — looks like a catalog photo, not a neon tile */
function productImageDataUrl(title, palette) {
  const { bg, mid, ink } = palette;
  const mono = initials(title);
  const label = escapeXml(shortLabel(title));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${mid}"/>
    </linearGradient>
    <radialGradient id="spot" cx="35%" cy="30%" r="55%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="640" height="640" fill="url(#g)"/>
  <rect width="640" height="640" fill="url(#spot)"/>
  <rect x="48" y="48" width="544" height="544" rx="28" fill="none" stroke="${ink}" stroke-opacity="0.08" stroke-width="2"/>
  <circle cx="320" cy="280" r="110" fill="${ink}" fill-opacity="0.06"/>
  <circle cx="320" cy="280" r="78" fill="#ffffff" fill-opacity="0.55"/>
  <text x="320" y="298" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="56" font-weight="600" fill="${ink}" fill-opacity="0.88">${escapeXml(mono)}</text>
  <text x="320" y="470" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="28" font-weight="500" fill="${ink}" fill-opacity="0.72">${label}</text>
  <text x="320" y="510" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="16" letter-spacing="3" fill="${ink}" fill-opacity="0.35">PRODUCT</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json.data ?? json;
}

async function login(shop) {
  const data = await req('/auth/login', {
    method: 'POST',
    body: {
      tenantSlug: shop.slug,
      email: shop.email,
      password: shop.password,
    },
  });
  return data.accessToken;
}

async function seedSale(token) {
  const products = await req('/pos/sale/products', { token });
  const items = Array.isArray(products) ? products : products.items ?? [];
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const id = p.id;
    if (!id) continue;
    const title = p.title ?? p.name ?? 'Product';
    const palette = PALETTES[i % PALETTES.length];
    await req(`/pos/sale/products/${id}/image`, {
      method: 'POST',
      token,
      body: { imageBase64: productImageDataUrl(title, palette) },
    });
    n += 1;
    console.log(`  sale · ${title}`);
  }
  return n;
}

async function seedRental(token) {
  const products = await req('/pos/rental/products', { token });
  const items = Array.isArray(products) ? products : products.items ?? [];
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const id = p.id;
    if (!id) continue;
    const title = p.title ?? p.name ?? 'Product';
    const palette = PALETTES[(i + 2) % PALETTES.length];
    await req(`/pos/rental/products/${id}/image`, {
      method: 'POST',
      token,
      body: { imageBase64: productImageDataUrl(title, palette) },
    });
    n += 1;
    console.log(`  rental · ${title}`);
  }
  return n;
}

async function main() {
  console.log('\n=== Seed product images (studio placeholders) ===\n');

  try {
    const saleToken = await login(SALE);
    console.log(`Sale shop ${SALE.slug}`);
    const sn = await seedSale(saleToken);
    console.log(`✓ ${sn} sale images\n`);
  } catch (e) {
    console.log(`Sale skip: ${e.message}\n`);
  }

  try {
    const rentToken = await login(RENT);
    console.log(`Rental shop ${RENT.slug}`);
    const rn = await seedRental(rentToken);
    console.log(`✓ ${rn} rental images\n`);
  } catch (e) {
    console.log(`Rental skip: ${e.message}\n`);
  }

  console.log('Done — hard-refresh POS / Catalog.\n');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
