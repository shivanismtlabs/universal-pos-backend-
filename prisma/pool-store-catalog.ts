/**
 * The Pool Store–style retail catalog (universal Sale keys only).
 * Categories mirror a real pool/spa retailer browse tree, but the POS
 * treats them as free-text shop categories — same for any retail vertical.
 * @see https://thepoolstore.net/
 */
export const POOL_STORE_CATEGORIES = [
  'Chlorine & Shock',
  'Algaecides & Stain',
  'Balance & Clarifiers',
  'Spa Chemicals',
  'Cleaners & Brushes',
  'Filters & Pumps',
  'Heaters & Salt',
  'Lights & Parts',
  'Covers & Decks',
  'Toys & Floats',
  'Grills & Outdoor',
  'Spas & Furniture',
] as const;

export type PoolProductSeed = {
  category: (typeof POOL_STORE_CATEGORIES)[number];
  name: string;
  sku: string;
  price: number;
  qty: number;
};

export const POOL_STORE_PRODUCTS: PoolProductSeed[] = [
  // Chlorine & Shock
  { category: 'Chlorine & Shock', name: 'Chlorine Granules 25 lb', sku: 'CHL-GRAN-25', price: 89.99, qty: 40 },
  { category: 'Chlorine & Shock', name: 'Chlorine Tablets 3" 25 lb', sku: 'CHL-TAB-25', price: 94.99, qty: 35 },
  { category: 'Chlorine & Shock', name: 'Liquid Shock 1 gal', sku: 'CHL-SHOCK-1G', price: 12.99, qty: 80 },
  { category: 'Chlorine & Shock', name: 'Dichlor Shock 1 lb', sku: 'CHL-DI-1', price: 9.49, qty: 90 },
  // Algaecides & Stain
  { category: 'Algaecides & Stain', name: 'Algaecide 1 qt', sku: 'ALG-1QT', price: 18.99, qty: 45 },
  { category: 'Algaecides & Stain', name: 'Mustard Algae Killer', sku: 'ALG-MUST', price: 24.99, qty: 28 },
  { category: 'Algaecides & Stain', name: 'Stain Remover Metal Out', sku: 'STAIN-MET', price: 22.49, qty: 30 },
  // Balance & Clarifiers
  { category: 'Balance & Clarifiers', name: 'pH Increaser 5 lb', sku: 'PH-INC-5', price: 14.49, qty: 60 },
  { category: 'Balance & Clarifiers', name: 'pH Decreaser 7 lb', sku: 'PH-DEC-7', price: 15.99, qty: 55 },
  { category: 'Balance & Clarifiers', name: 'Alkalinity Increaser 5 lb', sku: 'ALK-INC-5', price: 13.99, qty: 50 },
  { category: 'Balance & Clarifiers', name: 'Cyanuric Acid Stabilizer 4 lb', sku: 'CYA-4', price: 24.99, qty: 30 },
  { category: 'Balance & Clarifiers', name: 'Water Clarifier 1 qt', sku: 'CLAR-1QT', price: 11.99, qty: 48 },
  // Spa Chemicals
  { category: 'Spa Chemicals', name: 'Spa Sanitizer Bromine Tabs', sku: 'SPA-BR-TABS', price: 29.99, qty: 40 },
  { category: 'Spa Chemicals', name: 'Spa Foam Down', sku: 'SPA-FOAM', price: 11.99, qty: 35 },
  { category: 'Spa Chemicals', name: 'Spa Fragrance Eucalyptus', sku: 'SPA-FRAG-EU', price: 9.99, qty: 50 },
  { category: 'Spa Chemicals', name: 'Spa Test Strips 50ct', sku: 'SPA-TEST-50', price: 8.49, qty: 70 },
  // Cleaners & Brushes
  { category: 'Cleaners & Brushes', name: 'Wall Brush 18"', sku: 'BRUSH-18', price: 22.99, qty: 25 },
  { category: 'Cleaners & Brushes', name: 'Leaf Skimmer Net', sku: 'SKIM-NET', price: 16.99, qty: 40 },
  { category: 'Cleaners & Brushes', name: 'Vacuum Head Weighted', sku: 'VAC-HEAD', price: 34.99, qty: 20 },
  { category: 'Cleaners & Brushes', name: 'Telescopic Pole 8–24 ft', sku: 'POLE-824', price: 49.99, qty: 18 },
  { category: 'Cleaners & Brushes', name: 'Robotic Cleaner Entry', sku: 'ROBO-ENT', price: 499.0, qty: 4 },
  // Filters & Pumps
  { category: 'Filters & Pumps', name: 'Sand Filter Media 50 lb', sku: 'SAND-50', price: 19.99, qty: 28 },
  { category: 'Filters & Pumps', name: 'Cartridge Filter C-4950', sku: 'CART-C4950', price: 54.99, qty: 15 },
  { category: 'Filters & Pumps', name: 'Pump Basket Generic', sku: 'PUMP-BASKET', price: 17.99, qty: 22 },
  { category: 'Filters & Pumps', name: '1.5 HP Pool Pump', sku: 'PUMP-15HP', price: 389.0, qty: 6 },
  // Heaters & Salt
  { category: 'Heaters & Salt', name: 'Gas Heater Pad', sku: 'HEAT-PAD', price: 49.99, qty: 10 },
  { category: 'Heaters & Salt', name: 'Salt Cell Compatible', sku: 'SALT-CELL', price: 429.0, qty: 5 },
  { category: 'Heaters & Salt', name: 'Salt Test Strips', sku: 'SALT-TEST', price: 12.99, qty: 40 },
  // Lights & Parts
  { category: 'Lights & Parts', name: 'LED Pool Light Niche', sku: 'LIGHT-LED', price: 189.0, qty: 8 },
  { category: 'Lights & Parts', name: 'O-Ring Assortment Kit', sku: 'ORING-KIT', price: 14.99, qty: 35 },
  { category: 'Lights & Parts', name: 'Floating Thermometer', sku: 'THERM-FLOAT', price: 7.99, qty: 60 },
  { category: 'Lights & Parts', name: 'Pool Test Kit Liquid', sku: 'TEST-KIT-LQ', price: 21.99, qty: 32 },
  { category: 'Lights & Parts', name: 'Automatic Chlorinator Inline', sku: 'CHLOR-INLINE', price: 79.99, qty: 12 },
  // Covers & Decks
  { category: 'Covers & Decks', name: 'Winter Cover 18x36', sku: 'COV-W1836', price: 129.0, qty: 8 },
  { category: 'Covers & Decks', name: 'Solar Blanket 16 ft', sku: 'COV-SOL16', price: 89.0, qty: 10 },
  { category: 'Covers & Decks', name: 'Deck Anchor Set', sku: 'DECK-ANC', price: 24.99, qty: 20 },
  // Toys & Floats
  { category: 'Toys & Floats', name: 'Lounge Float Adult', sku: 'FLOAT-ADULT', price: 34.99, qty: 25 },
  { category: 'Toys & Floats', name: 'Dive Ring Set 4pc', sku: 'TOY-RINGS', price: 12.99, qty: 40 },
  { category: 'Toys & Floats', name: 'Noodle Float 3-Pack', sku: 'TOY-NOODLE', price: 19.99, qty: 30 },
  // Grills & Outdoor
  { category: 'Grills & Outdoor', name: 'Propane Grill Cover Large', sku: 'GRILL-COV-L', price: 39.99, qty: 14 },
  { category: 'Grills & Outdoor', name: 'Outdoor Patio Heater', sku: 'PATIO-HEAT', price: 199.99, qty: 6 },
  { category: 'Grills & Outdoor', name: 'Fire Pit Bowl 26"', sku: 'FIRE-26', price: 149.0, qty: 7 },
  { category: 'Grills & Outdoor', name: 'Grill Tool Set 5pc', sku: 'GRILL-TOOL', price: 29.99, qty: 18 },
  // Spas & Furniture
  { category: 'Spas & Furniture', name: 'Spa Cover Lifter', sku: 'SPA-LIFT', price: 179.0, qty: 5 },
  { category: 'Spas & Furniture', name: 'Poolside Lounge Cushion', sku: 'LOUNGE-CUSH', price: 44.99, qty: 16 },
  { category: 'Spas & Furniture', name: 'Patio Chair Set Pair', sku: 'PATIO-CHAIR', price: 159.0, qty: 9 },
];
