/**
 * Nest `sourceRoot: src` emits dist/main.js.
 * aaPanel/PM2 on upos.walit.in starts dist/src/main.js — keep a stub so
 * restarts do not MODULE_NOT_FOUND after nest build (deleteOutDir).
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const distMain = path.join(root, "dist", "main.js");
const legacyDir = path.join(root, "dist", "src");
const legacyMain = path.join(legacyDir, "main.js");

if (!fs.existsSync(distMain) && !fs.existsSync(legacyMain)) {
  console.error(
    "nest build did not emit dist/main.js or dist/src/main.js. Run npm run build.",
  );
  process.exit(1);
}

if (fs.existsSync(distMain) && !fs.existsSync(legacyMain)) {
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(legacyMain, "require('../main.js');\n");
  console.log("Wrote dist/src/main.js stub → dist/main.js");
}
