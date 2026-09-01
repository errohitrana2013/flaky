// Runs the admin pages' render functions against real API data, in a DOM stub.
//
// This exists because `node --check` proved insufficient: a file can parse and
// still throw the moment it runs, and the page renders blank either way. The
// syntax check catches a typo; this catches a missing element, a renamed field,
// or a function called before it is defined.
//
//   ADMIN=<token> node scripts/check-render.mjs [base-url]

import { readFileSync } from "node:fs";
import vm from "node:vm";

const BASE = process.argv[2] || "https://flakyapi.dev";
const TOKEN = process.env.ADMIN;
if (!TOKEN) {
  console.error("ADMIN=<token> required — this checks the token-gated pages");
  process.exit(2);
}

// A DOM thin enough to be obvious and thick enough to run the renderers. Every
// element records what was written to it, so the assertions below can check that
// something actually arrived rather than that nothing threw.
function makeDom() {
  const made = new Map();
  const el = (id) => ({
    id,
    _html: "",
    _text: "",
    hidden: false,
    dataset: {},
    style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    addEventListener() {},
    querySelectorAll: () => [],
    remove() {},
    click() {},
  });
  // Any id the page asks for exists. Maintaining a list by hand meant a missing
  // entry looked exactly like a real bug, which cost more time than it saved.
  const get = (id) => {
    if (!made.has(id)) made.set(id, el(id));
    return made.get(id);
  };
  return {
    made,
    document: {
      getElementById: get,
      querySelectorAll: () => [],
      createElement: () => el("created"),
      addEventListener() {},
      body: { appendChild() {} },
      visibilityState: "visible",
    },
  };
}

async function check(page, script, endpoint, assertions) {
  const res = await fetch(`${BASE}${endpoint}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`${endpoint} returned ${res.status}`);
  const data = await res.json();

  const { document, made } = makeDom();
  const errors = [];
  const sandbox = {
    document,
    console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => data, headers: { get: () => null } }),
    location: { pathname: "/", origin: BASE, reload() {} },
    URL: { createObjectURL: () => "blob:", revokeObjectURL() {} },
    Intl,
    Date,
    Math,
    navigator: { sendBeacon: () => true },
    addEventListener() {},
    performance,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  try {
    // token.js first — the page loads it before its own script.
    vm.runInContext(readFileSync("public/token.js", "utf8"), sandbox);
    vm.runInContext(readFileSync(script, "utf8"), sandbox);
    vm.runInContext("render(__DATA__)", Object.assign(sandbox, { __DATA__: data }));
  } catch (err) {
    errors.push(`${page}: threw while rendering — ${err.message}`);
  }

  for (const [id, expect] of Object.entries(assertions)) {
    const node = made.get(id);
    const written = (node?._html || "") + (node?._text || "");
    if (!written.trim()) errors.push(`${page}: #${id} was never written to`);
    else if (expect && !expect.test(written)) errors.push(`${page}: #${id} looks wrong — "${written.slice(0, 60)}"`);
  }
  return errors;
}

const problems = [
  ...(await check("dashboard", "public/dashboard.js", "/v1/admin/stats?days=30", {
    "t-req": /\d/, "geo": /<tr/, "geo-total": /countries/, "errors-total": /distinct/, "daily-total": /days/,
  })),
  ...(await check("insights", "public/insights.js", "/v1/admin/insights?days=30", {
    "chaos-share": /%/, "paths": /<tr/, "paths-total": /endpoints/, "frequency-total": /people/,
    "slowest-total": /worst/, "dwell-total": /pages/,
  })),
];

if (problems.length) {
  for (const p of problems) console.error("✗ " + p);
  process.exit(1);
}
console.log("both admin pages render against live data");
