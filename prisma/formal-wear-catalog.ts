/** Formal-wear serial rental catalog (Phase 6) — seed data only */
export type FormalUnitSeed = {
  barcode: string;
  size: string;
  deposit: number;
};

export type FormalProductSeed = {
  category: string;
  name: string;
  sku: string;
  rentalPrice: number;
  units: FormalUnitSeed[];
};

export const FORMAL_CATEGORIES = [
  'Jackets',
  'Trousers',
  'Footwear',
  'Accessories',
] as const;

export const FORMAL_PRODUCTS: FormalProductSeed[] = [
  {
    category: 'Jackets',
    name: 'Black Dinner Jacket',
    sku: 'JKT-BLK-DJ',
    rentalPrice: 4500,
    units: [
      { barcode: 'JKT-BLK-40', size: '40R', deposit: 2000 },
      { barcode: 'JKT-BLK-42', size: '42R', deposit: 2000 },
      { barcode: 'JKT-BLK-44', size: '44R', deposit: 2000 },
    ],
  },
  {
    category: 'Jackets',
    name: 'Navy Peak Lapel Jacket',
    sku: 'JKT-NVY-PK',
    rentalPrice: 4800,
    units: [
      { barcode: 'JKT-NVY-40', size: '40R', deposit: 2200 },
      { barcode: 'JKT-NVY-42', size: '42R', deposit: 2200 },
    ],
  },
  {
    category: 'Trousers',
    name: 'Black Formal Trouser',
    sku: 'TRS-BLK-01',
    rentalPrice: 1800,
    units: [
      { barcode: 'TRS-BLK-32', size: '32', deposit: 800 },
      { barcode: 'TRS-BLK-34', size: '34', deposit: 800 },
      { barcode: 'TRS-BLK-36', size: '36', deposit: 800 },
    ],
  },
  {
    category: 'Footwear',
    name: 'Black Oxford Shoe',
    sku: 'SHO-BLK-OX',
    rentalPrice: 900,
    units: [
      { barcode: 'SHO-BLK-9', size: '9', deposit: 500 },
      { barcode: 'SHO-BLK-10', size: '10', deposit: 500 },
    ],
  },
  {
    category: 'Accessories',
    name: 'Silk Bow Tie Black',
    sku: 'ACC-BT-BLK',
    rentalPrice: 400,
    units: [{ barcode: 'ACC-BT-001', size: 'OS', deposit: 200 }],
  },
];
