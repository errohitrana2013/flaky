const $ = (id) => document.getElementById(id);
const num = (n) => Number(n || 0).toLocaleString();

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
  renderHours(data.hourly);
  renderErrors(data.errors || []);
  renderGeo(data.countries);
  renderRegions(data.regions || []);

  $("keys").innerHTML = data.topKeys.length
    ? data.topKeys.map((k) => `<tr><td class="mono">${k.key_id}</td><td class="num">${num(k.requests)}</td></tr>`).join("")
    : '<tr><td colspan="2" class="muted">No keyed traffic yet.</td></tr>';

  $("gate").hidden = true;
  $("panel").hidden = false;
}

// The API stores hours in UTC. "When should I ship" is a local-time question,
// so shift into the viewer's zone here. India and friends sit on a half-hour
// offset, hence the fractional maths rather than a plain integer rotate.
function renderHours(hourly) {
  const offset = -new Date().getTimezoneOffset() / 60;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("tz").textContent = zone ? `· ${zone}` : "· local time";

  const label = (v) => {
    const hh = Math.floor(v);
    return `${String(hh).padStart(2, "0")}:${String(Math.round((v - hh) * 60)).padStart(2, "0")}`;
  };

  const buckets = hourly
    .map((b) => ({ ...b, local: (((b.hour + offset) % 24) + 24) % 24 }))
    .sort((a, b) => a.local - b.local);

  const peak = Math.max(...buckets.map((b) => b.requests));

  $("hours").innerHTML = buckets
    .map((b, i) => {
      const height = peak ? Math.max((b.requests / peak) * 100, 1.5) : 1.5;
      // Every third label only; 24 of them overlap on a phone.
      return `<div class="hour${b.requests === peak && peak > 0 ? " peak" : ""}"
                   title="${label(b.local)}–${label((b.local + 1) % 24)} · ${num(b.requests)} requests, ${num(b.errors)} errors">
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

function renderErrors(errors) {
  if (!errors.length) {
    $("errors").innerHTML = '<tr><td colspan="4" class="muted">No errors recorded.</td></tr>';
    return;
  }
  const peak = Math.max(...errors.map((e) => e.count));
  $("errors").innerHTML = errors
    .map((e) => `<tr>
        <td><span class="st st-${String(e.status)[0]}">${Number(e.status) || "?"}</span></td>
        <td class="mono">${String(e.path).replace(/[<>&"]/g, "")}</td>
        <td class="num">${num(e.count)}</td>
        <td class="chart"><div class="track${e.status >= 500 ? " sev" : ""}" data-w="${((e.count / peak) * 100).toFixed(1)}"></div></td>
      </tr>`)
    .join("");
  applySizes($("errors"));
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
}

function renderGeo(countries) {
  if (!countries.length) {
    $("geo").innerHTML = '<tr><td colspan="4" class="muted">No regions recorded yet.</td></tr>';
    return;
  }
  const peak = Math.max(...countries.map((c) => c.requests));
  $("geo").innerHTML = countries
    .map((c) => `<tr>
        <td><span class="flag">${flag(c.country)}</span>${countryName(c.country)}
            <span class="code">${isCode(c.country) ? c.country.toUpperCase() : ""}</span></td>
        <td class="num">${num(c.visitors)}</td>
        <td class="num">${num(c.requests)}</td>
        <td class="chart"><div class="track" data-w="${((c.requests / peak) * 100).toFixed(1)}"></div></td>
      </tr>`)
    .join("");
  applySizes($("geo"));
}

// Held in memory only, for the export requests. It still needs the admin
// header, so the download cannot be a plain link.
let authToken = null;

async function attempt(token) {
  $("error").hidden = true;
  try {
    render(await load(token));
    authToken = token;
    sessionStorage.setItem("flaky_admin", token);
  } catch (err) {
    authToken = null;
    sessionStorage.removeItem("flaky_admin");
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

for (const button of document.querySelectorAll(".csv")) {
  button.addEventListener("click", () => downloadCsv(button));
}

$("go").addEventListener("click", () => attempt($("token").value.trim()));
$("token").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });

// sessionStorage can throw in a private window; a failed read just shows the gate.
try {
  const saved = sessionStorage.getItem("flaky_admin");
  if (saved) attempt(saved);
} catch {}
