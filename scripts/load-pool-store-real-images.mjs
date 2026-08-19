/**
 * Replace Pool Store placeholder thumbs with real stock photos
 * (Unsplash, not copied from thepoolstore.net).
 *
 *   API_URL=http://13.126.105.138:3001/v1 node scripts/load-pool-store-real-images.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.API_URL ?? "http://13.126.105.138:3001/v1";
const EMAIL = process.env.POOL_EMAIL ?? "owner@pool.demo";
const PASSWORD = process.env.POOL_PASSWORD ?? "WalitShop@2026";
const SLUG = process.env.POOL_SLUG ?? "pool-store";
const DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "pool-real");
mkdirSync(DIR, { recursive: true });

/** Unsplash stills — generic pool / backyard, not merchant listings */
const FILES = {
  chemicals:
    "https://images.unsplash.com/photo-1584305574647-0cc949a2d7ea?auto=format&fit=crop&w=900&q=80",
  pool:
    "https://images.unsplash.com/photo-1576013551627-0cc20b96c2a7?auto=format&fit=crop&w=900&q=80",
  pump:
    "https://images.unsplash.com/photo-1581092160562-40aa08e78837?auto=format&fit=crop&w=900&q=80",
  cleaner:
    "https://images.unsplash.com/photo-1562778612-e1e0cda99116?auto=format&fit=crop&w=900&q=80",
  filter:
    "https://images.unsplash.com/photo-1581092918056-0c4c71372ebc?auto=format&fit=crop&w=900&q=80",
  heater:
    "https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=900&q=80",
  light:
    "https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=900&q=80",
  cover:
    "https://images.unsplash.com/photo-1571902943202-507ec2618e8f?auto=format&fit=crop&w=900&q=80",
  float:
    "https://images.unsplash.com/photo-1530541930197-ff16ac917b0e?auto=format&fit=crop&w=900&q=80",
  toys:
    "https://images.unsplash.com/photo-1530541930197-ff16ac917b0e?auto=format&fit=crop&w=900&q=80",
  grill:
    "https://images.unsplash.com/photo-1555939594-58d7cb561ad1?auto=format&fit=crop&w=900&q=80",
  fire:
    "https://images.unsplash.com/photo-1478131143081-80f7f84ca84d?auto=format&fit=crop&w=900&q=80",
  spa:
    "https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=900&q=80",
  furniture:
    "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb77e?auto=format&fit=crop&w=900&q=80",
  sauna:
    "https://images.unsplash.com/photo-1544161515-4ab6ce6db874?auto=format&fit=crop&w=900&q=80",
  service:
    "https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=900&q=80",
  parts:
    "https://images.unsplash.com/photo-1581094794329-c8112a89af12?auto=format&fit=crop&w=900&q=80",
  patio:
    "https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=900&q=80",
};

const CAT_FILE = {
  "Chlorine & Shock": "chemicals",
  Algaecides: "chemicals",
  "Stain Treatment": "chemicals",
  "Balance & Clarifiers": "chemicals",
  "Pool Maintenance Chemicals": "chemicals",
  "Spa Chemicals": "spa",
  "Spa Fragrances": "spa",
  "Automatic Pool Cleaners": "cleaner",
  "Pumps & Motors": "pump",
  "Pool & Spa Filters": "filter",
  Heaters: "heater",
  "Salt Systems": "filter",
  "Automation Control": "parts",
  "Filter Media & Grids": "filter",
  "Pool & Spa Lights": "light",
  "Replacement Parts": "parts",
  "Pool Maintenance": "cleaner",
  "Pool Decks": "patio",
  "Pool Covers": "cover",
  "Above Ground Pools": "pool",
  "Spas & Hot Tubs": "spa",
  Saunas: "sauna",
  Floats: "float",
  "Toys & Games": "toys",
  Grills: "grill",
  Firepits: "fire",
  "Grill Accessories": "grill",
  Furniture: "furniture",
  "Patio Accessories": "patio",
  Clearance: "pool",
  Service: "service",
};

async function api(method, path, { token, body } = {}) {
  let res;
  let text = "";
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
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

async function download(key, url) {
  const dest = join(DIR, `${key}.jpg`);
  if (existsSync(dest) && readFileSync(dest).length > 4000) return dest;
  const res = await fetch(url, {
    headers: { "User-Agent": "UniversalPOS/1.0 (catalog demo images)" },
  });
  if (!res.ok) throw new Error(`download ${key} ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

function dataUrl(file) {
  return `data:image/jpeg;base64,${readFileSync(file).toString("base64")}`;
}

async function token() {
  const login = await api("POST", "/auth/login", {
    body: { email: EMAIL, password: PASSWORD, tenantSlug: SLUG },
  });
  if (login.data?.accessToken) return login.data.accessToken;
  const idt = login.data?.identityToken;
  if (!idt) return null;
  const listed = await api("GET", "/auth/organizations", { token: idt });
  const orgs = asList(listed.data?.organizations ?? listed.data);
  const org =
    orgs.find((o) => String(o.slug || o.tenantSlug || "") === SLUG) || orgs[0];
  const sel = await api("POST", "/auth/select-organization", {
    token: idt,
    body: { tenantId: org?.tenantId },
  });
  return sel.data?.accessToken || null;
}

async function main() {
  console.log(`Real Pool Store photos → ${API}`);
  const paths = {};
  for (const [key, url] of Object.entries(FILES)) {
    paths[key] = await download(key, url);
    console.log(`file  ${key}`);
  }

  const tok = await token();
  if (!tok) {
    console.error("login failed");
    process.exit(1);
  }
  const locs = await api("GET", "/locations", { token: tok });
  const loc = asList(locs.data)[0];
  const listed = await api("GET", `/pos/sale/products?locationId=${loc.id}`, {
    token: tok,
  });
  const items = asList(listed.data);
  let ok = 0;
  let fail = 0;
  for (const item of items) {
    const cat = item.category?.name || item.categoryName || "";
    const key = CAT_FILE[cat] || "pool";
    const file = paths[key];
    const gallery = [
      ...(Array.isArray(item.images) ? item.images : []),
      item.photoUrl,
      item.image,
    ].filter(Boolean);
    for (const imageUrl of [...new Set(gallery)]) {
      await api("POST", `/pos/sale/products/${item.id}/image/remove`, {
        token: tok,
        body: { imageUrl },
      });
    }
    const res = await api("POST", `/pos/sale/products/${item.id}/image`, {
      token: tok,
      body: { imageBase64: dataUrl(file) },
    });
    if (res.ok) {
      ok += 1;
      console.log(`PASS  ${item.sku}  ${key}`);
    } else {
      fail += 1;
      console.log(`FAIL  ${item.sku}  ${res.status} ${res.text}`);
    }
  }
  console.log(`\nuploaded=${ok} failed=${fail} total=${items.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
