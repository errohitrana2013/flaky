// The base dataset is a plain module, bundled into the Worker at build time.
// No database read on the hot path: a list request is an array slice.
//
// It is a .js file rather than .json so the same import works unchanged in the
// Node test runner and in the Workers bundler, without import attributes.

import db from "./db.js";

export const DATA = db;
export const RESOURCES = Object.keys(db);
export const COUNTS = Object.fromEntries(RESOURCES.map((name) => [name, db[name].length]));
