/**
 * Add extra gallery photos to Northside Pool & Spa (live or local).
 *   node scripts/pool-store-add-gallery.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_URL ?? 'http://13.126.105.138:3001/v1';
const EMAIL = process.env.POOL_EMAIL ?? 'pool.demo.mswxr70n@upos.test';
const PASSWORD = process.env.POOL_PASSWORD ?? 'PoolStore@2026';
const IMG = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'pool-store');

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
    text: text.slice(0, 200),
  };
}

function dataUrl(name) {
  const p = join(IMG, name);
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return `data:image/png;base64,${readFileSync(p).toString('base64')}`;
}

function asList(p) {
  if (Array.isArray(p)) return p;
  if (Array.isArray(p?.items)) return p.items;
  return [];
}

async function main() {
  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
  });
  let token = login.data?.accessToken;
  if (!token && login.data?.identityToken) {
    const listed = await api('GET', '/auth/organizations', {
      token: login.data.identityToken,
    });
    const org = asList(listed.data?.organizations ?? listed.data)[0];
    const sel = await api('POST', '/auth/select-organization', {
      token: login.data.identityToken,
      body: { tenantId: org.tenantId },
    });
    token = sel.data?.accessToken;
  }
  if (!token) {
    console.error('login failed', login.text);
    process.exit(1);
  }
  const locs = await api('GET', '/locations', { token });
  const loc = asList(locs.data)[0];
  const cat = await api(
    'GET',
    `/pos/sale/products?locationId=${loc.id}&limit=50`,
    { token },
  );
  const items = asList(cat.data);
  const extras = [
    { match: /chlorine shock/i, file: 'pool-chlorine-shock-2.png' },
    { match: /patio grill/i, file: 'pool-patio-grill-2.png' },
  ];
  for (const ex of extras) {
    const row = items.find((i) => ex.match.test(i.title || i.name || ''));
    if (!row?.id) {
      console.log('SKIP', ex.match, 'not found');
      continue;
    }
    const before = Array.isArray(row.images) ? row.images.length : row.photoUrl ? 1 : 0;
    const up = await api('POST', `/pos/sale/products/${row.id}/image`, {
      token,
      body: { imageBase64: dataUrl(ex.file) },
    });
    const n = up.data?.images?.length ?? before;
    console.log(
      up.ok ? 'PASS' : 'FAIL',
      row.title,
      up.ok ? `photos ${before} → ${n}` : `${up.status} ${up.text}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
