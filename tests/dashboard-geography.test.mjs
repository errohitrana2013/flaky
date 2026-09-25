// The combined geography table, run for real in a DOM stub.
//
// The table merges two feeds that count different things — countries carries
// people, bots and requests, states carries people and bots only — and covers
// two different top-N cutoffs. Every bug worth having here is an arithmetic one
// that still renders: a country whose states do not add up to it, a state whose
// country missed the requests cutoff and vanished with it, or a continent total
// that quietly drops either.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { CONTINENT_GROUPS, continentOf } from "../src/lib/geo.js";

const TOKEN_JS = readFileSync("public/token.js", "utf8");
const SOURCE = readFileSync("public/dashboard.js", "utf8");

// Same stub as tests/dashboard-paging.test.mjs and scripts/check-render.mjs.
function load() {
  const nodes = new Map();
  const handlers = new Map();
  const element = (id) => ({
    id,
    value: "",
    hidden: false,
    dataset: {},
    style: {},
    disabled: false,
    _html: "",
    _text: "",
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    addEventListener(event, fn) { handlers.set(`${id}:${event}`, fn); },
    querySelectorAll: () => [],
    remove() {},
    click() {},
  });
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };
  const sandbox = {
    document: {
      getElementById: el,
      querySelectorAll: () => [],
      createElement: () => element("created"),
      addEventListener() {},
      body: { appendChild() {} },
      visibilityState: "visible",
    },
    console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}), headers: { get: () => null } }),
    location: { pathname: "/dashboard", origin: "https://flakyapi.dev", reload() {} },
    URL: { createObjectURL: () => "blob:", revokeObjectURL() {} },
    Intl, Date, Math, JSON,
    navigator: { sendBeacon: () => true },
    addEventListener() {},
    performance,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TOKEN_JS, sandbox);
  vm.runInContext(SOURCE, sandbox);
  return {
    el,
    render: (data) => vm.runInContext("render(__DATA__)", Object.assign(sandbox, { __DATA__: data })),
    // The page delegates from the tbody, so a click is an event whose target
    // resolves to the row's button — the same thing .closest() finds in a
    // browser.
    open: (key) => handlers.get("geo:click")({ target: { closest: () => ({ dataset: { geo: key } }) } }),
    openAll: () => handlers.get("geo-all:click")(),
    // The table starts at continents only. Tests about the country rows open
    // every continent first, the way a reader clicking each one would.
    openContinents() {
      const shut = [...nodes.get("geo")._html.matchAll(/data-geo="(c:[^"]+)" aria-expanded="false"/g)].map((m) => m[1]);
      for (const key of shut) handlers.get("geo:click")({ target: { closest: () => ({ dataset: { geo: key } }) } });
    },
  };
}

// Shaped after a real window: India's states add up exactly, the Netherlands
// falls two people short of its own total, Romania is all bots and has no
// states, and Slovenia has a state but missed the top 25 by requests entirely.
const payload = () => ({
  window: { from: "2026-08-01", to: "2026-09-14", days: 14 },
  totals: {
    requests: 7136, errors: 0, errorRate: 0, serverErrors: 0, clientErrors: 0,
    keysIssued: 0, countries: 4, addresses: 291, bots: 225,
  },
  daily: [], visitors: [], topKeys: [],
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 1, errors: 0 })),
  hourlyVisitors: Array.from({ length: 24 }, (_, hour) => ({ hour, visitors: 1 })),
  countries: [
    { country: "IN", requests: 3612, visitors: 42, bots: 5 },
    { country: "NL", requests: 1059, visitors: 26, bots: 55 },
    { country: "US", requests: 397, visitors: 137, bots: 31 },
    { country: "RO", requests: 127, visitors: 0, bots: 5 },
  ],
  regions: [
    { country: "IN", region: "Karnataka", visitors: 36, bots: 4, addresses: 19 },
    { country: "IN", region: "Delhi", visitors: 6, bots: 1, addresses: 2 },
    { country: "NL", region: "North Holland", visitors: 17, bots: 30, addresses: 16 },
    { country: "NL", region: "South Holland", visitors: 7, bots: 5, addresses: 4 },
    { country: "US", region: "Texas", visitors: 137, bots: 31, addresses: 29 },
    { country: "SI", region: "Ljubljana", visitors: 2, bots: 0, addresses: 1 },
  ],
  errors: [],
  errorTotals: { kinds: 0, total: 0, requested: 0, server: 0, client: 0, bots: 0 },
});

const rowsOf = (html) =>
  html.split("<tr").slice(1).map((row) => ({
    level: (row.match(/class="lvl-(\w+)/) || [])[1],
    shut: /class="lvl-\w+ shut"/.test(row),
    label: (row.match(/>([^<>]*?)\s*<\/td>/) || [])[1] || row.replace(/<[^>]*>/g, " ").trim().split(/\s{2,}/)[0],
    // Strips the tags so a blank cell reads as its em dash, not as "".
    nums: [...row.matchAll(/<td class="num">(.*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]*>/g, "")),
    text: row,
  }));

test("it opens on continents only, each with its totals", () => {
  const { el, render, openContinents } = load();
  render(payload());
  const rows = rowsOf(el("geo").innerHTML);

  // The same state Collapse all leaves it in, on a first visit and on a refresh.
  assert.ok(rows.length > 0 && rows.every((r) => r.level === "continent"), "nothing but continents");
  assert.match(el("geo").innerHTML, /data-geo="c:Asia" aria-expanded="false"/);
  assert.equal(el("geo-all").textContent, "expand all", "the button offers the move not yet made");

  // Opening a continent shows its countries, states still put away. A country
  // with states offers to open; Romania, which has none, does not.
  openContinents();
  const open = rowsOf(el("geo").innerHTML);
  assert.ok(open.some((r) => r.level === "country"));
  assert.equal(open.filter((r) => r.level === "state").length, 0, "states stay put away");
  assert.match(el("geo").innerHTML, /data-geo="n:IN" aria-expanded="false"/);
  assert.doesNotMatch(el("geo").innerHTML, /data-geo="n:RO"/);
});

test("every level nests under the one above it, in that order", () => {
  const { el, render, open, openContinents } = load();
  render(payload());
  openContinents();
  open("n:IN");
  open("n:NL");
  const levels = rowsOf(el("geo").innerHTML).map((r) => r.level);

  // A state may never precede the country it belongs to, and a country may
  // never precede its continent.
  assert.equal(levels[0], "continent");
  let seenCountry = false;
  for (const level of levels) {
    if (level === "country") seenCountry = true;
    if (level === "state") assert.ok(seenCountry, "a state appeared before any country");
  }
  assert.ok(levels.includes("state"), "states are on the table");
});

test("opening a country shows its states and nothing else's", () => {
  const { el, render, open, openContinents } = load();
  render(payload());
  openContinents();
  open("n:IN");
  const rows = rowsOf(el("geo").innerHTML);

  const states = rows.filter((r) => r.level === "state");
  assert.deepEqual(states.map((r) => r.label), ["Karnataka", "Delhi"]);
  // The Netherlands stayed shut, and says so.
  assert.match(el("geo").innerHTML, /data-geo="n:NL" aria-expanded="false"/);
});

test("shutting a continent takes its countries and their states with it", () => {
  const { el, render, open, openContinents } = load();
  render(payload());
  openContinents();
  open("n:IN");
  assert.ok(rowsOf(el("geo").innerHTML).some((r) => r.label === "Karnataka"));

  open("c:Asia");
  const html = el("geo").innerHTML;
  assert.doesNotMatch(html, /India/, "the country went with the continent");
  assert.doesNotMatch(html, /Karnataka/, "so did its states");
  // The continent row itself stays, still carrying its totals.
  const asia = rowsOf(html).find((r) => /c:Asia/.test(r.text));
  assert.ok(asia && asia.shut);
  assert.deepEqual(asia.nums.slice(0, 3), ["42", "5", "3,612"]);
});

test("a shut country keeps its own numbers", () => {
  const { el, render, openContinents } = load();
  render(payload());
  openContinents();
  // The whole point of collapsing: the row still answers the question. India is
  // 42 people whether or not its four states are on screen.
  const india = rowsOf(el("geo").innerHTML).find((r) => /n:IN/.test(r.text));
  assert.deepEqual(india.nums, ["42", "5", "3,612", "21"]);
});

test("expand all opens everything, and collapse all shuts every continent", () => {
  const { el, render, openAll } = load();
  render(payload());
  assert.equal(el("geo-all").textContent, "expand all");

  openAll();
  const opened = rowsOf(el("geo").innerHTML);
  assert.equal(opened.filter((r) => r.level === "state").length, 7,
    "six states, plus the one remainder row the Netherlands earns");
  assert.equal(el("geo-all").textContent, "collapse all");

  openAll();
  const shut = rowsOf(el("geo").innerHTML);
  assert.equal(shut.filter((r) => r.level === "state").length, 0);
  assert.equal(shut.filter((r) => r.level === "country").length, 0, "the continents shut too");
  // Never an empty table: each continent keeps its row and its totals.
  assert.ok(shut.filter((r) => r.level === "continent").length > 0, "continent rows stay");
  assert.equal(el("geo-all").textContent, "expand all");

  // And expand all brings every level back from there.
  openAll();
  assert.equal(rowsOf(el("geo").innerHTML).filter((r) => r.level === "state").length, 7);
});

test("the summary describes the window, not what is currently open", () => {
  const { el, render, open, openAll } = load();
  render(payload());
  const shut = el("geo-total").innerHTML;
  openAll();
  const wide = el("geo-total").innerHTML;
  open("c:Asia");
  assert.equal(el("geo-total").innerHTML, wide);
  assert.equal(shut, wide);
  assert.match(shut, /states <b[^>]*>6</);
});

test("a continent row is the sum of the countries under it", () => {
  const { el, render } = load();
  render(payload());
  const rows = rowsOf(el("geo").innerHTML);

  // Asia is India alone; Europe is the Netherlands, Romania and Slovenia.
  const europe = rows.find((r) => r.level === "continent" && /Europe/.test(r.text));
  assert.ok(europe, "Europe is on the table");
  // people 26 + 0 + 2, bots 55 + 5 + 0, requests 1,059 + 127 + nothing for SI.
  assert.deepEqual(europe.nums.slice(0, 3), ["28", "60", "1,186"]);
});

test("a country whose states fall short of it says where the rest went", () => {
  const { el, render, open, openContinents } = load();
  render(payload());
  openContinents();
  open("n:NL");
  open("n:IN");
  const html = el("geo").innerHTML;

  // The Netherlands has 26 people and lists 24, so two are unaccounted for —
  // and 55 bots against 35 listed leaves 20.
  const rest = rowsOf(html).find((r) => /Elsewhere in Netherlands/.test(r.text));
  assert.ok(rest, "the remainder is named");
  assert.deepEqual(rest.nums.slice(0, 2), ["2", "20"]);

  // India adds up exactly, so it gets no such row.
  assert.doesNotMatch(html, /Elsewhere in India/);
  // Romania has no states at all — the country row is already the whole story,
  // and it gets no control that would open onto nothing.
  assert.doesNotMatch(html, /Elsewhere in Romania/);
  assert.match(html, /<span class="leaf">[^]*?Romania/);
});

test("a country that missed the requests cutoff still appears, without a requests figure", () => {
  const { el, render, openContinents } = load();
  render(payload());
  openContinents();
  const rows = rowsOf(el("geo").innerHTML);

  const slovenia = rows.find((r) => r.level === "country" && /Slovenia/.test(r.text));
  assert.ok(slovenia, "a country known only from its states is not dropped");
  // Its people and bots come from its one state; requests are unknown, not zero.
  assert.equal(slovenia.nums[0], "2");
  assert.match(slovenia.nums[2], /—/, "requests are blank, not a zero");
});

test("requests are never claimed at state level", () => {
  const { el, render, openAll } = load();
  render(payload());
  openAll();
  for (const row of rowsOf(el("geo").innerHTML).filter((r) => r.level === "state")) {
    assert.match(row.nums[2], /—/, `${row.label} claims a request count`);
  }
});

test("the bar scale comes from the busiest country, not the busiest continent", () => {
  const { el, render, openContinents } = load();
  render(payload());
  openContinents();
  const html = el("geo").innerHTML;
  // India is the peak at 3,612; the Netherlands is 1,059 of it.
  assert.match(html, /data-w="100\.0"/);
  assert.match(html, /data-w="29\.3"/);
  // Continent rows carry no bar — they would compete with the countries inside.
  for (const row of rowsOf(html).filter((r) => r.level === "continent")) {
    assert.doesNotMatch(row.text, /data-w=/);
  }
});

test("the summary counts the countries on screen, including those only states knew about", () => {
  const { el, render } = load();
  render(payload());
  const total = el("geo-total").innerHTML;
  assert.match(total, /countries <b[^>]*>5</, "four from the feed plus Slovenia");
  assert.match(total, /continents <b[^>]*>3</);
  assert.match(total, /states <b[^>]*>6</);
  // 42 + 26 + 137 + 0 + 2.
  assert.match(total, /people <b[^>]*>207</);
});

test("an empty window renders a message rather than an empty table", () => {
  const { el, render } = load();
  render({ ...payload(), countries: [], regions: [] });
  assert.match(el("geo").innerHTML, /No regions recorded/);
});

test("the browser's continent table and the Worker's are the same table", () => {
  // The CSV export derives the continent in the Worker and the page derives it
  // in the browser, from two copies of the same list. A row filed under
  // different continents in the table and the download is the bug this catches.
  const inBrowser = SOURCE.slice(SOURCE.indexOf("const CONTINENT_GROUPS = {"));
  const worker = readFileSync("src/lib/geo.js", "utf8");
  for (const [name, codes] of Object.entries(CONTINENT_GROUPS)) {
    const key = name.includes(" ") ? `"${name}"` : name;
    assert.ok(inBrowser.includes(`${key}: "${codes}"`), `${name} differs between the two copies`);
  }
  assert.equal(
    (inBrowser.match(/^\s{2}"?[A-Z][\w ]*"?: "/gm) || []).length,
    Object.keys(CONTINENT_GROUPS).length,
    "the browser copy has a continent the Worker does not",
  );
  assert.ok(worker.includes("export const continentOf"));
});

test("no country code is filed under two continents, and unknowns stay unknown", () => {
  const seen = new Map();
  for (const [name, codes] of Object.entries(CONTINENT_GROUPS)) {
    for (const code of codes.split(" ")) {
      assert.match(code, /^[A-Z]{2}$/, `${code} is not a country code`);
      assert.ok(!seen.has(code), `${code} is in both ${seen.get(code)} and ${name}`);
      seen.set(code, name);
    }
  }
  assert.equal(continentOf("XX"), "Unknown");
  assert.equal(continentOf(""), "Unknown");
  assert.equal(continentOf("ZZ"), "Unknown");
  // Namibia is NA, which is also how North America is abbreviated. Filing it in
  // the wrong hemisphere is the obvious way to write this table wrong.
  assert.equal(continentOf("NA"), "Africa");
  assert.equal(continentOf("us"), "North America");
});
