/**
 * Universal POS catalog shaped like a pool / spa / backyard retailer
 * (nav from https://thepoolstore.net/ — generic SKUs, not a scrape of their shop).
 *
 * POS model: sale items + service jobs. Same Universal catalog, not a vertical pack.
 */
export const POOL_STORE_SHOP = {
  name: 'The Pool Store',
  slug: 'pool-store',
  locationName: 'Valdosta Flagship',
  address: '3363 North Valdosta Road, Valdosta, GA 31602',
  city: 'Valdosta',
  state: 'GA',
  postalCode: '31602',
  country: 'US',
  phone: '+12292476440',
  currencyCode: 'USD',
  locale: 'en-US',
  timezone: 'America/New_York',
  tagline: 'Pool, spa, grill & backyard — Valdosta, GA',
  hours: {
    monFri: '9:00am – 6:00pm',
    saturday: '9:00am – 5:00pm',
    sunday: '11:00am – 4:00pm (Apr 1 – Nov 1)',
  },
  nav: [
    {
      group: 'Pools & Spas',
      children: ['Above Ground Pools', 'Spas & Hot Tubs'],
    },
    {
      group: 'Pool Chemicals',
      children: [
        'Chlorine & Shock',
        'Algaecides',
        'Stain Treatment',
        'Balance & Clarifiers',
        'Pool Maintenance Chemicals',
        'Spa Chemicals',
        'Spa Fragrances',
      ],
    },
    {
      group: 'Pool Equipment',
      children: [
        'Automatic Pool Cleaners',
        'Pumps & Motors',
        'Pool & Spa Filters',
        'Heaters',
        'Salt Systems',
        'Automation Control',
      ],
    },
    {
      group: 'Pool Supplies',
      children: [
        'Filter Media & Grids',
        'Pool & Spa Lights',
        'Replacement Parts',
        'Pool Maintenance',
        'Pool Decks',
        'Pool Covers',
      ],
    },
    {
      group: 'Backyard living',
      children: [
        'Saunas',
        'Floats',
        'Toys & Games',
        'Grills',
        'Firepits',
        'Grill Accessories',
        'Furniture',
        'Patio Accessories',
      ],
    },
  ],
  servicesNav: [
    'Installation & Repairs',
    'Request Service',
    'Water test / walk-in',
    'Pay My Bill (counter)',
  ],
} as const;

export const POOL_STORE_CATEGORIES = [
  'Chlorine & Shock',
  'Algaecides',
  'Stain Treatment',
  'Balance & Clarifiers',
  'Pool Maintenance Chemicals',
  'Spa Chemicals',
  'Spa Fragrances',
  'Automatic Pool Cleaners',
  'Pumps & Motors',
  'Pool & Spa Filters',
  'Heaters',
  'Salt Systems',
  'Automation Control',
  'Filter Media & Grids',
  'Pool & Spa Lights',
  'Replacement Parts',
  'Pool Maintenance',
  'Pool Decks',
  'Pool Covers',
  'Above Ground Pools',
  'Spas & Hot Tubs',
  'Saunas',
  'Floats',
  'Toys & Games',
  'Grills',
  'Firepits',
  'Grill Accessories',
  'Furniture',
  'Patio Accessories',
  'Clearance',
  'Service',
] as const;

export type PoolProductSeed = {
  category: (typeof POOL_STORE_CATEGORIES)[number];
  name: string;
  sku: string;
  price: number;
  qty: number;
  kind?: 'physical' | 'service';
};

export function poolProductFlags(p: PoolProductSeed) {
  const isService = p.kind === 'service';
  return {
    kind: (isService ? 'service' : 'physical') as 'physical' | 'service',
    fulfillmentMode: (isService ? 'service' : 'sale') as 'sale' | 'service',
    trackQty: !isService,
  };
}

export const POOL_STORE_PRODUCTS: PoolProductSeed[] = [
  { category: 'Chlorine & Shock', name: 'Chlorine granules 25 lb', sku: 'CHL-GRAN-25', price: 89.99, qty: 40 },
  { category: 'Chlorine & Shock', name: 'Chlorine tablets 3 in 25 lb', sku: 'CHL-TAB-25', price: 94.99, qty: 35 },
  { category: 'Chlorine & Shock', name: 'Liquid shock 1 gal', sku: 'CHL-SHOCK-1G', price: 12.99, qty: 80 },
  { category: 'Algaecides', name: 'Algaecide 1 qt', sku: 'ALG-1QT', price: 18.99, qty: 45 },
  { category: 'Algaecides', name: 'Mustard algae treatment', sku: 'ALG-MUST', price: 24.99, qty: 28 },
  { category: 'Stain Treatment', name: 'Metal stain remover', sku: 'STAIN-MET', price: 22.49, qty: 30 },
  { category: 'Stain Treatment', name: 'Scale prevent 1 qt', sku: 'STAIN-SCALE', price: 19.99, qty: 26 },
  { category: 'Balance & Clarifiers', name: 'pH increaser 5 lb', sku: 'PH-INC-5', price: 14.49, qty: 60 },
  { category: 'Balance & Clarifiers', name: 'pH decreaser 7 lb', sku: 'PH-DEC-7', price: 15.99, qty: 55 },
  { category: 'Balance & Clarifiers', name: 'Alkalinity increaser 5 lb', sku: 'ALK-INC-5', price: 13.99, qty: 50 },
  { category: 'Balance & Clarifiers', name: 'Stabilizer 4 lb', sku: 'CYA-4', price: 24.99, qty: 30 },
  { category: 'Balance & Clarifiers', name: 'Water clarifier 1 qt', sku: 'CLAR-1QT', price: 11.99, qty: 48 },
  { category: 'Pool Maintenance Chemicals', name: 'Enzyme cleaner 1 qt', sku: 'MAINT-ENZ', price: 16.99, qty: 32 },
  { category: 'Spa Chemicals', name: 'Spa bromine tabs', sku: 'SPA-BR-TABS', price: 29.99, qty: 40 },
  { category: 'Spa Chemicals', name: 'Spa foam down', sku: 'SPA-FOAM', price: 11.99, qty: 35 },
  { category: 'Spa Chemicals', name: 'Spa test strips 50ct', sku: 'SPA-TEST-50', price: 8.49, qty: 70 },
  { category: 'Spa Fragrances', name: 'Spa fragrance eucalyptus', sku: 'SPA-FRAG-EU', price: 9.99, qty: 50 },
  { category: 'Automatic Pool Cleaners', name: 'Pressure cleaner entry', sku: 'CLN-PRESS-E', price: 399, qty: 5 },
  { category: 'Automatic Pool Cleaners', name: 'Robotic cleaner entry', sku: 'CLN-ROBO-E', price: 499, qty: 4 },
  { category: 'Pumps & Motors', name: '1.5 HP pool pump', sku: 'PUMP-15HP', price: 389, qty: 6 },
  { category: 'Pumps & Motors', name: 'Pump basket', sku: 'PUMP-BASKET', price: 17.99, qty: 22 },
  { category: 'Pool & Spa Filters', name: 'Cartridge filter C-4950', sku: 'CART-C4950', price: 54.99, qty: 15 },
  { category: 'Heaters', name: 'Heater pad', sku: 'HEAT-PAD', price: 49.99, qty: 10 },
  { category: 'Salt Systems', name: 'Salt cell compatible', sku: 'SALT-CELL', price: 429, qty: 5 },
  { category: 'Salt Systems', name: 'Salt test strips', sku: 'SALT-TEST', price: 12.99, qty: 40 },
  { category: 'Automation Control', name: 'Pool timer switch', sku: 'AUTO-TIMER', price: 89.99, qty: 8 },
  { category: 'Filter Media & Grids', name: 'Sand filter media 50 lb', sku: 'SAND-50', price: 19.99, qty: 28 },
  { category: 'Pool & Spa Lights', name: 'LED pool light niche', sku: 'LIGHT-LED', price: 189, qty: 8 },
  { category: 'Replacement Parts', name: 'O-ring assortment kit', sku: 'ORING-KIT', price: 14.99, qty: 35 },
  { category: 'Pool Maintenance', name: 'Wall brush 18 in', sku: 'BRUSH-18', price: 22.99, qty: 25 },
  { category: 'Pool Maintenance', name: 'Leaf skimmer net', sku: 'SKIM-NET', price: 16.99, qty: 40 },
  { category: 'Pool Maintenance', name: 'Vacuum head weighted', sku: 'VAC-HEAD', price: 34.99, qty: 20 },
  { category: 'Pool Maintenance', name: 'Telescopic pole 8-24 ft', sku: 'POLE-824', price: 49.99, qty: 18 },
  { category: 'Pool Maintenance', name: 'Pool test kit liquid', sku: 'TEST-KIT-LQ', price: 21.99, qty: 32 },
  { category: 'Pool Decks', name: 'Deck anchor set', sku: 'DECK-ANC', price: 24.99, qty: 20 },
  { category: 'Pool Covers', name: 'Winter cover 18x36', sku: 'COV-W1836', price: 129, qty: 8 },
  { category: 'Pool Covers', name: 'Solar blanket 16 ft', sku: 'COV-SOL16', price: 89, qty: 10 },
  { category: 'Above Ground Pools', name: 'Above-ground liner 18 ft', sku: 'AGP-LINER18', price: 349, qty: 3 },
  { category: 'Spas & Hot Tubs', name: 'Spa cover lifter', sku: 'SPA-LIFT', price: 179, qty: 5 },
  { category: 'Saunas', name: 'Sauna bucket & ladle set', sku: 'SAUNA-SET', price: 39.99, qty: 12 },
  { category: 'Floats', name: 'Lounge float adult', sku: 'FLOAT-ADULT', price: 34.99, qty: 25 },
  { category: 'Floats', name: 'Noodle float 3-pack', sku: 'TOY-NOODLE', price: 19.99, qty: 30 },
  { category: 'Toys & Games', name: 'Dive ring set 4pc', sku: 'TOY-RINGS', price: 12.99, qty: 40 },
  { category: 'Grills', name: 'Propane grill cover large', sku: 'GRILL-COV-L', price: 39.99, qty: 14 },
  { category: 'Firepits', name: 'Fire pit bowl 26 in', sku: 'FIRE-26', price: 149, qty: 7 },
  { category: 'Grill Accessories', name: 'Grill tool set 5pc', sku: 'GRILL-TOOL', price: 29.99, qty: 18 },
  { category: 'Furniture', name: 'Patio chair set pair', sku: 'PATIO-CHAIR', price: 159, qty: 9 },
  { category: 'Patio Accessories', name: 'Outdoor patio heater', sku: 'PATIO-HEAT', price: 199.99, qty: 6 },
  { category: 'Clearance', name: 'Seasonal clearance mix', sku: 'CLR-MIX', price: 9.99, qty: 20 },
  {
    category: 'Service',
    name: 'Walk-in water test',
    sku: 'SVC-H2O-TEST',
    price: 0,
    qty: 0,
    kind: 'service',
  },
  {
    category: 'Service',
    name: 'On-site service call',
    sku: 'SVC-CALL',
    price: 89,
    qty: 0,
    kind: 'service',
  },
  {
    category: 'Service',
    name: 'Install / repair labor (hour)',
    sku: 'SVC-LABOR-HR',
    price: 125,
    qty: 0,
    kind: 'service',
  },
  {
    category: 'Service',
    name: 'Salt conversion consult',
    sku: 'SVC-SALT-CV',
    price: 75,
    qty: 0,
    kind: 'service',
  },
];
