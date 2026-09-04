/**
 * Rental Business — 50 serialized rental items.
 * All rental items use fulfillmentMode: 'rental' + trackSerial: true.
 * Lifecycle: Available → Reserved → Rented → Returned.
 */

export type RentalItem = {
  category: string;
  name: string;
  sku: string;
  rentalPrice: number;         // per-day rental rate
  depositAmount: number;
  taxCode: string;
  kind: 'physical';
  description?: string;
  brand?: string;
  units: Array<{
    barcode: string;
    size: string;
    condition: 'new' | 'good' | 'damaged';
    ownership: 'own';
    depositAmount: number;
  }>;
  meta?: Record<string, unknown>;
};

export const RENTAL_CATEGORIES = [
  'Ethnic Wear – Women',
  'Ethnic Wear – Men',
  'Western Wear',
  'Photography & AV',
  'Event Furniture',
  'Sound & Lighting',
  'Sports Equipment',
  'Tools & Machinery',
  'Electronics',
];

export const RENTAL_PRODUCTS: RentalItem[] = [
  // ── Ethnic Wear – Women ───────────────────────────────────────────────────
  {
    category: 'Ethnic Wear – Women',
    name: 'Banarasi Silk Saree – Red',
    sku: 'RNT-SAR-BAN-RED',
    rentalPrice: 800,
    depositAmount: 5000,
    taxCode: '6206',
    kind: 'physical',
    description: 'Heavy Banarasi silk with gold zari border — Wedding ready',
    brand: 'Heritage Weaves',
    units: [
      { barcode: 'RNT-SAR-BAN-RED-U1', size: 'Standard 5.5m', condition: 'good', ownership: 'own', depositAmount: 5000 },
      { barcode: 'RNT-SAR-BAN-RED-U2', size: 'Standard 5.5m', condition: 'good', ownership: 'own', depositAmount: 5000 },
    ],
    meta: { material: 'Silk', occasion: 'Wedding', color: 'Red', rentalPeriodDays: 2 },
  },
  {
    category: 'Ethnic Wear – Women',
    name: 'Kanjivaram Silk Saree – Green',
    sku: 'RNT-SAR-KAN-GRN',
    rentalPrice: 1000,
    depositAmount: 7000,
    taxCode: '6206',
    kind: 'physical',
    description: 'Pure Kanjivaram silk with contrast border — Festival wear',
    brand: 'Heritage Weaves',
    units: [
      { barcode: 'RNT-SAR-KAN-GRN-U1', size: 'Standard 5.5m', condition: 'new', ownership: 'own', depositAmount: 7000 },
      { barcode: 'RNT-SAR-KAN-GRN-U2', size: 'Standard 5.5m', condition: 'good', ownership: 'own', depositAmount: 7000 },
    ],
    meta: { material: 'Silk', occasion: 'Festival', color: 'Green' },
  },
  {
    category: 'Ethnic Wear – Women',
    name: 'Chanderi Silk Saree – Blue',
    sku: 'RNT-SAR-CHA-BLU',
    rentalPrice: 600,
    depositAmount: 3500,
    taxCode: '6206',
    kind: 'physical',
    description: 'Lightweight Chanderi with delicate embroidery',
    units: [
      { barcode: 'RNT-SAR-CHA-BLU-U1', size: 'Standard 5.5m', condition: 'good', ownership: 'own', depositAmount: 3500 },
      { barcode: 'RNT-SAR-CHA-BLU-U2', size: 'Standard 5.5m', condition: 'good', ownership: 'own', depositAmount: 3500 },
    ],
    meta: { material: 'Chanderi Silk', occasion: 'Formal' },
  },
  {
    category: 'Ethnic Wear – Women',
    name: 'Bridal Lehenga – Maroon',
    sku: 'RNT-LEHA-BRI-MAR',
    rentalPrice: 2500,
    depositAmount: 20000,
    taxCode: '6211',
    kind: 'physical',
    description: 'Heavy embroidered bridal lehenga set — 3 piece',
    brand: 'Bridal Couture',
    units: [
      { barcode: 'RNT-LEHA-BRI-MAR-U1', size: 'S (34)', condition: 'new', ownership: 'own', depositAmount: 20000 },
      { barcode: 'RNT-LEHA-BRI-MAR-U2', size: 'M (36)', condition: 'new', ownership: 'own', depositAmount: 20000 },
      { barcode: 'RNT-LEHA-BRI-MAR-U3', size: 'L (38)', condition: 'new', ownership: 'own', depositAmount: 20000 },
    ],
    meta: { material: 'Silk+Net', occasion: 'Wedding', pieces: 3 },
  },
  {
    category: 'Ethnic Wear – Women',
    name: 'Anarkali Suit – Royal Blue',
    sku: 'RNT-ANAK-ROY-BLU',
    rentalPrice: 800,
    depositAmount: 5000,
    taxCode: '6211',
    kind: 'physical',
    description: 'Full-length Anarkali with dupatta',
    units: [
      { barcode: 'RNT-ANAK-ROY-BLU-U1', size: 'S', condition: 'good', ownership: 'own', depositAmount: 5000 },
      { barcode: 'RNT-ANAK-ROY-BLU-U2', size: 'M', condition: 'good', ownership: 'own', depositAmount: 5000 },
    ],
    meta: { occasion: 'Festive', pieces: 2 },
  },
  {
    category: 'Ethnic Wear – Women',
    name: 'Navratri Chaniya Choli – Orange',
    sku: 'RNT-CHA-NAV-ORG',
    rentalPrice: 500,
    depositAmount: 2000,
    taxCode: '6211',
    kind: 'physical',
    description: 'Traditional bandhani chaniya choli set',
    units: [
      { barcode: 'RNT-CHA-NAV-ORG-U1', size: 'S', condition: 'good', ownership: 'own', depositAmount: 2000 },
      { barcode: 'RNT-CHA-NAV-ORG-U2', size: 'M', condition: 'good', ownership: 'own', depositAmount: 2000 },
      { barcode: 'RNT-CHA-NAV-ORG-U3', size: 'L', condition: 'good', ownership: 'own', depositAmount: 2000 },
    ],
    meta: { occasion: 'Navratri', pieces: 3 },
  },

  // ── Ethnic Wear – Men ─────────────────────────────────────────────────────
  {
    category: 'Ethnic Wear – Men',
    name: 'Sherwani – Ivory Gold',
    sku: 'RNT-SHW-IVY-GLD',
    rentalPrice: 1500,
    depositAmount: 12000,
    taxCode: '6211',
    kind: 'physical',
    description: 'Embroidered sherwani with churidar — Groom set',
    brand: 'Royal Dress',
    units: [
      { barcode: 'RNT-SHW-IVY-GLD-U1', size: '38', condition: 'new', ownership: 'own', depositAmount: 12000 },
      { barcode: 'RNT-SHW-IVY-GLD-U2', size: '40', condition: 'new', ownership: 'own', depositAmount: 12000 },
      { barcode: 'RNT-SHW-IVY-GLD-U3', size: '42', condition: 'good', ownership: 'own', depositAmount: 12000 },
    ],
    meta: { occasion: 'Wedding', material: 'Brocade', pieces: 2 },
  },
  {
    category: 'Ethnic Wear – Men',
    name: 'Sherwani – Maroon',
    sku: 'RNT-SHW-MAR',
    rentalPrice: 1200,
    depositAmount: 9000,
    taxCode: '6211',
    kind: 'physical',
    description: 'Embroidered sherwani — Baraati/groomsman set',
    units: [
      { barcode: 'RNT-SHW-MAR-U1', size: '38', condition: 'good', ownership: 'own', depositAmount: 9000 },
      { barcode: 'RNT-SHW-MAR-U2', size: '40', condition: 'good', ownership: 'own', depositAmount: 9000 },
    ],
    meta: { occasion: 'Wedding', pieces: 2 },
  },
  {
    category: 'Ethnic Wear – Men',
    name: 'Indo-Western Suit – Navy',
    sku: 'RNT-INDW-NAVY',
    rentalPrice: 1000,
    depositAmount: 7000,
    taxCode: '6211',
    kind: 'physical',
    description: 'Jodhpuri suit with breeches',
    units: [
      { barcode: 'RNT-INDW-NAVY-U1', size: '38', condition: 'good', ownership: 'own', depositAmount: 7000 },
      { barcode: 'RNT-INDW-NAVY-U2', size: '40', condition: 'good', ownership: 'own', depositAmount: 7000 },
    ],
    meta: { occasion: 'Formal', pieces: 2 },
  },
  {
    category: 'Ethnic Wear – Men',
    name: 'Kurta Pajama Set – White',
    sku: 'RNT-KP-WHT',
    rentalPrice: 400,
    depositAmount: 1500,
    taxCode: '6211',
    kind: 'physical',
    description: 'Silk kurta with matching pajama',
    units: [
      { barcode: 'RNT-KP-WHT-U1', size: 'M', condition: 'good', ownership: 'own', depositAmount: 1500 },
      { barcode: 'RNT-KP-WHT-U2', size: 'L', condition: 'good', ownership: 'own', depositAmount: 1500 },
      { barcode: 'RNT-KP-WHT-U3', size: 'XL', condition: 'good', ownership: 'own', depositAmount: 1500 },
    ],
    meta: { pieces: 2 },
  },

  // ── Western Wear ──────────────────────────────────────────────────────────
  {
    category: 'Western Wear',
    name: '3-Piece Business Suit – Charcoal',
    sku: 'RNT-SUIT-3P-CHR',
    rentalPrice: 1200,
    depositAmount: 8000,
    taxCode: '6203',
    kind: 'physical',
    description: 'Wool blend 3-piece suit — Jacket, trousers, waistcoat',
    brand: 'ProStyle',
    units: [
      { barcode: 'RNT-SUIT-3P-CHR-U1', size: '38R', condition: 'good', ownership: 'own', depositAmount: 8000 },
      { barcode: 'RNT-SUIT-3P-CHR-U2', size: '40R', condition: 'good', ownership: 'own', depositAmount: 8000 },
      { barcode: 'RNT-SUIT-3P-CHR-U3', size: '42R', condition: 'good', ownership: 'own', depositAmount: 8000 },
    ],
    meta: { color: 'Charcoal', material: 'Wool blend', pieces: 3 },
  },
  {
    category: 'Western Wear',
    name: 'Black Tuxedo',
    sku: 'RNT-TUX-BLK',
    rentalPrice: 1500,
    depositAmount: 10000,
    taxCode: '6203',
    kind: 'physical',
    description: 'Black tuxedo with bow tie',
    units: [
      { barcode: 'RNT-TUX-BLK-U1', size: '38R', condition: 'good', ownership: 'own', depositAmount: 10000 },
      { barcode: 'RNT-TUX-BLK-U2', size: '40R', condition: 'good', ownership: 'own', depositAmount: 10000 },
    ],
    meta: { color: 'Black', occasion: 'Gala/Formal', pieces: 3 },
  },

  // ── Photography & AV ──────────────────────────────────────────────────────
  {
    category: 'Photography & AV',
    name: 'DSLR Camera – Canon EOS 5D Mark IV',
    sku: 'RNT-CAM-5D4',
    rentalPrice: 2500,
    depositAmount: 80000,
    taxCode: '8525',
    kind: 'physical',
    description: 'Full-frame DSLR with 24-70mm lens — per day',
    brand: 'Canon',
    units: [
      { barcode: 'RNT-CAM-5D4-U1', size: 'Body + 24-70mm', condition: 'good', ownership: 'own', depositAmount: 80000 },
      { barcode: 'RNT-CAM-5D4-U2', size: 'Body + 24-70mm', condition: 'good', ownership: 'own', depositAmount: 80000 },
    ],
    meta: { resolution: '30MP', lensIncluded: '24-70mm f/2.8' },
  },
  {
    category: 'Photography & AV',
    name: 'Sony A7 III Mirrorless Camera',
    sku: 'RNT-CAM-A7III',
    rentalPrice: 2200,
    depositAmount: 70000,
    taxCode: '8525',
    kind: 'physical',
    description: 'Full-frame mirrorless with 28-70mm OSS kit lens',
    brand: 'Sony',
    units: [
      { barcode: 'RNT-CAM-A7III-U1', size: 'Body + 28-70mm', condition: 'new', ownership: 'own', depositAmount: 70000 },
    ],
    meta: { resolution: '24.2MP', sensorType: 'Full-frame BSI CMOS' },
  },
  {
    category: 'Photography & AV',
    name: 'DJI Mavic 3 Drone',
    sku: 'RNT-DRONE-MAV3',
    rentalPrice: 3500,
    depositAmount: 100000,
    taxCode: '8806',
    kind: 'physical',
    description: '4K 20fps camera drone — per day (includes 3 batteries)',
    brand: 'DJI',
    units: [
      { barcode: 'RNT-DRONE-MAV3-U1', size: 'Mavic 3 Fly-More Combo', condition: 'good', ownership: 'own', depositAmount: 100000 },
    ],
    meta: { resolution: '4K/50fps', flightTimeMinutes: 46 },
  },
  {
    category: 'Photography & AV',
    name: 'Projector – 4000 Lumen Full-HD',
    sku: 'RNT-PROJ-4K',
    rentalPrice: 1800,
    depositAmount: 40000,
    taxCode: '8528',
    kind: 'physical',
    description: 'Full-HD 1920×1080, 4000 ANSI lumens — per day',
    brand: 'Epson',
    units: [
      { barcode: 'RNT-PROJ-4K-U1', size: 'With remote & HDMI', condition: 'good', ownership: 'own', depositAmount: 40000 },
      { barcode: 'RNT-PROJ-4K-U2', size: 'With remote & HDMI', condition: 'good', ownership: 'own', depositAmount: 40000 },
    ],
    meta: { resolution: '1920x1080', brightness: '4000 lumens' },
  },
  {
    category: 'Photography & AV',
    name: 'Projection Screen – 10ft × 7ft',
    sku: 'RNT-SCREEN-10',
    rentalPrice: 500,
    depositAmount: 5000,
    taxCode: '9401',
    kind: 'physical',
    description: 'Tripod projection screen — 120 inch diagonal',
    units: [
      { barcode: 'RNT-SCREEN-10-U1', size: '120"', condition: 'good', ownership: 'own', depositAmount: 5000 },
      { barcode: 'RNT-SCREEN-10-U2', size: '120"', condition: 'good', ownership: 'own', depositAmount: 5000 },
    ],
  },

  // ── Sound & Lighting ──────────────────────────────────────────────────────
  {
    category: 'Sound & Lighting',
    name: 'PA Speaker System – 1000W Pair',
    sku: 'RNT-SPK-PA1K',
    rentalPrice: 2000,
    depositAmount: 30000,
    taxCode: '8518',
    kind: 'physical',
    description: 'Powered PA speaker pair with stand — per day',
    brand: 'JBL',
    units: [
      { barcode: 'RNT-SPK-PA1K-U1', size: '1000W Pair', condition: 'good', ownership: 'own', depositAmount: 30000 },
    ],
    meta: { power: '1000W', channels: 2 },
  },
  {
    category: 'Sound & Lighting',
    name: 'Wireless Microphone Set (2-Mic)',
    sku: 'RNT-MIC-2SET',
    rentalPrice: 800,
    depositAmount: 10000,
    taxCode: '8518',
    kind: 'physical',
    description: '2-channel UHF wireless mic with receiver — per day',
    brand: 'Shure',
    units: [
      { barcode: 'RNT-MIC-2SET-U1', size: '2-mic set', condition: 'good', ownership: 'own', depositAmount: 10000 },
      { barcode: 'RNT-MIC-2SET-U2', size: '2-mic set', condition: 'good', ownership: 'own', depositAmount: 10000 },
    ],
  },
  {
    category: 'Sound & Lighting',
    name: 'LED Par Stage Lights (Set of 8)',
    sku: 'RNT-LED-PAR8',
    rentalPrice: 1500,
    depositAmount: 20000,
    taxCode: '9405',
    kind: 'physical',
    description: '8× RGB LED Par cans with DMX controller',
    units: [
      { barcode: 'RNT-LED-PAR8-U1', size: 'Set of 8', condition: 'good', ownership: 'own', depositAmount: 20000 },
    ],
    meta: { quantity: 8, protocol: 'DMX' },
  },
  {
    category: 'Sound & Lighting',
    name: 'DJ Mixer – Pioneer DDJ-400',
    sku: 'RNT-DJ-DDJ400',
    rentalPrice: 2500,
    depositAmount: 35000,
    taxCode: '8519',
    kind: 'physical',
    description: 'Professional 2-channel DJ controller — per day',
    brand: 'Pioneer',
    units: [
      { barcode: 'RNT-DJ-DDJ400-U1', size: 'DDJ-400', condition: 'good', ownership: 'own', depositAmount: 35000 },
    ],
  },

  // ── Event Furniture ───────────────────────────────────────────────────────
  {
    category: 'Event Furniture',
    name: 'Banquet Chair – White Plastic (per chair)',
    sku: 'RNT-CHAIR-WH',
    rentalPrice: 25,
    depositAmount: 150,
    taxCode: '9401',
    kind: 'physical',
    description: 'Stackable white resin banquet chair',
    units: [
      { barcode: 'RNT-CHAIR-WH-U01', size: 'Standard', condition: 'good', ownership: 'own', depositAmount: 150 },
      { barcode: 'RNT-CHAIR-WH-U02', size: 'Standard', condition: 'good', ownership: 'own', depositAmount: 150 },
      { barcode: 'RNT-CHAIR-WH-U03', size: 'Standard', condition: 'good', ownership: 'own', depositAmount: 150 },
      { barcode: 'RNT-CHAIR-WH-U04', size: 'Standard', condition: 'good', ownership: 'own', depositAmount: 150 },
      { barcode: 'RNT-CHAIR-WH-U05', size: 'Standard', condition: 'good', ownership: 'own', depositAmount: 150 },
    ],
  },
  {
    category: 'Event Furniture',
    name: 'Folding Table – 6ft Rectangular',
    sku: 'RNT-TABLE-6FT',
    rentalPrice: 150,
    depositAmount: 1500,
    taxCode: '9403',
    kind: 'physical',
    description: '6ft × 2.5ft folding banquet table',
    units: [
      { barcode: 'RNT-TABLE-6FT-U1', size: '6ft', condition: 'good', ownership: 'own', depositAmount: 1500 },
      { barcode: 'RNT-TABLE-6FT-U2', size: '6ft', condition: 'good', ownership: 'own', depositAmount: 1500 },
      { barcode: 'RNT-TABLE-6FT-U3', size: '6ft', condition: 'good', ownership: 'own', depositAmount: 1500 },
    ],
  },
  {
    category: 'Event Furniture',
    name: 'Round Table – 5ft (6-seater)',
    sku: 'RNT-TABLE-5RT',
    rentalPrice: 200,
    depositAmount: 2000,
    taxCode: '9403',
    kind: 'physical',
    description: '5ft round table for banquet seating',
    units: [
      { barcode: 'RNT-TABLE-5RT-U1', size: '5ft', condition: 'good', ownership: 'own', depositAmount: 2000 },
      { barcode: 'RNT-TABLE-5RT-U2', size: '5ft', condition: 'good', ownership: 'own', depositAmount: 2000 },
    ],
  },

  // ── Sports Equipment ──────────────────────────────────────────────────────
  {
    category: 'Sports Equipment',
    name: 'Cricket Kit – Full Set',
    sku: 'RNT-CRIK-KIT',
    rentalPrice: 800,
    depositAmount: 8000,
    taxCode: '9506',
    kind: 'physical',
    description: 'Bat + pads + gloves + helmet + bag',
    units: [
      { barcode: 'RNT-CRIK-KIT-U1', size: 'Adult', condition: 'good', ownership: 'own', depositAmount: 8000 },
      { barcode: 'RNT-CRIK-KIT-U2', size: 'Adult', condition: 'good', ownership: 'own', depositAmount: 8000 },
    ],
    meta: { pieces: 5 },
  },
  {
    category: 'Sports Equipment',
    name: 'Badminton Racket Set (4-pack)',
    sku: 'RNT-BAD-4SET',
    rentalPrice: 200,
    depositAmount: 2000,
    taxCode: '9506',
    kind: 'physical',
    description: '4 rackets + shuttlecocks + bag',
    units: [
      { barcode: 'RNT-BAD-4SET-U1', size: '4-pack', condition: 'good', ownership: 'own', depositAmount: 2000 },
      { barcode: 'RNT-BAD-4SET-U2', size: '4-pack', condition: 'good', ownership: 'own', depositAmount: 2000 },
    ],
  },
  {
    category: 'Sports Equipment',
    name: 'Football – Official Size 5',
    sku: 'RNT-FOOT-S5',
    rentalPrice: 100,
    depositAmount: 1000,
    taxCode: '9506',
    kind: 'physical',
    description: 'FIFA-quality match football',
    units: [
      { barcode: 'RNT-FOOT-S5-U1', size: 'Size 5', condition: 'good', ownership: 'own', depositAmount: 1000 },
      { barcode: 'RNT-FOOT-S5-U2', size: 'Size 5', condition: 'good', ownership: 'own', depositAmount: 1000 },
      { barcode: 'RNT-FOOT-S5-U3', size: 'Size 5', condition: 'good', ownership: 'own', depositAmount: 1000 },
    ],
  },

  // ── Tools & Machinery ────────────────────────────────────────────────────
  {
    category: 'Tools & Machinery',
    name: 'Power Drill – Bosch 18V',
    sku: 'RNT-DRILL-BSH18',
    rentalPrice: 350,
    depositAmount: 5000,
    taxCode: '8467',
    kind: 'physical',
    description: '18V cordless drill with 2 batteries — per day',
    brand: 'Bosch',
    units: [
      { barcode: 'RNT-DRILL-BSH18-U1', size: '18V + 2 batteries', condition: 'good', ownership: 'own', depositAmount: 5000 },
      { barcode: 'RNT-DRILL-BSH18-U2', size: '18V + 2 batteries', condition: 'good', ownership: 'own', depositAmount: 5000 },
    ],
  },
  {
    category: 'Tools & Machinery',
    name: 'Pressure Washer – 1800W',
    sku: 'RNT-PWASH-1800',
    rentalPrice: 500,
    depositAmount: 8000,
    taxCode: '8424',
    kind: 'physical',
    description: '1800W electric pressure washer — 150 bar',
    brand: 'Karcher',
    units: [
      { barcode: 'RNT-PWASH-1800-U1', size: '1800W', condition: 'good', ownership: 'own', depositAmount: 8000 },
    ],
    meta: { pressure: '150 bar', power: '1800W' },
  },
  {
    category: 'Tools & Machinery',
    name: 'Generator – 2KVA Silent',
    sku: 'RNT-GEN-2KVA',
    rentalPrice: 1200,
    depositAmount: 20000,
    taxCode: '8502',
    kind: 'physical',
    description: 'Silent 2KVA petrol generator — per day',
    brand: 'Honda',
    units: [
      { barcode: 'RNT-GEN-2KVA-U1', size: '2KVA', condition: 'good', ownership: 'own', depositAmount: 20000 },
    ],
  },

  // ── Electronics ───────────────────────────────────────────────────────────
  {
    category: 'Electronics',
    name: 'Laptop – Dell i5 16GB (per day)',
    sku: 'RNT-LAPTOP-DELL',
    rentalPrice: 800,
    depositAmount: 40000,
    taxCode: '8471',
    kind: 'physical',
    description: 'Dell Latitude i5 16GB 256GB SSD — per day',
    brand: 'Dell',
    units: [
      { barcode: 'RNT-LAPTOP-DELL-U1', size: 'i5 16GB 256GB', condition: 'good', ownership: 'own', depositAmount: 40000 },
      { barcode: 'RNT-LAPTOP-DELL-U2', size: 'i5 16GB 256GB', condition: 'good', ownership: 'own', depositAmount: 40000 },
    ],
  },
  {
    category: 'Electronics',
    name: 'iPad Pro 11" (per day)',
    sku: 'RNT-IPAD-11',
    rentalPrice: 600,
    depositAmount: 50000,
    taxCode: '8471',
    kind: 'physical',
    description: 'iPad Pro 11" M2 with Apple Pencil — per day',
    brand: 'Apple',
    units: [
      { barcode: 'RNT-IPAD-11-U1', size: '11" 256GB WiFi', condition: 'new', ownership: 'own', depositAmount: 50000 },
    ],
  },
  {
    category: 'Electronics',
    name: 'Portable Bluetooth Speaker',
    sku: 'RNT-BTSPK-01',
    rentalPrice: 300,
    depositAmount: 3000,
    taxCode: '8518',
    kind: 'physical',
    description: 'JBL Charge 5 — 20W waterproof — per day',
    brand: 'JBL',
    units: [
      { barcode: 'RNT-BTSPK-U1', size: 'JBL Charge 5', condition: 'good', ownership: 'own', depositAmount: 3000 },
      { barcode: 'RNT-BTSPK-U2', size: 'JBL Charge 5', condition: 'good', ownership: 'own', depositAmount: 3000 },
      { barcode: 'RNT-BTSPK-U3', size: 'JBL Charge 5', condition: 'good', ownership: 'own', depositAmount: 3000 },
    ],
  },
];

export const RENTAL_CUSTOMERS = [
  { name: 'Aditya Kapoor', phone: '9703000001', email: 'aditya@rental.demo', meta: { idProof: 'AADHAAR-1234' } },
  { name: 'Bhavna Shah', phone: '9703000002', email: 'bhavna@rental.demo', meta: { idProof: 'PAN-ABCDE1234' } },
  { name: 'Chirag Mehta', phone: '9703000003', email: 'chirag@rental.demo', meta: { idProof: 'DL-GJ01-2023' } },
  { name: 'Devika Pillai', phone: '9703000004', email: 'devika@rental.demo', meta: { idProof: 'AADHAAR-5678' } },
  { name: 'Esha Gupta', phone: '9703000005', email: 'esha@rental.demo', meta: { idProof: 'PAN-FGHIJ5678' } },
  { name: 'Farhan Khan', phone: '9703000006', email: 'farhan@rental.demo', meta: { idProof: 'AADHAAR-9012' } },
  { name: 'Gita Nair', phone: '9703000007', email: 'gita@rental.demo', meta: {} },
  { name: 'Harsh Vardhan', phone: '9703000008', email: 'harsh@rental.demo', meta: { idProof: 'AADHAAR-3456' } },
  { name: 'Isha Rathore', phone: '9703000009', email: 'isha@rental.demo', meta: {} },
  { name: 'Jitesh Soni', phone: '9703000010', email: 'jitesh@rental.demo', meta: { idProof: 'PAN-KLMNO9012' } },
  { name: 'Kavya Reddy', phone: '9703000011', email: 'kavya@rental.demo', meta: {} },
  { name: 'Lokesh Sharma', phone: '9703000012', email: 'lokesh@rental.demo', meta: { idProof: 'AADHAAR-7890' } },
  { name: 'Manasi Joshi', phone: '9703000013', email: 'manasi@rental.demo', meta: {} },
  { name: 'Nikhil Bose', phone: '9703000014', email: 'nikhil@rental.demo', meta: { idProof: 'DL-MH01-2024' } },
  { name: 'Onkar Singh', phone: '9703000015', email: 'onkar@rental.demo', meta: {} },
  { name: 'Preethi Kumar', phone: '9703000016', email: 'preethi@rental.demo', meta: {} },
  { name: 'Qureshi Anwar', phone: '9703000017', email: 'qureshi@rental.demo', meta: { idProof: 'AADHAAR-2345' } },
  { name: 'Radhika Iyer', phone: '9703000018', email: 'radhika@rental.demo', meta: {} },
  { name: 'Suresh Babu', phone: '9703000019', email: 'suresh@rental.demo', meta: { idProof: 'PAN-PQRST6789' } },
  { name: 'Walk-in Customer', phone: '9703000020', email: null, meta: {} },
];

export const RENTAL_STAFF = [
  { email: 'rental.manager@rental.demo', fullName: 'Rental Manager', role: 'manager', code: 'RN002' },
  { email: 'rental.staff@rental.demo', fullName: 'Rental Cashier', role: 'cashier', code: 'RN003' },
];

export const RENTAL_SUPPLIERS = [
  { code: 'SUP-RNT-001', name: 'Textile Wholesale Bazaar', supplierType: 'wholesaler', contact: 'Ram Textile', phone: '9900003001', email: 'supply@texbazaar.demo', paymentTerm: 'net_30', dueDays: 30, creditLimit: 500000 },
  { code: 'SUP-RNT-002', name: 'AV Equipment Trade', supplierType: 'wholesaler', contact: 'Mohan AV', phone: '9900003002', email: 'supply@avtrade.demo', paymentTerm: 'net_15', dueDays: 15, creditLimit: 300000 },
  { code: 'SUP-RNT-003', name: 'EventFurni Depot', supplierType: 'wholesaler', contact: 'Mira Events', phone: '9900003003', email: 'supply@eventfurni.demo', paymentTerm: 'net_30', dueDays: 30, creditLimit: 200000 },
  { code: 'SUP-RNT-004', name: 'Sports Assets India', supplierType: 'wholesaler', contact: 'Arun Sports', phone: '9900003004', email: 'supply@sportsassets.demo', paymentTerm: 'immediate', dueDays: 0, creditLimit: 100000 },
  { code: 'SUP-RNT-005', name: 'Electronics Depot Direct', supplierType: 'distributor', contact: 'Bharat Elec', phone: '9900003005', email: 'supply@elecdepot.demo', paymentTerm: 'net_30', dueDays: 30, creditLimit: 400000 },
];
