/**
 * Re-attach pool product thumbs as base64 SVG (more reliable in <img>).
 * Usage: node scripts/seed-pool-product-images.mjs
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PRODUCTS = [
  ['Pool Chemicals', 'Chlorine Granules 25 lb', 'CHL-GRAN-25'],
  ['Pool Chemicals', 'Chlorine Tablets 3" 25 lb', 'CHL-TAB-25'],
  ['Pool Chemicals', 'Liquid Shock 1 gal', 'CHL-SHOCK-1G'],
  ['Pool Chemicals', 'pH Increaser 5 lb', 'PH-INC-5'],
  ['Pool Chemicals', 'pH Decreaser 7 lb', 'PH-DEC-7'],
  ['Pool Chemicals', 'Alkalinity Increaser 5 lb', 'ALK-INC-5'],
  ['Pool Chemicals', 'Cyanuric Acid Stabilizer 4 lb', 'CYA-4'],
  ['Pool Chemicals', 'Algaecide 1 qt', 'ALG-1QT'],
  ['Spa Products', 'Spa Sanitizer Bromine Tabs', 'SPA-BR-TABS'],
  ['Spa Products', 'Spa Foam Down', 'SPA-FOAM'],
  ['Spa Products', 'Spa Fragrance Eucalyptus', 'SPA-FRAG-EU'],
  ['Spa Products', 'Spa Test Strips 50ct', 'SPA-TEST-50'],
  ['Cleaners & Brushes', 'Wall Brush 18"', 'BRUSH-18'],
  ['Cleaners & Brushes', 'Leaf Skimmer Net', 'SKIM-NET'],
  ['Cleaners & Brushes', 'Vacuum Head Weighted', 'VAC-HEAD'],
  ['Cleaners & Brushes', 'Telescopic Pole 8–24 ft', 'POLE-824'],
  ['Filters & Pumps', 'Sand Filter Media 50 lb', 'SAND-50'],
  ['Filters & Pumps', 'Cartridge Filter C-4950', 'CART-C4950'],
  ['Filters & Pumps', 'Pump Basket Generic', 'PUMP-BASKET'],
  ['Equipment', 'Floating Thermometer', 'THERM-FLOAT'],
  ['Equipment', 'Pool Test Kit Liquid', 'TEST-KIT-LQ'],
  ['Equipment', 'Automatic Chlorinator Inline', 'CHLOR-INLINE'],
  ['Grills & Outdoor', 'Propane Grill Cover Large', 'GRILL-COV-L'],
  ['Grills & Outdoor', 'Outdoor Patio Heater', 'PATIO-HEAT'],
  ['Grills & Outdoor', 'Poolside Lounge Cushion', 'LOUNGE-CUSH'],
];

const PALETTE = {
  'Pool Chemicals': { bg: '#bfdbfe', fg: '#1e3a8a', accent: '#2563eb' },
  'Spa Products': { bg: '#e9d5ff', fg: '#581c87', accent: '#7c3aed' },
  'Cleaners & Brushes': { bg: '#a7f3d0', fg: '#065f46', accent: '#059669' },
  'Filters & Pumps': { bg: '#c7d2fe', fg: '#312e81', accent: '#4f46e5' },
  Equipment: { bg: '#bae6fd', fg: '#0c4a6e', accent: '#0284c7' },
  'Grills & Outdoor': { bg: '#fed7aa', fg: '#9a3412', accent: '#ea580c' },
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
  const colors = PALETTE[category] ?? PALETTE.Equipment;
  const label = escapeXml(name.length > 18 ? `${name.slice(0, 16)}…` : name);
  const mark = escapeXml(initials(name));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="${colors.bg}"/>
  <circle cx="160" cy="95" r="48" fill="${colors.accent}" opacity="0.25"/>
  <circle cx="160" cy="95" r="28" fill="${colors.accent}"/>
  <text x="160" y="103" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="#ffffff">${mark}</text>
  <text x="160" y="185" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="700" fill="${colors.fg}">${label}</text>
  <text x="160" y="208" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="${colors.accent}">${escapeXml(category)}</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'pool-store' } });
  if (!tenant) throw new Error('pool-store not found');

  let updated = 0;
  for (const [category, name, sku] of PRODUCTS) {
    const photoUrl = imageUrl(category, name);
    const res = await prisma.product.updateMany({
      where: { tenantId: tenant.id, skuCode: sku },
      data: { photoUrl },
    });
    updated += res.count;
  }
  console.log(`Updated ${updated} product images (base64 SVG)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
