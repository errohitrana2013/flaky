// The per-day table's pager, run for real in a DOM stub.
//
// `node --check` proves dashboard.js parses and check:render proves it renders
// once; neither notices that the second page shows the wrong rows, that the bar
// scale shifts between pages, or that the totals underneath start describing the
// page instead of the window. This executes public/dashboard.js the way a
// browser does — top-level first, then the handlers it registered.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const TOKEN_JS = readFileSync("public/token.js", "utf8");
const SOURCE = readFileSync("public/dashboard.js", "utf8");

// Same shape as scripts/check-render.mjs, which already runs this file, plus
// handler capture so a click can be fired at the pager.
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
    fire: (key, ...args) => handlers.get(key)?.(...args),
    render: (data) => vm.runInContext("render(__DATA__)", Object.assign(sandbox, { __DATA__: data })),
  };
}

// Requests climb with the day, so the busiest day is always the newest one —
// which makes a bar scale that resets per page obvious.
const payload = (dayCount) => {
  const daily = Array.from({ length: dayCount }, (_, i) => ({
    day: new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10),
    requests: 100 + i,
    errors: i,
    // UTC, as the API sends it; the page converts to the reader's zone.
    peakHour: (i * 3) % 24,
    peakRequests: 10 + i,
  }));
  return {
    window: { from: daily[0].day, to: daily.at(-1).day, days: dayCount },
    totals: {
      requests: daily.reduce((n, d) => n + d.requests, 0),
      errors: daily.reduce((n, d) => n + d.errors, 0),
      errorRate: 0.2, serverErrors: 0, clientErrors: 0,
      keysIssued: 0, countries: 1, addresses: 3, bots: 2,
    },
    daily,
    visitors: daily.map((d) => ({ day: d.day, visitors: 5 })),
    topKeys: [],
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, requests: 1, errors: 0 })),
    hourlyVisitors: Array.from({ length: 24 }, (_, hour) => ({ hour, visitors: 1 })),
    countries: [{ country: "IN", requests: 10, visitors: 2, bots: 1 }],
    regions: [],
    errors: [],
    errorTotals: { kinds: 0, total: 0, requested: 0, server: 0, client: 0, bots: 0 },
  };
};

const rowCount = (html) => html.split("<tr").length - 1;

test("the per-day table pages at fifteen rows and opens on the newest", () => {
  const { el, render } = load();
  render(payload(40));

  // 40 days is three pages; the newest ten are the ones worth opening on.
  assert.equal(rowCount(el("daily").innerHTML), 10);
  assert.match(el("daily").innerHTML, /2026-07-01/, "the last day is on the first screen");
  assert.equal(el("daily-pager").hidden, false);
  assert.match(el("daily-pager").innerHTML, /31–40 of 40 days/);

  // The bar scale comes from the busiest day in the window, not on the page: day
  // 31 has 130 requests against a peak of 139.
  assert.match(el("daily").innerHTML, /data-w="93\.5"/);

  // Weekday comes off the UTC date, so it cannot disagree with the date beside it.
  assert.match(el("daily").innerHTML, /<td class="wk[^"]*">(Mon|Tue|Wed|Thu|Fri|Sat|Sun)</);
  // Peak hour is shown in the reader's zone as the hour it covers, with the UTC
  // hour kept in the title. Matched loosely because the test machine's zone
  // decides the digits.
  assert.match(el("daily").innerHTML, /\d\d:\d\d–\d\d:\d\d/);
  assert.match(el("daily").innerHTML, /busiest hour · \d\d:00 UTC · \d+ requests/);

  // And the totals underneath describe the window, never the page.
  assert.match(el("daily-total").innerHTML, /days <b[^>]*>40</);
});

test("paging back shows the older rows, and stops at the ends", () => {
  const page = load();
  page.render(payload(40));

  const older = { target: { closest: () => ({ dataset: { daily: "older" }, disabled: false }) } };
  const newer = { target: { closest: () => ({ dataset: { daily: "newer" }, disabled: false }) } };

  page.fire("daily-pager:click", older);
  assert.equal(rowCount(page.el("daily").innerHTML), 15);
  assert.match(page.el("daily-pager").innerHTML, /16–30 of 40 days/);

  page.fire("daily-pager:click", older);
  assert.match(page.el("daily-pager").innerHTML, /1–15 of 40 days/);
  assert.match(page.el("daily-pager").innerHTML, /data-daily="older" disabled/);

  // Already at the oldest page: another click must not walk off the end.
  page.fire("daily-pager:click", older);
  assert.match(page.el("daily-pager").innerHTML, /1–15 of 40 days/);

  page.fire("daily-pager:click", newer);
  assert.match(page.el("daily-pager").innerHTML, /16–30 of 40 days/);

  // A click that missed the buttons is ignored rather than throwing.
  page.fire("daily-pager:click", { target: { closest: () => null } });
  assert.match(page.el("daily-pager").innerHTML, /16–30 of 40 days/);
});

test("fifteen days or fewer shows no pager at all", () => {
  const { el, render } = load();
  render(payload(15));

  assert.equal(rowCount(el("daily").innerHTML), 15, "every day is on one page");
  assert.equal(el("daily-pager").hidden, true, "a control that can only do nothing is noise");
  // Any fifteen consecutive days contain a weekend, whatever the dates are, and
  // "the quiet days are Saturdays" is the reason the column exists.
  assert.match(el("daily").innerHTML, /class="wk wkend"/);
  assert.match(el("daily-total").innerHTML, /days <b[^>]*>15</);
});
