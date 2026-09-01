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

async function load(token) {
  const res = await fetch("/v1/admin/stats?days=14", {
    headers: { authorization: "Bearer " + token },
  });
  if (!res.ok) throw new Error(res.status === 401 ? "Token rejected." : "Request failed: " + res.status);
  return res.json();
}

// CSP blocks inline style attributes, but setting .style through the CSSOM is
// not restricted — so bar sizes are emitted as data attributes and applied
// here. One pass after each render.
function applySizes(root) {
  for (const el of root.querySelectorAll("[data-w]")) el.style.width = el.dataset.w + "%";
  for (const el of root.querySelectorAll("[data-h]")) el.style.height = el.dataset.h + "%";
}

function render(data) {
  $("t-req").textContent = num(data.totals.requests);
  $("t-err").textContent = (data.totals.errorRate * 100).toFixed(1) + "%";
  $("t-real").textContent = num(data.totals.serverErrors);
  $("t-key").textContent = num(data.totals.keysIssued);
  $("t-ip").textContent = num(data.totals.addresses);
  $("t-bot").textContent = num(data.totals.bots);

  const visitorsByDay = Object.fromEntries(data.visitors.map((v) => [v.day, v.visitors]));
  $("t-vis").textContent = num(data.visitors.reduce((s, v) => s + v.visitors, 0));

  const peak = Math.max(1, ...data.daily.map((d) => d.requests || 0));
  $("daily").innerHTML = data.daily.length
    ? data.daily
        .map((d) => `<tr>
            <td class="mono">${d.day}</td>
            <td class="num">${num(d.requests)}</td>
            <td class="num">${num(d.errors)}</td>
            <td class="num">${num(visitorsByDay[d.day])}</td>
            <td class="chart"><div class="track${d.errors > d.requests * 0.1 ? " err" : ""}"
              data-w="${((d.requests / peak) * 100).toFixed(1)}"></div></td>
          </tr>`)
        .join("")
    : '<tr><td colspan="5" class="muted">No traffic yet.</td></tr>';

  applySizes($("daily"));
  summary("daily-total", [
    part("days", data.daily.length),
    part("requests", data.totals.requests),
    part("errors", data.totals.errors),
    part("error rate", (data.totals.errorRate * 100).toFixed(1) + "%"),
  ]);
  LATEST = data;
  renderHours(data.hourly, data.hourlyVisitors, MODE);
  renderErrors(data.errors || []);
  renderGeo(data.countries);
  renderRegions(data.regions || []);

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

function renderHours(hourly, visitors, mode) {
  const offset = -new Date().getTimezoneOffset() / 60;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("tz").textContent = zone ? `· ${zone}` : "· local time";

  const label = (v) => {
    const hh = Math.floor(v);
    return `${String(hh).padStart(2, "0")}:${String(Math.round((v - hh) * 60)).padStart(2, "0")}`;
  };

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
                   title="${label(b.local)}–${label((b.local + 1) % 24)} · ${num(b.value)} ${unit}">
        <div class="col" data-h="${height.toFixed(1)}"></div>
        <div class="lab${i % 3 ? " hide" : ""}">${label(b.local).slice(0, 2)}</div>
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

function renderErrors(errors) {
  if (!errors.length) {
    $("errors").innerHTML = '<tr><td colspan="6" class="muted">No errors recorded.</td></tr>';
    return;
  }
  const peak = Math.max(...errors.map((e) => e.count));
  $("errors").innerHTML = errors
    .map((e) => `<tr class="${cause(e) === "server" ? "real" : ""}">
        <td><span class="st st-${String(e.status)[0]}">${Number(e.status) || "?"}</span></td>
        <td class="mono">${String(e.path).replace(/[<>&"]/g, "")}</td>
        <td><span class="cause cause-${cause(e)}">${cause(e)}</span></td>
        <td><span class="cause ${e.bot ? "cause-client" : ""}">${e.bot ? "bot" : "caller"}</span></td>
        <td class="num">${num(e.count)}</td>
        <td class="chart"><div class="track${cause(e) === "server" ? " sev" : ""}" data-w="${((e.count / peak) * 100).toFixed(1)}"></div></td>
      </tr>`)
    .join("");
  applySizes($("errors"));

  // Server errors are called out separately because they are the only kind that
  // means something is broken; the rest is scanners and correct rejections.
  const server = errors.filter((e) => cause(e) === "server").reduce((n, e) => n + e.count, 0);
  summary("errors-total", [
    part("distinct", errors.length),
    part("total", errors.reduce((n, e) => n + e.count, 0)),
    part("requested", errors.filter((e) => e.injected).reduce((n, e) => n + e.count, 0)),
    part("from bots", errors.filter((e) => e.bot).reduce((n, e) => n + e.count, 0)),
    part("server", server, server ? "warn" : ""),
  ]);
}

function renderRegions(regions) {
  if (!regions.length) {
    $("regions").innerHTML = '<tr><td colspan="4" class="muted">No regions recorded yet. Cloudflare does not always report one.</td></tr>';
    return;
  }
  const peak = Math.max(...regions.map((r) => r.visitors));
  $("regions").innerHTML = regions
    .map((r) => `<tr>
        <td><span class="flag">${flag(r.country)}</span>${String(r.region).replace(/[<>&"]/g, "").slice(0, 40)}
            <span class="code">${isCode(r.country) ? r.country.toUpperCase() : ""}</span></td>
        <td class="num">${num(r.visitors)}</td>
        <td class="num">${num(r.addresses)}</td>
        <td class="chart"><div class="track" data-w="${((r.visitors / peak) * 100).toFixed(1)}"></div></td>
      </tr>`)
    .join("");
  applySizes($("regions"));
  summary("regions-total", [
    part("regions", regions.length),
    part("people", regions.reduce((n, r) => n + r.visitors, 0)),
    part("addresses", regions.reduce((n, r) => n + r.addresses, 0)),
  ]);
}

function renderGeo(countries) {
  if (!countries.length) {
    $("geo").innerHTML = '<tr><td colspan="5" class="muted">No regions recorded yet.</td></tr>';
    return;
  }
  const peak = Math.max(...countries.map((c) => c.requests));
  $("geo").innerHTML = countries
    .map((c) => `<tr>
        <td><span class="flag">${flag(c.country)}</span>${countryName(c.country)}
            <span class="code">${isCode(c.country) ? c.country.toUpperCase() : ""}</span></td>
        <td class="num">${num(c.visitors)}</td>
        <td class="num">${num(c.bots)}</td>
        <td class="num">${num(c.requests)}</td>
        <td class="chart"><div class="track" data-w="${((c.requests / peak) * 100).toFixed(1)}"></div></td>
      </tr>`)
    .join("");
  applySizes($("geo"));
  summary("geo-total", [
    part("countries", countries.length),
    part("people", countries.reduce((n, c) => n + c.visitors, 0)),
    part("bots", countries.reduce((n, c) => n + (c.bots || 0), 0)),
    part("requests", countries.reduce((n, c) => n + c.requests, 0)),
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
  } catch (err) {
    authToken = null;
    clearToken();
    $("error").textContent = err.message;
    $("error").hidden = false;
  }
}

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
