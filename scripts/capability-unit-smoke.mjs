/**
 * Pure unit checks for capability recommendations (no DB).
 * node --experimental-strip-types or transpile — here we duplicate minimal asserts
 * against the compiled/common module via dynamic import of built dist if present.
 */
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadCaps() {
  try {
    return require('../dist/common/capabilities.js');
  } catch {
    try {
      return require('../src/common/capabilities.ts');
    } catch {
      return null;
    }
  }
}

const caps = loadCaps();
if (!caps) {
  console.log(
    'SKIP — build backend first (npm run build) to unit-test capabilities.js',
  );
  process.exit(0);
}

const {
  recommendCapabilities,
  recommendCommerceModes,
  hasCapability,
} = caps;

function assert(c, m) {
  if (!c) throw new Error(m);
}

const retail = recommendCapabilities({
  businessType: 'retail',
  sells: ['products'],
  needs: ['inventory'],
});
assert(hasCapability(retail, 'INVENTORY'), 'retail inventory');
assert(!hasCapability(retail, 'KOT'), 'retail no KOT');

const restaurant = recommendCapabilities({
  businessType: 'restaurant',
  needs: ['tables', 'kitchen'],
});
assert(hasCapability(restaurant, 'TABLE'), 'restaurant table');
assert(hasCapability(restaurant, 'KITCHEN'), 'restaurant kitchen');

const pet = recommendCapabilities({
  businessType: 'pet_grooming',
  sells: ['services', 'products'],
  needs: ['appointments'],
});
assert(hasCapability(pet, 'BOOKING'), 'pet booking');
assert(
  recommendCommerceModes({ sells: ['services', 'products'] }).includes(
    'service',
  ),
  'pet service mode',
);

const repair = recommendCapabilities({
  businessType: 'repair',
  needs: ['repair_jobs'],
});
assert(hasCapability(repair, 'REPAIR_JOB'), 'repair job');
assert(hasCapability(repair, 'ASSET'), 'repair asset');

console.log('OK capability unit recommendations');
console.log('  retail', retail.slice(0, 6).join(','));
console.log('  restaurant', restaurant.slice(0, 8).join(','));
console.log('  pet', pet.slice(0, 8).join(','));
