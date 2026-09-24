// Rasterises a card in scripts/ to a PNG, at exactly the size its body declares.
//
//   node scripts/render-card.mjs og-card.html public/og.png
//   node scripts/render-card.mjs scripts/og-card.html public/og.png
//
// Headless Chrome, which is already on this machine — the cards are hand-written
// HTML precisely so that generating them needs nothing installed. The window
// size is passed explicitly because --window-size sets the screenshot canvas,
// not the layout viewport, and a mismatch silently crops instead of failing.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CHROME = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => existsSync(p));

if (!CHROME) {
  console.error("No Chrome or Chromium found. Install one, or add its path to CHROME in this script.");
  process.exit(2);
}

const [card, out] = process.argv.slice(2);
if (!card || !out) {
  console.error("usage: node scripts/render-card.mjs <card.html> <out.png>");
  process.exit(2);
}

// Bare filename or a path — both work. This only took the name and joined it
// onto "scripts", so the tab-completed `scripts/og-card.html` that every shell
// hands you turned into scripts/scripts/og-card.html and failed on a path that
// was never typed. Whichever form exists wins; neither is a clear error rather
// than a confusing one.
const source = [resolve(card), resolve("scripts", card)].find((p) => existsSync(p));
if (!source) {
  console.error(`No such card: ${card}\nLooked in the working directory and in scripts/.`);
  process.exit(1);
}
const html = readFileSync(source, "utf8");

// Read the size out of the card itself, so the two can never disagree.
const width = Number(html.match(/width:\s*(\d+)px/)?.[1]);
const height = Number(html.match(/height:\s*(\d+)px/)?.[1]);
if (!width || !height) {
  console.error(`${card} does not declare a pixel width and height on body.`);
  process.exit(1);
}

mkdirSync(dirname(resolve(out)), { recursive: true });

execFileSync(CHROME, [
  "--headless",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  `--window-size=${width},${height}`,
  `--screenshot=${resolve(out)}`,
  `file://${source}`,
], { stdio: "pipe" });

const { size } = statSync(resolve(out));
console.log(`${out} — ${width}x${height}, ${(size / 1024).toFixed(0)} KB`);
