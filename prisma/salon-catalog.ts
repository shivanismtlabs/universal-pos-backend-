/** Glow Salon–style catalog (services + retail) */
export const SALON_CATEGORIES = [
  'Hair',
  'Skin & Facial',
  'Nails',
  'Retail',
] as const;

export type SalonProductSeed = {
  category: (typeof SALON_CATEGORIES)[number];
  name: string;
  sku: string;
  price: number;
  /** service = no real stock; retail = countable */
  kind: 'service' | 'physical';
  qty: number;
};

export const SALON_PRODUCTS: SalonProductSeed[] = [
  { category: 'Hair', name: 'Men Haircut', sku: 'SVC-HAIR-M', price: 399, kind: 'service', qty: 999 },
  { category: 'Hair', name: 'Women Haircut', sku: 'SVC-HAIR-W', price: 699, kind: 'service', qty: 999 },
  { category: 'Hair', name: 'Hair Color (roots)', sku: 'SVC-COLOR', price: 1499, kind: 'service', qty: 999 },
  { category: 'Hair', name: 'Blow Dry', sku: 'SVC-BLOW', price: 499, kind: 'service', qty: 999 },
  { category: 'Skin & Facial', name: 'Classic Facial', sku: 'SVC-FACIAL', price: 999, kind: 'service', qty: 999 },
  { category: 'Skin & Facial', name: 'Cleanup', sku: 'SVC-CLEANUP', price: 599, kind: 'service', qty: 999 },
  { category: 'Nails', name: 'Manicure', sku: 'SVC-MANI', price: 449, kind: 'service', qty: 999 },
  { category: 'Nails', name: 'Pedicure', sku: 'SVC-PEDI', price: 549, kind: 'service', qty: 999 },
  { category: 'Retail', name: 'Argan Shampoo 250ml', sku: 'RTL-SHMP-250', price: 450, kind: 'physical', qty: 40 },
  { category: 'Retail', name: 'Hair Serum 50ml', sku: 'RTL-SERUM-50', price: 650, kind: 'physical', qty: 25 },
  { category: 'Retail', name: 'Nail Polish Red', sku: 'RTL-NP-RED', price: 199, kind: 'physical', qty: 60 },
  { category: 'Retail', name: 'Face Wash 100ml', sku: 'RTL-FW-100', price: 299, kind: 'physical', qty: 35 },
];
