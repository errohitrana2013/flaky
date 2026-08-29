// The base dataset is bundled into the Worker — a list request is an array
// slice, not a database read.
//
// Each collection is stored as a JSON string and parsed on first access, then
// memoised. That keeps cold starts proportional to what a request actually
// touches: /v1/posts parses ~25 KB instead of the full 346 KB, and photos —
// two thirds of the dataset, and rarely asked for — is never parsed at all
// unless someone wants photos.

import { RAW, COUNTS } from "./db.js";

const parsed = new Map();

export const DATA = {};
for (const name of Object.keys(RAW)) {
  Object.defineProperty(DATA, name, {
    enumerable: true, // so Object.keys works without forcing a parse
    get() {
      if (!parsed.has(name)) parsed.set(name, JSON.parse(RAW[name]));
      return parsed.get(name);
    },
  });
}

export const RESOURCES = Object.keys(RAW);
export { COUNTS };
