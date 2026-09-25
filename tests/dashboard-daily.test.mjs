// The per-day table, run for real in a DOM stub.
//
// `node --check` proves dashboard.js parses and check:render proves it renders
// once; neither notices that the table quietly stopped at fifteen rows, that the
// newest day is at the bottom where nobody looks, that the bar scale is drawn
// from the wrong peak, or that the totals underneath describe the rows on screen
// instead of the window. This executes public/dashboard.js the way a browser
// does — top-level first, then the handlers it registered.
//
// This file used to cover a pager. The table scrolls now: ninety days is the
// retention window and every one of them has to be reachable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const TOKEN_JS = readFileSync("public/token.js", "utf8");
const SOURCE = readFileSync("public/dashboard.js", "utf8");

// Same shape as scripts/check-render.mjs, which already runs this file, plus
// handler capture so a click can be fired at a delegated listener.
function load(onFetch) {
  const nodes = new Map();
  const handlers = new Map();
  const fetched = [];

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
    fetch: async (url) => {
      fetched.push(url);
      return onFetch
        ? onFetch(url)
        : { ok: true, json: async () => ({}), headers: { get: () => null } };
    },
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
    fetched,
    fire: (key, ...args) => handlers.get(key)?.(...args),
    // The delegated handlers take a real-looking event; only closest() matters.
    clickOn: (key, attr, value) =>
      handlers.get(key)?.({ target: { closest: (sel) => (sel === `[${attr}]` ? { dataset: { [attr.replace(/^data-/, "")]: value } } : null) } }),
    render: (data) => vm.runInContext("render(__DATA__)", Object.assign(sandbox, { __DATA__: data })),
  };
}

// Requests climb with the day, so the busiest day is always the newest one —
// which makes a bar scale drawn from anything but the whole window obvious.
const payload = (dayCount) => {
  const daily = Array.from({ length: dayCount }, (_, i) => ({
    day: new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString().slice(0, 10),
    requests: 100 + i,
    errors: i,
    // Every third error asked for, one a broken 5xx on every fifth day, the rest
    // the caller's; the first days predate the split, the way 2026-08-29 does in
    // production.
    userErrors: i < 3 ? null : i - Math.floor(i / 3) - (i % 5 === 0 ? 1 : 0),
    requestedErrors: i < 3 ? null : Math.floor(i / 3),
    fixErrors: i < 3 ? null : (i % 5 === 0 ? 1 : 0),
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
      userErrors: 500, requestedErrors: 200, fixErrors: 7, unsplitErrors: 3,
      keysIssued: 0, countries: 1, addresses: 3, bots: 2,
      // Deliberately unequal to the sum of the per-day counts below, which is
      // the bug this figure exists to keep fixed: 5 people a day for 40 days is
      // 200 visits and nothing like 200 people.
      people: 7,
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

test("every day in the window is rendered, newest first", () => {
  const { el, render } = load();
  render(payload(90));

  const html = el("daily").innerHTML;
  // Ninety days is ninety rows. Nothing is behind a control any more, which is
  // the whole point: a spike seventy days back has to be findable.
  assert.equal(rowCount(html), 90, "the full retention window, not a page of it");

  // Newest at the top, so today needs no scroll. Day 90 is 2026-08-29 and day 1
  // is 2026-06-01; the newest date must appear before the oldest in the markup.
  assert.ok(html.indexOf("2026-08-29") < html.indexOf("2026-06-01"), "today is the first row");
  assert.match(html, /2026-06-01/, "and the oldest day is still there to scroll to");
});

test("the bar scale is the window's peak, at both ends of the scroll", () => {
  const { el, render } = load();
  render(payload(40));

  const html = el("daily").innerHTML;
  // The busiest day is the newest — 139 requests — so its bar is full width.
  assert.match(html, /data-w="100\.0"/);
  // And the oldest day, 100 requests, is drawn against that same 139 rather
  // than against whatever happens to be nearby. 100/139 = 71.9%.
  assert.match(html, /data-w="71\.9"/);
});

test("the day column and peak hour survive the reordering", () => {
  const { el, render } = load();
  render(payload(15));

  const html = el("daily").innerHTML;
  // Weekday comes off the UTC date, so it cannot disagree with the date beside it.
  assert.match(html, /<td class="wk[^"]*">(Mon|Tue|Wed|Thu|Fri|Sat|Sun)</);
  // Any fifteen consecutive days contain a weekend, whatever the dates are, and
  // "the quiet days are Saturdays" is the reason the column exists.
  assert.match(html, /class="wk wkend"/);
  // Peak hour is shown in the reader's zone as the hour it covers, with the UTC
  // hour kept in the title. Matched loosely because the test machine's zone
  // decides the digits.
  assert.match(html, /\d\d:\d\d–\d\d:\d\d/);
  assert.match(html, /busiest hour · \d\d:00 UTC · \d+ requests/);
});

test("the totals describe the window, not the rows on screen", () => {
  const { el, render } = load();
  render(payload(40));

  assert.match(el("daily-total").innerHTML, /days <b[^>]*>40</);
});

// --- Opening one day's errors ----------------------------------------------

const DAY_DETAIL = {
  day: "2026-06-10",
  errors: [
    { status: 401, path: "/v1/admin/stats", injected: 0, bot: 1, count: 3 },
    { status: 503, path: "/v1/posts", injected: 1, bot: 0, count: 2 },
    { status: 500, path: "/v1/custom", injected: 0, bot: 0, count: 1 },
  ],
  totals: { kinds: 3, total: 6, requested: 2, server: 1, bots: 3 },
};

const detailFetch = (url) =>
  url.includes("/v1/admin/errors")
    ? { ok: true, json: async () => DAY_DETAIL, headers: { get: () => null } }
    : { ok: true, json: async () => ({}), headers: { get: () => null } };

test("a day with errors offers them, a day without does not", () => {
  const { el, render } = load();
  render(payload(40));

  const html = el("daily").innerHTML;
  // The payload gives day i exactly i errors, so the oldest day has none.
  assert.match(html, /data-errday="2026-07-10"/, "a count worth reading is a control");
  const oldest = html.slice(html.indexOf("2026-06-01"));
  assert.ok(!oldest.includes("data-errday"), "a zero is text, not a button that can do nothing");
});

test("errors are split into user, built-in and need fixing, and an unknown split is a dash", () => {
  const { el, render } = load();
  render(payload(40));

  const html = el("daily").innerHTML;
  // Day 9 (2026-06-10) has 9 errors: 6 the caller's, 3 asked for, none broken.
  const row = html.slice(html.indexOf("2026-06-10"), html.indexOf("</tr>", html.indexOf("2026-06-10")));
  const counts = [...row.matchAll(/data-errday="2026-06-10"[^>]*>(\d+)</g)].map((m) => m[1]);
  assert.deepEqual(counts, ["6", "3"], "user, then built-in; a zero is not a button");
  assert.ok(!row.includes('class="num warn"'), "nothing to fix, nothing highlighted");
  assert.ok(!row.includes("track err"));

  // Day 10 (2026-06-11) has one unrequested 5xx: flagged, and its bar is red.
  const broken = html.slice(html.indexOf("2026-06-11"), html.indexOf("</tr>", html.indexOf("2026-06-11")));
  assert.match(broken, /<td class="num warn"><button[^>]*>1</);
  assert.match(broken, /track err/);

  // Day 2 predates the split: its 2 errors are known, their kind is not.
  const early = html.slice(html.indexOf("2026-06-03"), html.indexOf("</tr>", html.indexOf("2026-06-03")));
  assert.equal((early.match(/>—</g) || []).length, 3);
  assert.ok(!early.includes(">0<"), "an unknown split is not a zero");

  const total = el("daily-total").innerHTML;
  assert.match(total, /user errors <b[^>]*>500</);
  assert.match(total, /built-in errors <b[^>]*>200</);
  assert.match(total, /need fixing <b class="warn">7</);
  assert.match(total, /not split <b[^>]*>3</);
});

test("opening a day fetches that day and shows what failed", async () => {
  const page = load(detailFetch);
  page.render(payload(40));

  page.clickOn("daily:click", "data-errday", "2026-06-10");
  await new Promise((r) => setTimeout(r, 0));

  const asked = page.fetched.filter((u) => u.includes("/v1/admin/errors"));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /day=2026-06-10/, "the day clicked, not the window");

  const html = page.el("daily").innerHTML;
  assert.match(html, /\/v1\/admin\/stats/);
  // A 503 the caller asked for is the product working. Labelling it "requested"
  // beside a real 500 is the only reason this panel is worth opening.
  assert.match(html, /cause-requested/);
  assert.match(html, /cause-server/);
  assert.match(html, /requested <b[^>]*>2</);
  assert.match(html, /server <b[^>]*>1</);
});

test("clicking the same day again closes it, and asks nothing twice", async () => {
  const page = load(detailFetch);
  page.render(payload(40));

  page.clickOn("daily:click", "data-errday", "2026-06-10");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(page.el("daily").innerHTML, /daydetail/);

  page.clickOn("daily:click", "data-errday", "2026-06-10");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!page.el("daily").innerHTML.includes("daydetail"), "a second click closes it");

  // Re-opening a finished day reads the cache: the rollup cannot have changed.
  page.clickOn("daily:click", "data-errday", "2026-06-10");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(page.fetched.filter((u) => u.includes("/v1/admin/errors")).length, 1);
});

test("a day whose detail fails says so in the row, and keeps the table", async () => {
  const page = load((url) =>
    url.includes("/v1/admin/errors")
      ? { ok: false, status: 500, json: async () => ({}), headers: { get: () => null } }
      : { ok: true, json: async () => ({}), headers: { get: () => null } });
  page.render(payload(40));

  page.clickOn("daily:click", "data-errday", "2026-06-10");
  await new Promise((r) => setTimeout(r, 0));

  const html = page.el("daily").innerHTML;
  assert.match(html, /Request failed: 500/);
  // The 90 days behind it must still be there — one day's detail failing is not
  // a reason to blank the table.
  assert.match(html, /2026-07-10/);
  assert.match(html, /2026-06-01/);
});

test("the People tile is distinct people, not a sum of the daily counts", () => {
  const { el, render } = load();
  render(payload(40));

  // The server counts each visitor once over the window. Summing the per-day
  // column here counted anyone who came back once per day they came back, and
  // put 200 beside an Addresses figure that was distinct — two quantities that
  // were never comparable, in the one place on the page that invites comparing
  // them.
  assert.equal(el("t-vis").textContent, "7");
  assert.equal(el("t-ip").textContent, "3");
});

// --- Opening what people did on a day ----------------------------------------

const VISITS = {
  day: "2026-06-10",
  pages: [{ path: "/createMockServer", views: 3, avgSeconds: 176, maxSeconds: 521, bounced: 2 }],
  api: [{ path: "/v1/posts", requests: 30, chaos: 21, fromSite: 1 }],
  referrers: [{ referrer: "bing.com", requests: 1 }],
  totals: { pages: 1, views: 3, readingSeconds: 527, bounced: 2, endpoints: 1, apiRequests: 30, chaosRequests: 21, fromSite: 1 },
};

const bothFetch = (url) =>
  url.includes("/v1/admin/visits") ? { ok: true, json: async () => VISITS, headers: { get: () => null } }
  : url.includes("/v1/admin/errors") ? { ok: true, json: async () => DAY_DETAIL, headers: { get: () => null } }
  : { ok: true, json: async () => ({}), headers: { get: () => null } };

test("a day's visitor count opens what they did, as totals", async () => {
  const page = load(bothFetch);
  page.render(payload(40));
  assert.match(page.el("daily").innerHTML, /data-visday="2026-06-10"/, "the count is a control");

  page.clickOn("daily:click", "data-visday", "2026-06-10");
  await new Promise((r) => setTimeout(r, 0));

  assert.match(page.fetched.find((u) => u.includes("/v1/admin/visits")), /day=2026-06-10/);
  const html = page.el("daily").innerHTML;
  assert.match(html, /\/createMockServer/);
  assert.match(html, /2:56/, "176 seconds read as minutes");
  assert.match(html, /\/v1\/posts/);
  assert.match(html, /asked to fail <b class="warn">21</);
  assert.match(html, /bing\.com/);
});

test("only one day's detail is open, whichever kind it is", async () => {
  const page = load(bothFetch);
  page.render(payload(40));

  page.clickOn("daily:click", "data-errday", "2026-06-10");
  await new Promise((r) => setTimeout(r, 0));
  page.clickOn("daily:click", "data-visday", "2026-06-10");
  await new Promise((r) => setTimeout(r, 0));

  const html = page.el("daily").innerHTML;
  assert.equal(html.split("daydetail").length - 1, 1, "the errors closed when the visits opened");
  assert.match(html, /Page read/);
  assert.ok(!html.includes("cause-requested"));
});

// --- Needs fixing ---------------------------------------------------------------

test("needs fixing says nothing is broken in words, and still counts everything else", () => {
  const { el, render } = load();
  const data = payload(40);
  data.errors = [];
  data.errorTotals = { kinds: 12, total: 900, requested: 40, server: 0, client: 860, bots: 700 };
  render(data);

  assert.match(el("errors").innerHTML, /Nothing broken in 40 days/, "empty is the good outcome, said as one");
  const total = el("errors-total").innerHTML;
  assert.match(total, /need fixing <b[^>]*>0</);
  assert.match(total, /everything else <b[^>]*>900</, "the rest is still counted, so it cannot read as no errors at all");
});

test("needs fixing lists a server error with when it was last seen", () => {
  const { el, render } = load();
  const data = payload(40);
  data.errors = [{ status: 500, path: "/v1/scenario", bot: 1, count: 2, firstDay: "2026-09-03", lastDay: "2026-09-03" }];
  data.errorTotals = { kinds: 1, total: 2, requested: 0, server: 2, client: 0, bots: 2 };
  render(data);

  const html = el("errors").innerHTML;
  assert.match(html, /\/v1\/scenario/);
  assert.match(html, />2026-09-03</);
  assert.match(el("errors-total").innerHTML, /need fixing <b class="warn">2</);
});
