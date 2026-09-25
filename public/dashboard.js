const $ = (id) => document.getElementById(id);
const num = (n) => Number(n || 0).toLocaleString();

// Every scrollable table gets a line underneath it that does not scroll. Named
// summary, not total: `total` is exactly the variable name a renderer reaches
// for, and shadowing it turns this into a runtime error at render time.
function summary(id, parts) {
  const el = $(id);
  if (el) el.innerHTML = parts.filter(Boolean).join("");
}
const part = (label, value, cls = "") =>
  `<span>${label} <b class="${cls}">${typeof value === "number" ? num(value) : value}</b></span>`;

// Paths come from callers, and callers include scanners posting markup. Nothing
// here is ever assigned as HTML without going through this first. Not truncated:
// a path is the thing you are trying to read, and half of one is a guess.
const strip = (text) => String(text).replace(/[<>&"]/g, "");

async function load(token) {
  const res = await fetch("/v1/admin/stats?days=90", {
    headers: { authorization: "Bearer " + token },
  });
  // The character count is the difference between "I mistyped it" and "this is
  // the other environment's token", which "Token rejected." leaves you to guess
  // at. The server logs the same comparison from its side.
  if (!res.ok) {
    throw new Error(res.status === 401
      ? `Token rejected — sent ${token.length} characters to ${location.host}.`
      : "Request failed: " + res.status);
  }
  return res.json();
}

// CSP blocks inline style attributes, but setting .style through the CSSOM is
// not restricted — so bar sizes are emitted as data attributes and applied
// here. One pass after each render.
function applySizes(root) {
  for (const el of root.querySelectorAll("[data-w]")) el.style.width = el.dataset.w + "%";
  for (const el of root.querySelectorAll("[data-h]")) el.style.height = el.dataset.h + "%";
}

// Every day in the window, in one scrolling panel. This was paged fifteen at a
// time, which answered "how was last fortnight" and refused "when did that
// spike start" — the question a 90-day table exists for. Scrolling keeps every
// day reachable without a control that hides two thirds of them behind a click.
//
// Newest first, so today is the first row and needs no scroll at all. The CSV
// button is unaffected: it has always written the whole window, not the page.
let DAILY = [];
let DAILY_VISITORS = {};
let DAILY_PEAK = 1;

// Which day's errors are open, and what came back for the days already asked
// about. One day at a time: this is a "what happened on the 23rd" question, and
// several open at once turns the table back into the wall of numbers the scroll
// was meant to fix. Cached because the rollup for a past day cannot change.
let DAY_ERRORS_OPEN = null;
const DAY_ERRORS = new Map();

// The same, for what people did that day. Only one detail row is open at a time
// across both kinds — two panels under two days is the wall of numbers again.
let DAY_VISITS_OPEN = null;
const DAY_VISITS = new Map();

function renderDaily() {
  const rows = [...DAILY].reverse();

  $("daily").innerHTML = rows.length
    ? rows.map((d) => `<tr${DAY_ERRORS_OPEN === d.day || DAY_VISITS_OPEN === d.day ? ' class="open"' : ""}>
            <td class="mono">${d.day}</td>
            <td class="wk${isWeekend(d.day) ? " wkend" : ""}">${weekdayOf(d.day)}</td>
            <td class="num">${num(d.requests)}</td>
            <td class="num">${errorCell(d, d.userErrors)}</td>
            <td class="num">${errorCell(d, d.requestedErrors)}</td>
            <td class="num${d.fixErrors ? " warn" : ""}">${errorCell(d, d.fixErrors)}</td>
            <td class="num">${visitorCell(d.day, DAILY_VISITORS[d.day])}</td>
            <td class="mono wk"${d.peakHour == null ? ">—" : ` title="busiest hour · ${hhmm(d.peakHour)} UTC · ${num(d.peakRequests)} requests">${localRange(d.peakHour)}`}</td>
            <td class="chart"><div class="track${(d.fixErrors ?? (d.errors > d.requests * 0.1)) ? " err" : ""}"
              data-w="${((d.requests / DAILY_PEAK) * 100).toFixed(1)}"></div></td>
          </tr>${DAY_ERRORS_OPEN === d.day ? dayErrorRow(d.day) : DAY_VISITS_OPEN === d.day ? dayVisitRow(d.day) : ""}`)
        .join("")
    : '<tr><td colspan="9" class="muted">No traffic yet.</td></tr>';
  applySizes($("daily"));
}

// A count worth opening is a button; a zero is text. A control that can only
// tell you "nothing happened" is the same noise the pager was. All three
// open the same detail, which labels every row with its cause anyway.
// null is a day from before errors were recorded by kind: the total is known,
// the split is not, and a dash says so where a 0 would claim it.
function errorCell(d, count) {
  if (count == null) return `<span class="muted" title="${num(d.errors)} errors, recorded before they were split by kind">—</span>`;
  if (!count) return "0";
  return `<button class="disclose errlink" data-errday="${d.day}"
            aria-expanded="${DAY_ERRORS_OPEN === d.day}"
            title="what failed on ${d.day}">${num(count)}</button>`;
}

// The detail sits in a row of its own under the day, rather than in a panel
// somewhere else on the page: the number you clicked and the answer belong in
// the same place, and scrolling away from the row to read it loses which day
// you were asking about.
function dayErrorRow(day) {
  const data = DAY_ERRORS.get(day);
  if (!data) return detailRow('<span class="muted">Loading…</span>');
  if (data.error) return detailRow(`<span class="warn">${strip(data.error)}</span>`);
  if (!data.errors.length) return detailRow('<span class="muted">Nothing recorded for this day.</span>');

  const body = data.errors.map((e) => `<tr>
      <td><span class="st st-${String(e.status)[0]}">${Number(e.status) || "?"}</span></td>
      <td class="mono">${strip(e.path)}</td>
      <td><span class="cause cause-${cause(e)}">${cause(e)}</span></td>
      <td><span class="cause ${e.bot ? "cause-client" : ""}">${e.bot ? "bot" : "caller"}</span></td>
      <td class="num">${num(e.count)}</td>
    </tr>`).join("");

  const t = data.totals;
  return detailRow(`
    <table class="detail">
      <thead><tr><th>Status</th><th>Path</th><th>Cause</th><th>From</th><th class="num">Count</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="tabletotal">${[
      part("kinds", t.kinds > data.errors.length ? `${num(data.errors.length)} of ${num(t.kinds)}` : num(t.kinds)),
      part("total", num(t.total)),
      part("requested", num(t.requested)),
      part("from bots", num(t.bots)),
      part("server", num(t.server), t.server ? "warn" : ""),
    ].join("")}</div>`);
}

const detailRow = (inner) => `<tr class="daydetail"><td colspan="9">${inner}</td></tr>`;

function visitorCell(day, count) {
  if (!count) return num(count);
  return `<button class="disclose errlink" data-visday="${day}"
            aria-expanded="${DAY_VISITS_OPEN === day}"
            title="what people did on ${day}">${num(count)}</button>`;
}

// 48 → 0:48, 312 → 5:12. Reading time is minutes at most; hours would mean a
// tab left open, which the beacon already caps.
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

// Totals, never people: which pages were read and for how long, which endpoints
// were called and how many of those asked for a failure. The per-person trail
// exists, but the privacy page promises it is only read for people who came
// back, so this panel is built from the tables that were never tied to anyone.
function dayVisitRow(day) {
  const data = DAY_VISITS.get(day);
  if (!data) return detailRow('<span class="muted">Loading…</span>');
  if (data.error) return detailRow(`<span class="warn">${strip(data.error)}</span>`);

  const t = data.totals;
  const pages = data.pages.length
    ? `<table class="detail">
        <thead><tr><th>Page read</th><th class="num">Views</th><th class="num">Avg time</th><th class="num">Longest</th><th class="num">Left in &lt;10s</th></tr></thead>
        <tbody>${data.pages.map((p) => `<tr>
          <td class="mono">${strip(p.path)}</td>
          <td class="num">${num(p.views)}</td>
          <td class="num">${mmss(p.avgSeconds)}</td>
          <td class="num">${mmss(p.maxSeconds)}</td>
          <td class="num">${num(p.bounced)}</td>
        </tr>`).join("")}</tbody>
      </table>`
    : "";

  const api = data.api.length
    ? `<table class="detail">
        <thead><tr><th>API called</th><th class="num">Requests</th><th class="num">Asked to fail</th><th class="num">From the site's try-it box</th></tr></thead>
        <tbody>${data.api.map((a) => `<tr>
          <td class="mono">${strip(a.path)}</td>
          <td class="num">${num(a.requests)}</td>
          <td class="num${a.chaos ? " warn" : ""}">${num(a.chaos)}</td>
          <td class="num">${num(a.fromSite)}</td>
        </tr>`).join("")}</tbody>
      </table>`
    : "";

  if (!pages && !api) return detailRow('<span class="muted">Nothing recorded for this day beyond the visitor count.</span>');

  const from = data.referrers.length
    ? `<div class="tabletotal">arrived from ${data.referrers.map((r) => `${strip(r.referrer)} <b>${num(r.requests)}</b>`).join(" · ")}</div>`
    : "";

  return detailRow(`${pages}${api}
    <div class="tabletotal">${[
      part("page views", num(t.views)),
      part("time reading", mmss(t.readingSeconds)),
      part("API requests", num(t.apiRequests)),
      part("asked to fail", num(t.chaosRequests), t.chaosRequests ? "warn" : ""),
      part("from the try-it box", num(t.fromSite)),
    ].join("")}</div>${from}
    <div class="tabletotal muted">Bots left out. Reading time comes from the page telling us when it is closed, so visitors who only called the API have none.</div>`);
}

// The same shape as toggleDayErrors, and it closes the other panel when it opens.
async function toggleDayVisits(day) {
  if (DAY_VISITS_OPEN === day) { DAY_VISITS_OPEN = null; renderDaily(); return; }

  DAY_VISITS_OPEN = day;
  DAY_ERRORS_OPEN = null;
  if (DAY_VISITS.has(day) && day !== DAILY.at(-1)?.day) { renderDaily(); return; }

  renderDaily();
  try {
    const res = await fetch(`/v1/admin/visits?day=${encodeURIComponent(day)}`, {
      headers: { authorization: "Bearer " + authToken },
    });
    if (!res.ok) throw new Error("Request failed: " + res.status);
    DAY_VISITS.set(day, await res.json());
  } catch (err) {
    DAY_VISITS.set(day, { error: err.message });
  }
  if (DAY_VISITS_OPEN === day) renderDaily();
}

// Fetch once per day, then toggle from the cache. A day's rollup is finished
// except for today's, and re-reading it on every open would cost a round trip
// to answer the same question.
async function toggleDayErrors(day) {
  if (DAY_ERRORS_OPEN === day) { DAY_ERRORS_OPEN = null; renderDaily(); return; }

  DAY_ERRORS_OPEN = day;
  DAY_VISITS_OPEN = null;
  // Today is still being written to, so never serve it from the cache.
  if (DAY_ERRORS.has(day) && day !== DAILY.at(-1)?.day) { renderDaily(); return; }

  renderDaily(); // shows "Loading…" while the request is in flight
  try {
    const res = await fetch(`/v1/admin/errors?day=${encodeURIComponent(day)}`, {
      headers: { authorization: "Bearer " + authToken },
    });
    if (!res.ok) throw new Error("Request failed: " + res.status);
    DAY_ERRORS.set(day, await res.json());
  } catch (err) {
    // Into the row, not over the dashboard: one day's detail failing must not
    // blank the table behind it.
    DAY_ERRORS.set(day, { error: err.message });
  }
  if (DAY_ERRORS_OPEN === day) renderDaily();
}

function render(data) {
  $("t-req").textContent = num(data.totals.requests);
  $("t-err").textContent = (data.totals.errorRate * 100).toFixed(1) + "%";
  $("t-real").textContent = num(data.totals.serverErrors);
  $("t-key").textContent = num(data.totals.keysIssued);
  $("t-ip").textContent = num(data.totals.addresses);
  $("t-bot").textContent = num(data.totals.bots);

  const visitorsByDay = Object.fromEntries(data.visitors.map((v) => [v.day, v.visitors]));
  // Distinct people, from the server. Summing the per-day counts here counted
  // anyone who came back once per day they came back, so the tile read 215
  // against 169 actual people and the gap to Addresses — a distinct count —
  // compared two different quantities.
  $("t-vis").textContent = num(data.totals.people);

  DAILY = data.daily;
  DAILY_VISITORS = visitorsByDay;
  // Peak over every day in the window, so the bars stay comparable the whole
  // way down the scroll rather than rescaling to whatever is on screen.
  DAILY_PEAK = Math.max(1, ...data.daily.map((d) => d.requests || 0));
  renderDaily();

  // Totals over the whole window, never the page on screen. Summing what is
  // visible is exactly how the error table came to report "requested 0".
  summary("daily-total", [
    part("days", data.daily.length),
    part("requests", data.totals.requests),
    part("user errors", data.totals.userErrors ?? 0),
    part("built-in errors", data.totals.requestedErrors ?? 0),
    part("need fixing", data.totals.fixErrors ?? 0, data.totals.fixErrors ? "warn" : ""),
    ...(data.totals.unsplitErrors ? [part("not split", data.totals.unsplitErrors)] : []),
    part("error rate", (data.totals.errorRate * 100).toFixed(1) + "%"),
  ]);
  LATEST = data;
  renderHours(data.hourly, data.hourlyVisitors, MODE);
  renderErrors(data.errors || [], data.errorTotals || {}, data.window?.days);
  renderGeo(data.countries || [], data.regions || []);
  syncGeoAll();

  summary("keys-total", [
    part("keys with traffic", data.topKeys.length),
    part("requests from keys", data.topKeys.reduce((n, k) => n + k.requests, 0)),
  ]);

  $("keys").innerHTML = data.topKeys.length
    ? data.topKeys.map((k) => `<tr><td class="mono">${k.key_id}</td><td class="num">${num(k.requests)}</td></tr>`).join("")
    : '<tr><td colspan="2" class="muted">No keyed traffic yet.</td></tr>';

  $("gate").hidden = true;
  $("panel").hidden = false;
}

// The API stores hours in UTC. "When should I ship" is a local-time question,
// so shift into the viewer's zone here. India and friends sit on a half-hour
// offset, hence the fractional maths rather than a plain integer rotate.
let LATEST = null;
let MODE = "people";

// Hours arrive in UTC. "When is it busy" is a local-time question, and India and
// friends sit on a half-hour offset, so these carry fractions rather than
// rotating whole hours. Shared by the histogram and the per-day peak column,
// which must not drift apart.
const hourOffset = () => -new Date().getTimezoneOffset() / 60;
const hhmm = (v) => {
  const hh = Math.floor(v);
  return `${String(hh).padStart(2, "0")}:${String(Math.round((v - hh) * 60)).padStart(2, "0")}`;
};
const localHour = (utcHour) => (((utcHour + hourOffset()) % 24) + 24) % 24;
// 17:00 UTC reads as 22:30–23:30 in IST.
const localRange = (utcHour) => `${hhmm(localHour(utcHour))}–${hhmm(localHour(utcHour + 1))}`;

// From the UTC date, because the rows are UTC days: a local weekday would
// disagree with the date printed beside it for half the world.
const asUtcDate = (day) => new Date(day + "T00:00:00Z");
const weekdayOf = (day) => asUtcDate(day).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
const isWeekend = (day) => [0, 6].includes(asUtcDate(day).getUTCDay());

function renderHours(hourly, visitors, mode) {
  const offset = hourOffset();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("tz").textContent = zone ? `· ${zone}` : "· local time";

  // Two different questions: requests can be dominated by one busy script,
  // while arrivals say when people actually turn up.
  const byHour = Object.fromEntries((visitors || []).map((v) => [v.hour, v.visitors]));
  const buckets = hourly
    .map((b) => ({
      hour: b.hour,
      errors: b.errors,
      value: mode === "people" ? (byHour[b.hour] || 0) : b.requests,
      local: (((b.hour + offset) % 24) + 24) % 24,
    }))
    .sort((a, b) => a.local - b.local);

  const unit = mode === "people" ? "people" : "requests";
  const peak = Math.max(...buckets.map((b) => b.value));

  $("hours").innerHTML = buckets
    .map((b, i) => {
      const height = peak ? Math.max((b.value / peak) * 100, 1.5) : 1.5;
      // Every third label only; 24 of them overlap on a phone.
      return `<div class="hour${b.value === peak && peak > 0 ? " peak" : ""}"
                   title="${hhmm(b.local)}–${hhmm((b.local + 1) % 24)} · ${num(b.value)} ${unit}">
        <div class="col" data-h="${height.toFixed(1)}"></div>
        <div class="lab${i % 3 ? " hide" : ""}">${hhmm(b.local).slice(0, 2)}</div>
      </div>`;
    })
    .join("");
  applySizes($("hours"));
}

// Codes come from Cloudflare, but they round-trip through the database, so
// validate the shape before building a flag or trusting it in markup.
const REGION = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
})();

const isCode = (code) => /^[A-Za-z]{2}$/.test(code || "");

function countryName(code) {
  if (!isCode(code) || code.toUpperCase() === "XX") return "Unknown";
  try { return REGION?.of(code.toUpperCase()) || code.toUpperCase(); } catch { return code.toUpperCase(); }
}

function flag(code) {
  if (!isCode(code) || code.toUpperCase() === "XX") return "🌐";
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// Three causes, not two. "real" was doing too much work: it sat on a 404 for a
// mistyped path, which is the API answering correctly, and on a 500 that would
// mean something is broken. Only the second is worth reacting to.
function cause(e) {
  if (e.injected) return "requested";
  return e.status >= 500 ? "server" : "client";
}

// Only unrequested 5xx — the server sends nothing else. An empty list is the
// good outcome and says so in words, because a blank table reads as a failed
// load rather than as "nothing is broken".
function renderErrors(errors, totals, days) {
  // The totals come from the server, over every error, never from these rows.
  // Everything that is not a server error is still counted here, so the panel
  // cannot be read as "no errors at all".
  const footer = () => summary("errors-total", [
    part("need fixing", num(totals.server || 0), totals.server ? "warn" : ""),
    part("everything else", num((totals.total || 0) - (totals.server || 0))),
    part("of which requested", num(totals.requested || 0)),
    part("from bots", num(totals.bots || 0)),
  ]);

  if (!errors.length) {
    $("errors").innerHTML = `<tr><td colspan="6" class="muted">Nothing broken in ${num(days || 0)} days.</td></tr>`;
    footer();
    return;
  }

  const peak = Math.max(...errors.map((e) => e.count));
  $("errors").innerHTML = errors
    .map((e) => `<tr class="real">
        <td><span class="st st-${String(e.status)[0]}">${Number(e.status) || "?"}</span></td>
        <td class="mono">${strip(e.path)}</td>
        <td><span class="cause ${e.bot ? "cause-client" : ""}">${e.bot ? "bot" : "caller"}</span></td>
        <td class="num">${num(e.count)}</td>
        <td class="mono wk" title="first seen ${strip(e.firstDay || "")}">${strip(e.lastDay || "")}</td>
        <td class="chart"><div class="track sev" data-w="${((e.count / peak) * 100).toFixed(1)}"></div></td>
      </tr>`)
    .join("");
  applySizes($("errors"));
  footer();
}

// ISO 3166-1 alpha-2 -> continent. Byte-identical to CONTINENT_GROUPS in
// src/lib/geo.js, which the CSV export uses — the Worker and the browser share
// no module, and tests/dashboard-geography.test.mjs fails if the two drift.
const CONTINENT_GROUPS = {
  Africa: "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
  Asia: "AE AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
  Europe: "AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK",
  "North America": "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI",
  "South America": "AR BO BR CL CO EC FK GF GY PE PY SR UY VE",
  Oceania: "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS",
  Antarctica: "AQ BV GS HM TF",
};
const CONTINENT_BY_CODE = (() => {
  const map = {};
  for (const [name, codes] of Object.entries(CONTINENT_GROUPS)) {
    for (const code of codes.split(" ")) map[code] = name;
  }
  return map;
})();
const continentOf = (code) => (isCode(code) && CONTINENT_BY_CODE[code.toUpperCase()]) || "Unknown";

// Which continents and countries are showing what is inside them. Continents
// open, countries shut: that is the shape of the question the table answers
// first — where in the world, and which country — and forty state rows spread
// through it buries the twenty-seven country rows that are the actual answer.
//
// Keys are prefixed because a continent and a country can never collide, but a
// two-letter code and a continent name sharing a set otherwise could.
const GEO_KEY = { continent: (name) => "c:" + name, country: (code) => "n:" + code };
let GEO_OPEN = null;

// Continent, country and state in one table.
//
// Two tables meant reading a country's total in one and its states in another,
// with nothing tying them together — and the numbers looked like they
// disagreed, because the state list counts people while the country row counts
// people, bots and requests. They were never the same quantity. Nesting them
// says so.
//
// The two feeds cover different sets: countries is the top 25 by requests,
// states the top 40 by visitors, so each has entries the other lacks. Both are
// kept.
function renderGeo(countries, regions) {
  if (!countries.length && !regions.length) {
    $("geo").innerHTML = '<tr><td colspan="6" class="muted">No regions recorded yet.</td></tr>';
    summary("geo-total", [part("countries", 0)]);
    return;
  }

  const byCountry = new Map();
  const seed = (code) => {
    const key = isCode(code) ? code.toUpperCase() : "XX";
    if (!byCountry.has(key)) {
      byCountry.set(key, { country: key, visitors: 0, bots: 0, requests: null, addresses: 0, states: [] });
    }
    return byCountry.get(key);
  };
  for (const c of countries) {
    const row = seed(c.country);
    row.visitors = c.visitors || 0;
    row.bots = c.bots || 0;
    row.requests = c.requests || 0;
  }
  for (const r of regions) {
    seed(r.country).states.push(r);
  }

  for (const row of byCountry.values()) {
    row.states.sort((a, b) => (b.visitors || 0) - (a.visitors || 0));
    row.addresses = row.states.reduce((n, s) => n + (s.addresses || 0), 0);
    const seen = (field) => row.states.reduce((n, s) => n + (s[field] || 0), 0);
    // A country outside the top 25 by requests has no country row at all — its
    // states are everything known about it, and requests stay blank rather than
    // become a zero that reads as "nobody called".
    if (row.requests === null) {
      row.visitors = seen("visitors");
      row.bots = seen("bots");
    }
    // The state list stops at 40, so a country's own people can outnumber the
    // states listed under it. Naming the remainder beats a column that quietly
    // does not add up — and only where there are states to fall short of.
    row.restPeople = row.states.length ? Math.max(0, row.visitors - seen("visitors")) : 0;
    row.restBots = row.states.length ? Math.max(0, row.bots - seen("bots")) : 0;
  }

  const continents = new Map();
  for (const row of byCountry.values()) {
    const name = continentOf(row.country);
    if (!continents.has(name)) {
      continents.set(name, { name, countries: [], visitors: 0, bots: 0, requests: 0, addresses: 0 });
    }
    const group = continents.get(name);
    group.countries.push(row);
    group.visitors += row.visitors;
    group.bots += row.bots;
    group.requests += row.requests || 0;
    group.addresses += row.addresses;
  }
  const ordered = [...continents.values()].sort((a, b) => b.requests - a.requests || b.visitors - a.visitors);
  for (const group of ordered) {
    group.countries.sort((a, b) => (b.requests || 0) - (a.requests || 0) || b.visitors - a.visitors);
  }

  // Seeded once, then left alone: re-seeding on every render would spring open
  // everything the reader had just shut, and the table re-renders on every
  // click of a disclosure. It starts shut — one row per continent, each with
  // its totals — the same state Collapse all leaves it in. Opening on sixty-odd
  // country rows put the one thing worth reading first, the continent totals,
  // half a scroll apart.
  if (GEO_OPEN === null) GEO_OPEN = new Set();

  // Scaled to the busiest country, not the busiest continent: the bar is there
  // to compare countries, and a continent that is one country would otherwise
  // pin the scale and flatten everything below it.
  const peak = Math.max(1, ...[...byCountry.values()].map((c) => c.requests || 0));
  const cell = (value) => `<td class="num">${value === null ? '<span class="muted">—</span>' : num(value)}</td>`;
  const safe = (text) => String(text).replace(/[<>&"]/g, "").slice(0, 40);

  // A row that opens something is a button, not a clickable cell: the keyboard
  // and a screen reader both need to know it does something, and aria-expanded
  // is the only way to say which way it is currently pointing.
  const disclose = (key, open, inner) =>
    `<button class="disclose" type="button" data-geo="${key}" aria-expanded="${open}">
       <span class="tri" aria-hidden="true">${open ? "▾" : "▸"}</span>${inner}
     </button>`;

  const rows = [];
  for (const group of ordered) {
    const groupKey = GEO_KEY.continent(group.name);
    const groupOpen = GEO_OPEN.has(groupKey);
    const label = `${safe(group.name)} <span class="code">${group.countries.length}</span>`;
    rows.push(`<tr class="lvl-continent${groupOpen ? "" : " shut"}">
        <td>${disclose(groupKey, groupOpen, label)}</td>
        ${cell(group.visitors)}${cell(group.bots)}${cell(group.requests)}${cell(group.addresses)}
        <td class="chart"></td>
      </tr>`);
    if (!groupOpen) continue;

    for (const c of group.countries) {
      const countryKey = GEO_KEY.country(c.country);
      // A country with nothing underneath gets no control. A disclosure that
      // opens onto nothing is worse than none: it reads as data still loading.
      const hasStates = c.states.length > 0 || c.restPeople > 0 || c.restBots > 0;
      const countryOpen = hasStates && GEO_OPEN.has(countryKey);
      const label = `<span class="flag">${flag(c.country)}</span>${countryName(c.country)}
              <span class="code">${isCode(c.country) ? c.country : ""}</span>`;
      rows.push(`<tr class="lvl-country${hasStates && !countryOpen ? " shut" : ""}">
          <td>${hasStates ? disclose(countryKey, countryOpen, label) : `<span class="leaf">${label}</span>`}</td>
          ${cell(c.visitors)}${cell(c.bots)}${cell(c.requests)}${cell(c.addresses)}
          <td class="chart"><div class="track" data-w="${(((c.requests || 0) / peak) * 100).toFixed(1)}"></div></td>
        </tr>`);
      if (!countryOpen) continue;

      for (const s of c.states) {
        rows.push(`<tr class="lvl-state">
            <td>${safe(s.region)}</td>
            ${cell(s.visitors || 0)}${cell(s.bots || 0)}${cell(null)}${cell(s.addresses || 0)}
            <td class="chart"></td>
          </tr>`);
      }
      if (c.restPeople || c.restBots) {
        rows.push(`<tr class="lvl-state">
            <td>Elsewhere in ${countryName(c.country)}</td>
            ${cell(c.restPeople)}${cell(c.restBots)}${cell(null)}${cell(null)}
            <td class="chart"></td>
          </tr>`);
      }
    }
  }
  $("geo").innerHTML = rows.join("");
  applySizes($("geo"));

  // Counted over the countries map, not the countries feed: states carry
  // countries the feed never listed, and they are on screen.
  const all = [...byCountry.values()];
  summary("geo-total", [
    part("continents", ordered.length),
    part("countries", all.length),
    part("states", regions.length),
    part("people", all.reduce((n, c) => n + c.visitors, 0)),
    part("bots", all.reduce((n, c) => n + c.bots, 0)),
    part("requests", all.reduce((n, c) => n + (c.requests || 0), 0)),
  ]);
}

// Held in memory only, for the export requests. It still needs the admin
// header, so the download cannot be a plain link.
let authToken = null;

async function attempt(token) {
  $("error").hidden = true;
  try {
    render(await load(token));
    authToken = token;
    saveToken(token);
    // Separately, and after: this table is a curiosity and the dashboard is
    // not. A failure here must not blank the page behind it.
    loadCustoms().catch(() => {
      $("customs").innerHTML = '<tr><td colspan="6" class="muted">Could not load custom APIs.</td></tr>';
    });
  } catch (err) {
    authToken = null;
    clearToken();
    $("error").textContent = err.message;
    $("error").hidden = false;
  }
}

// --- Custom APIs -------------------------------------------------------------
//
// What people are actually pasting into /custom, while it is still there. The
// bodies are other people's documents, so nothing here goes through innerHTML:
// resource names come from their JSON, and the JSON itself is written with
// textContent into a <pre>.

// Strips rather than escapes, the same way the errors table treats paths. These
// strings arrive from a stranger's JSON keys and are never trusted as markup.
const plain = (s) => String(s ?? "").replace(/[<>&"]/g, "").slice(0, 60);

function untilLabel(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return "expired";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const shortTime = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function loadCustoms() {
  const res = await fetch("/v1/admin/custom", { headers: { authorization: "Bearer " + authToken } });
  if (!res.ok) throw new Error("Request failed: " + res.status);
  renderCustoms(await res.json());
}

function renderCustoms(data) {
  const apis = data.apis || [];
  summary("customs-total", [
    part("someone's own JSON", apis.length),
    part("records", apis.reduce((n, a) => n + a.resources.reduce((r, x) => r + x.count, 0), 0)),
    part("stored", (apis.reduce((n, a) => n + a.bytes, 0) / 1024).toFixed(1) + " KB"),
    // Said out loud. A table that quietly drops rows is worse than one that
    // shows noise, because the count stops meaning what it appears to mean.
    data.samplesHidden ? part("example pastes hidden", data.samplesHidden) : "",
  ]);

  if (!apis.length) {
    const nothing = data.samplesHidden
      ? `Nothing but the example — ${num(data.samplesHidden)} of those, hidden.`
      : "Nothing live. Each lasts the 1 to 9 days it was made for.";
    $("customs").innerHTML = `<tr><td colspan="6" class="muted">${nothing}</td></tr>`;
    return;
  }

  $("customs").innerHTML = apis
    .map((a) => {
      const where = a.region ? `${plain(a.region)}, ${plain(a.countryName)}` : plain(a.countryName);
      const shapes = a.resources.length
        ? a.resources.map((r) => `${plain(r.name)} <b>${num(r.count)}</b>`).join(" · ")
        : '<span class="muted">not recorded</span>';
      return `<tr>
        <td>${shortTime(a.createdAt)}</td>
        <td>${untilLabel(a.expiresAt)}</td>
        <td>${flag(a.country)} ${where}</td>
        <td class="mono">${shapes}</td>
        <td class="num">${(a.bytes / 1024).toFixed(1)} KB</td>
        <td><button class="linkbtn" type="button" data-json="${plain(a.id)}">view</button></td>
      </tr>`;
    })
    .join("");
}

// One listener on the table body rather than one per row, so it survives every
// re-render without being rewired.
$("customs").addEventListener("click", async (event) => {
  const id = event.target?.dataset?.json;
  if (!id) return;

  $("json-title").textContent = `Loading ${id}…`;
  $("json-body").textContent = "";
  $("json-panel").hidden = false;

  try {
    const res = await fetch(`/v1/admin/custom/${id}`, { headers: { authorization: "Bearer " + authToken } });
    if (!res.ok) throw new Error("Request failed: " + res.status);
    const data = await res.json();
    const where = data.region ? `${data.region}, ${data.countryName}` : data.countryName;
    $("json-title").textContent = `${id} · ${where} · ${(data.bytes / 1024).toFixed(1)} KB · expires ${shortTime(data.expiresAt)}`;
    // textContent, never innerHTML. This is a stranger's document.
    $("json-body").textContent = JSON.stringify(data.body, null, 2);
  } catch (err) {
    $("json-title").textContent = "Could not load it";
    $("json-body").textContent = err.message;
  }
  $("json-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

$("json-close").addEventListener("click", () => { $("json-panel").hidden = true; });

// The export window is deliberately wider than the dashboard's 14 days —
// someone downloading a spreadsheet is looking for a trend, not today.
async function downloadCsv(button) {
  const dataset = button.dataset.csv;
  button.disabled = true;
  try {
    const res = await fetch(`/v1/admin/export?dataset=${dataset}&days=90`, {
      headers: { authorization: "Bearer " + authToken },
    });
    if (!res.ok) throw new Error("Export failed: " + res.status);

    // Prefer the filename the server chose, so the date in it is the server's.
    const disposition = res.headers.get("content-disposition") || "";
    const named = disposition.match(/filename="([^"]+)"/);

    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement("a"), {
      href: url,
      download: named ? named[1] : `flaky-${dataset}.csv`,
    });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    $("error").textContent = err.message;
    $("error").hidden = false;
  } finally {
    button.disabled = false;
  }
}

function setMode(mode) {
  MODE = mode;
  $("m-people").classList.toggle("on", mode === "people");
  $("m-req").classList.toggle("on", mode === "requests");
  if (LATEST) renderHours(LATEST.hourly, LATEST.hourlyVisitors, mode);
}
// Delegated, because the rows are rebuilt on every toggle and the CSP rules out
// an inline handler on them.
// Delegated for the same reason as the geo table below: the rows are rebuilt on
// every open and close, so a handler bound to a button would not survive the
// first click, and the CSP rules out an inline one.
$("daily").addEventListener("click", (event) => {
  const button = event.target.closest("[data-errday]");
  if (button) return toggleDayErrors(button.dataset.errday);
  const visits = event.target.closest("[data-visday]");
  if (visits) toggleDayVisits(visits.dataset.visday);
});

$("geo").addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-geo]");
  if (!button || !LATEST) return;
  const key = button.dataset.geo;
  if (GEO_OPEN.has(key)) GEO_OPEN.delete(key); else GEO_OPEN.add(key);
  renderGeo(LATEST.countries || [], LATEST.regions || []);
  syncGeoAll();
});

// One control for the whole table. "Expand all" while anything is shut, so the
// button always offers the move that is not already made — a button whose label
// describes the current state instead of the next one gets clicked by mistake
// every time.
function geoKeys() {
  if (!LATEST) return [];
  const keys = new Set();
  for (const c of LATEST.countries || []) {
    keys.add(GEO_KEY.continent(continentOf(c.country)));
    keys.add(GEO_KEY.country(isCode(c.country) ? c.country.toUpperCase() : "XX"));
  }
  for (const r of LATEST.regions || []) {
    keys.add(GEO_KEY.continent(continentOf(r.country)));
    keys.add(GEO_KEY.country(isCode(r.country) ? r.country.toUpperCase() : "XX"));
  }
  return [...keys];
}

function syncGeoAll() {
  const keys = geoKeys();
  const shut = keys.some((key) => !GEO_OPEN?.has(key));
  $("geo-all").textContent = shut ? "expand all" : "collapse all";
  $("geo-all").dataset.open = shut ? "" : "1";
}

$("geo-all").addEventListener("click", () => {
  if (!LATEST) return;
  const keys = geoKeys();
  // Collapse all shuts the continents too, so it is the reverse of expand all:
  // one row per continent, each still carrying its totals. It used to keep the
  // continents open, which left every country on screen and looked like the
  // button had done nothing.
  GEO_OPEN = keys.some((key) => !GEO_OPEN.has(key)) ? new Set(keys) : new Set();
  renderGeo(LATEST.countries || [], LATEST.regions || []);
  syncGeoAll();
});

$("m-people").addEventListener("click", () => setMode("people"));
$("m-req").addEventListener("click", () => setMode("requests"));

for (const button of document.querySelectorAll(".csv")) {
  button.addEventListener("click", () => downloadCsv(button));
}

$("go").addEventListener("click", () => attempt($("token").value.trim()));
$("token").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });

wireSessionControls(() => location.reload());

const saved = loadToken();
if (saved) attempt(saved);
