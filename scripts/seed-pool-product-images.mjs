/**
 * Re-attach pool product thumbs as base64 SVG (more reliable in <img>).
 * Updates ALL products for tenant slug `pool-store` (SKU list is optional fallback).
 *
 * Usage (local or production DB):
 *   node scripts/seed-pool-product-images.mjs
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PALETTE = {
  'Chlorine & Shock': { bg: '#bfdbfe', fg: '#1e3a8a', accent: '#2563eb' },
  'Algaecides': { bg: '#a5f3fc', fg: '#155e75', accent: '#0891b2' },
  'Algaecides & Stain': { bg: '#a5f3fc', fg: '#155e75', accent: '#0891b2' },
  'Balance & Clarifiers': { bg: '#c7d2fe', fg: '#312e81', accent: '#4f46e5' },
  'Spa Chemicals': { bg: '#e9d5ff', fg: '#581c87', accent: '#7c3aed' },
  'Cleaners & Brushes': { bg: '#a7f3d0', fg: '#065f46', accent: '#059669' },
  'Filters & Pumps': { bg: '#bae6fd', fg: '#0c4a6e', accent: '#0284c7' },
  'Filter Media & Gric': { bg: '#bae6fd', fg: '#0c4a6e', accent: '#0284c7' },
  'Heaters & Salt': { bg: '#fecaca', fg: '#991b1b', accent: '#dc2626' },
  'Lights & Parts': { bg: '#fde68a', fg: '#92400e', accent: '#d97706' },
  'Covers & Decks': { bg: '#d1fae5', fg: '#065f46', accent: '#10b981' },
  'Toys & Floats': { bg: '#fbcfe8', fg: '#9d174d', accent: '#db2777' },
  'Grills & Outdoor': { bg: '#fed7aa', fg: '#9a3412', accent: '#ea580c' },
  'Grill Accessories': { bg: '#fed7aa', fg: '#9a3412', accent: '#ea580c' },
  'Spas & Furniture': { bg: '#ddd6fe', fg: '#5b21b6', accent: '#7c3aed' },
  'Above Ground Pools': { bg: '#cffafe', fg: '#155e75', accent: '#0891b2' },
  'Automatic Pool Cleaners': { bg: '#bbf7d0', fg: '#14532d', accent: '#16a34a' },
  'Automation Control': { bg: '#e0e7ff', fg: '#312e81', accent: '#4f46e5' },
  'Pool Chemicals': { bg: '#bfdbfe', fg: '#1e3a8a', accent: '#2563eb' },
  'Spa Products': { bg: '#e9d5ff', fg: '#581c87', accent: '#7c3aed' },
  Equipment: { bg: '#bae6fd', fg: '#0c4a6e', accent: '#0284c7' },
  Service: { bg: '#e2e8f0', fg: '#0f172a', accent: '#0369a1' },
  Clearance: { bg: '#fecaca', fg: '#7f1d1d', accent: '#dc2626' },
};

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'P';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

function imageUrl(category, name) {
  const key =
    Object.keys(PALETTE).find((k) =>
      (category || '').toLowerCase().startsWith(k.toLowerCase().slice(0, 12)),
    ) || 'Equipment';
  const colors = PALETTE[key] ?? PALETTE.Equipment;
  const label = escapeXml(name.length > 18 ? `${name.slice(0, 16)}…` : name);
  const mark = escapeXml(initials(name));
  const catLabel = escapeXml((category || 'Pool').slice(0, 22));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="${colors.bg}"/>
  <circle cx="160" cy="95" r="48" fill="${colors.accent}" opacity="0.25"/>
  <circle cx="160" cy="95" r="28" fill="${colors.accent}"/>
  <text x="160" y="103" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="#ffffff">${mark}</text>
  <text x="160" y="185" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="${colors.fg}">${label}</text>
  <text x="160" y="208" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="${colors.accent}">${catLabel}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'pool-store' } });
  if (!tenant) throw new Error('pool-store not found');

  const products = await prisma.product.findMany({
    where: { tenantId: tenant.id },
    select: {
      id: true,
      name: true,
      skuCode: true,
      photoUrl: true,
      category: { select: { name: true } },
    },
  });

  let updated = 0;
  let skipped = 0;
  for (const p of products) {
    const category = p.category?.name || 'Equipment';
    // Keep real uploads; refresh missing / placeholder / SVG thumbs
    const existing = (p.photoUrl || '').trim();
    const isPlaceholder =
      !existing ||
      existing.startsWith('data:image/svg') ||
      /placeholder/i.test(existing) ||
      existing.includes('via.placeholder');
    if (!isPlaceholder) {
      skipped += 1;
      continue;
    }
    const photoUrl = imageUrl(category, p.name);
    await prisma.product.update({
      where: { id: p.id },
      data: { photoUrl },
    });
    updated += 1;
  }
  console.log(
    `Pool Store images: updated ${updated}, kept custom ${skipped}, total ${products.length}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
