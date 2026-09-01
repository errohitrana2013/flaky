// Parses every browser script the site serves.
//
// This exists because a syntax error in public/insights.js shipped: the unit
// tests exercise the Worker, and the e2e checks HTTP status codes, so a file
// that returns 200 and does not parse passed both while the page rendered
// blank. Nothing was checking the half of the codebase that runs in a browser.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = "public";
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", join(dir, file)], { stdio: "pipe" });
  } catch (err) {
    failed++;
    console.error(`✗ ${file}\n${(err.stderr || "").toString().split("\n").slice(0, 4).join("\n")}`);
  }
}

console.log(`${files.length - failed}/${files.length} browser scripts parse`);
if (failed) process.exit(1);
