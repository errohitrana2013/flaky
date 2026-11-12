// Stamps every CSS and JS reference in public/**/*.html with a hash of the
// file's contents: /app.css becomes /app.css?v=1a2b3c4d.
//
// The CSS and JS were served max-age=0, must-revalidate, so every repeat visit
// re-asked for about seven files. They can only be cached for a long time if a
// changed file gets a new URL, otherwise a visitor keeps last month's
// stylesheet against this month's HTML. The query string is that new URL: the
// asset server ignores it, browsers and the edge cache key on it. public/_headers
// then marks *.css and *.js immutable for a year. HTML stays max-age=0, so the
// stamps themselves are always fresh.
//
//   node scripts/stamp-assets.mjs           rewrite the stamps
//   node scripts/stamp-assets.mjs --check   fail if any is stale (npm test)
//
// Run it after touching any file in public/ that ends in .css or .js — the
// check will say so if you forget.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "public";
const REF = /(href|src)="\/([A-Za-z0-9_-]+\.(?:css|js))(?:\?v=[0-9a-f]*)?"/g;

const htmlFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : []);

const hashes = new Map();
const hashOf = (name) => {
  if (!hashes.has(name)) {
    hashes.set(name, createHash("sha256").update(readFileSync(join(ROOT, name))).digest("hex").slice(0, 8));
  }
  return hashes.get(name);
};

const check = process.argv.includes("--check");
const stale = [];
let refs = 0;

for (const file of htmlFiles(ROOT)) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(REF, (_, attr, name) => {
    refs++;
    return `${attr}="/${name}?v=${hashOf(name)}"`;
  });
  if (after === before) continue;
  if (check) stale.push(file);
  else writeFileSync(file, after);
}

if (check && stale.length) {
  console.error(`✗ stale asset stamps in ${stale.join(", ")} — run: node scripts/stamp-assets.mjs`);
  process.exit(1);
}
console.log(`${refs} asset references ${check ? "stamped correctly" : "stamped"}`);
