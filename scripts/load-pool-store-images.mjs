/**
 * Attach generated item photos to The Pool Store on a live API.
 *
 *   API_URL=http://13.126.105.138:3001/v1 node scripts/load-pool-store-images.mjs
 */
import { deflateSync } from 'node:zlib';

const API = process.env.API_URL ?? 'http://13.126.105.138:3001/v1';
const EMAIL = process.env.POOL_EMAIL ?? 'owner@pool.demo';
const PASSWORD = process.env.POOL_PASSWORD ?? 'WalitShop@2026';
const SLUG = process.env.POOL_SLUG ?? 'pool-store';
const FORCE = process.env.FORCE === '1';

const PALETTE = [
  [14, 116, 144],
  [37, 99, 235],
  [8, 145, 178],
  [79, 70, 229],
  [5, 150, 105],
  [217, 119, 6],
  [220, 38, 38],
  [124, 58, 237],
  [234, 88, 12],
  [13, 148, 136],
  [2, 132, 199],
  [101, 163, 13],
];

async function api(method, path, { token, body } = {}) {
  let res;
  let text = '';
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, status: 0, data: null, text: String(e.message || e) };
  }
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

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.organizations)) return payload.organizations;
  return [];
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function rgbPng(w, h, paint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y, w, h);
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

function hashHue(s) {
  let n = 0;
  for (const ch of String(s)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length];
}

function clamp(n) {
  return Math.max(0, Math.min(255, n | 0));
}

function itemPng(title, category) {
  const [cr, cg, cb] = hashHue(category || title);
  const w = 360;
  const h = 360;
  return rgbPng(w, h, (x, y) => {
    const nx = x / w;
    const ny = y / h;
    const dx = nx - 0.5;
    const dy = ny - 0.42;
    const d = Math.sqrt(dx * dx + dy * dy);
    const wave = 0.5 + 0.5 * Math.sin(nx * 8 + ny * 3);
    let r = clamp(cr * 0.35 + 210 * ny);
    let g = clamp(cg * 0.35 + 226 * (1 - ny));
    let b = clamp(cb * 0.45 + 240 * wave * 0.25);
    if (ny > 0.72) {
      r = clamp(cr + 40);
      g = clamp(cg + 30);
      b = clamp(cb + 20);
    }
    if (d < 0.28) {
      r = clamp(cr + 30);
      g = clamp(cg + 20);
      b = clamp(cb + 10);
    } else if (d < 0.34) {
      r = 255;
      g = 255;
      b = 255;
    }
    return [r, g, b];
  });
}

async function token() {
  const login = await api('POST', '/auth/login', {
    body: { email: EMAIL, password: PASSWORD, tenantSlug: SLUG },
  });
  if (login.data?.accessToken) return login.data.accessToken;
  const idt = login.data?.identityToken;
  if (!idt) {
    const plain = await api('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
    });
    if (plain.data?.accessToken) return plain.data.accessToken;
    const id2 = plain.data?.identityToken;
    if (!id2) return null;
    const listed = await api('GET', '/auth/organizations', { token: id2 });
    const org = asList(listed.data?.organizations ?? listed.data)[0];
    const sel = await api('POST', '/auth/select-organization', {
      token: id2,
      body: { tenantId: org?.tenantId },
    });
    return sel.data?.accessToken || null;
  }
  const listed = await api('GET', '/auth/organizations', { token: idt });
  const orgs = asList(listed.data?.organizations ?? listed.data);
  const org =
    orgs.find((o) => String(o.slug || o.tenantSlug || '') === SLUG) || orgs[0];
  const sel = await api('POST', '/auth/select-organization', {
    token: idt,
    body: { tenantId: org?.tenantId },
  });
  return sel.data?.accessToken || null;
}

async function main() {
  console.log(`Pool Store images → ${API}`);
  const tok = await token();
  if (!tok) {
    console.error('login failed');
    process.exit(1);
  }
  const locs = await api('GET', '/locations', { token: tok });
  const loc = asList(locs.data)[0];
  const listed = await api('GET', `/pos/sale/products?locationId=${loc.id}`, {
    token: tok,
  });
  const items = asList(listed.data);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of items) {
    const has = Boolean(item.photoUrl || item.image || item.images?.[0]);
    if (has && !FORCE) {
      skipped += 1;
      continue;
    }
    const cat = item.category?.name || item.categoryName || 'Item';
    const imageBase64 = itemPng(item.title || item.name, cat);
    const res = await api('POST', `/pos/sale/products/${item.id}/image`, {
      token: tok,
      body: { imageBase64 },
    });
    if (res.ok && (res.data?.photoUrl || res.data?.image)) {
      uploaded += 1;
      console.log(`PASS  ${item.sku || item.title}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${item.sku || item.title}  ${res.status} ${res.text}`);
    }
  }
  console.log(
    `\nuploaded=${uploaded} skipped=${skipped} failed=${failed} total=${items.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
