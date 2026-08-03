/**
 * Removes Postman "Examples" (sidebar 200 / 201 / etc.) from a collection JSON.
 *
 * Usage:
 *   node postman/strip-examples.js
 *   node postman/strip-examples.js path/to/collection.json
 *   node postman/strip-examples.js path/to/in.json path/to/out.json
 */
const fs = require('fs');
const path = require('path');

const inPath = path.resolve(
  process.argv[2] || path.join(__dirname, 'Walit-POS-API.postman_collection.json'),
);
const outPath = path.resolve(
  process.argv[3] || inPath.replace(/\.json$/i, '.clean.json'),
);

function stripExamples(items) {
  if (!Array.isArray(items)) return 0;
  let removed = 0;
  for (const item of items) {
    if (Array.isArray(item.response) && item.response.length) {
      removed += item.response.length;
      delete item.response;
    }
    if (Array.isArray(item.item)) {
      removed += stripExamples(item.item);
    }
  }
  return removed;
}

const raw = fs.readFileSync(inPath, 'utf8');
const collection = JSON.parse(raw);
const removed = stripExamples(collection.item || []);

fs.writeFileSync(outPath, JSON.stringify(collection, null, 2) + '\n', 'utf8');
console.log(`Removed ${removed} example(s)`);
console.log(`Wrote: ${outPath}`);
console.log('→ Postman → Import → File → choose the .clean.json file');
