/**
 * Apply real food photos (local JPEG) to restaurant menu items.
 *
 *   node scripts/apply-menu-photos.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://127.0.0.1:3001/v1';
const __dir = dirname(fileURLToPath(import.meta.url));

const FILE_BY_NAME = {
  'Gulab Jamun': 'food-gulab-jamun.jpg',
  'Paneer Tikka': 'food-paneer-tikka.jpg',
  'Butter Chicken': 'food-butter-chicken.jpg',
  'Dal Makhani': 'food-dal-makhani.jpg',
  'Jeera Rice': 'food-jeera-rice.jpg',
  'Masala Chai': 'food-masala-chai.jpg',
  'Mango Lassi': 'food-mango-lassi.jpg',
  'Veg Spring Roll': 'food-veg-spring-roll.jpg',
  'Paneer Butter Masala': 'food-paneer-tikka.jpg',
};

const PHOTO_DIRS = [
  join(__dir, 'menu-photos'),
  join(
    process.env.USERPROFILE || '',
    '.cursor',
    'projects',
    'd-UNIVERSAl-POS',
    'assets',
  ),
];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: res.ok && json?.success !== false,
    status: res.status,
    data: json?.data ?? json,
    text: text.slice(0, 400),
  };
}

function latestLogin() {
  if (process.env.EMAIL && process.env.PASSWORD) {
    return { email: process.env.EMAIL, password: process.env.PASSWORD };
  }
  const dir = join(__dir, 'qa-results');
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('restaurant-full-') && f.endsWith('.json'))
    .sort();
  const latest = files[files.length - 1];
  if (!latest) return null;
  const raw = JSON.parse(readFileSync(join(dir, latest), 'utf8'));
  return raw.login
    ? { email: raw.login.email, password: raw.login.password }
    : null;
}

function findPhoto(fileName) {
  for (const dir of PHOTO_DIRS) {
    const p = join(dir, fileName);
    if (existsSync(p)) return p;
  }
  return null;
}

function fileToDataUrl(path) {
  const buf = readFileSync(path);
  const lower = path.toLowerCase();
  const mime = lower.endsWith('.png')
    ? 'image/png'
    : lower.endsWith('.webp')
      ? 'image/webp'
      : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function main() {
  const creds = latestLogin();
  if (!creds) {
    console.error('No restaurant login found');
    process.exit(1);
  }
  console.log(`Login ${creds.email}`);
  const login = await api('POST', '/auth/login', {
    body: { email: creds.email, password: creds.password },
  });
  let token = login.data?.accessToken;
  if (!token && login.data?.identityToken) {
    const org = login.data.organizations?.[0]?.tenantId;
    const sel = await api('POST', '/auth/select-organization', {
      token: login.data.identityToken,
      body: { tenantId: org },
    });
    token = sel.data?.accessToken;
  }
  if (!token) {
    console.error('Could not enter shop', login.text);
    process.exit(1);
  }

  const locs = await api('GET', '/locations', { token });
  const locList = Array.isArray(locs.data)
    ? locs.data
    : locs.data?.items || locs.data?.data || [];
  const loc = locList[0];
  if (!loc?.id) {
    console.error('No location');
    process.exit(1);
  }
  const catalog = await api(
    'GET',
    `/pos/sale/catalog?locationId=${loc.id}&limit=50`,
    { token },
  );
  const items = catalog.data?.items || catalog.data || [];
  console.log(`Catalog items: ${items.length}`);

  let ok = 0;
  for (const row of items) {
    const name = row.title || row.name;
    const fileName = FILE_BY_NAME[name];
    if (!fileName) {
      console.log(`SKIP  ${name}`);
      continue;
    }
    const path = findPhoto(fileName);
    if (!path) {
      console.log(`MISS  ${name} — file ${fileName} not found`);
      continue;
    }
    const stockId = row.id;
    const dataUrl = fileToDataUrl(path);

    const old = [...(row.images || []), row.photoUrl, row.image].filter(Boolean);
    for (const imageUrl of [...new Set(old)]) {
      await api('POST', `/pos/sale/products/${stockId}/image/remove`, {
        token,
        body: { imageUrl },
      });
    }
    const up = await api('POST', `/pos/sale/products/${stockId}/image`, {
      token,
      body: { imageBase64: dataUrl },
    });
    if (up.ok) {
      ok += 1;
      console.log(`OK    ${name} ← ${fileName}`);
    } else {
      console.log(`FAIL  ${name} — ${up.status} ${up.text.slice(0, 120)}`);
    }
  }
  console.log(`\nDone: ${ok}/${items.length} real photos applied`);
  console.log('Refresh Items / Counter (Ctrl+Shift+R) to see them.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
