// Every control the API accepts must be documented where people look.
//
// This exists because six of them were not. A run of edits anchored on a string
// an earlier edit had already rewritten, and String.replace returns the input
// unchanged when it does not match — so each one silently did nothing while
// reporting success. _retry_after, _malformed, _cors, _scenario, _select and
// _start all shipped working and undocumented.
//
// RESERVED_PARAMS is the source of truth, so adding a control now fails this
// check until the landing page and the OpenAPI spec mention it.

import { readFileSync } from "node:fs";
import { RESERVED_PARAMS } from "../src/config/constants.js";

// Not user-facing controls: internal to a request, or documented as part of
// another parameter rather than on their own.
const INTERNAL = new Set(["_scenario_reset", "select"]);

const targets = [
  ["public/index.html", "the landing page"],
  ["src/handlers/openapi.js", "the OpenAPI spec"],
];

let failed = 0;

for (const [file, label] of targets) {
  const text = readFileSync(file, "utf8");
  const missing = [...RESERVED_PARAMS].filter((p) => !INTERNAL.has(p) && !text.includes(p));
  if (missing.length) {
    failed++;
    console.error(`✗ ${label} does not mention: ${missing.join(", ")}`);
  }
}

const controls = [...RESERVED_PARAMS].filter((p) => !INTERNAL.has(p)).length;
console.log(`${controls} controls documented in ${targets.length - failed}/${targets.length} places`);
if (failed) process.exit(1);
