const $ = (id) => document.getElementById(id);
const num = (n) => Number(n || 0).toLocaleString();
const ms = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "s" : Math.round(n) + "ms");
const clean = (s) => String(s).replace(/[<>&"]/g, "").slice(0, 80);

// Mirrors the dashboard: a fixed line under each scrollable table.
function summary(id, parts) {
  const el = $(id);
  if (el) el.innerHTML = parts.filter(Boolean).join("");
}
const part = (label, value, cls = "") =>
  `<span>${label} <b class="${cls}">${typeof value === "number" ? num(value) : value}</b></span>`;

function applySizes(root) {
  for (const el of root.querySelectorAll("[data-w]")) el.style.width = el.dataset.w + "%";
}

function render(d) {
  const c = d.chaos;
  // Lead with external adoption. The all-traffic figure includes the try-it
  // widget on our own landing page, which is us, not adoption.
  $("chaos-share").textContent = (c.externalShare * 100).toFixed(1) + "%";
  $("c-ext").textContent = num(c.externalRequests);
  $("c-delay").textContent = num(c.delay);
  $("c-status").textContent = num(c.status);
  $("c-fail").textContent = num(c.failRate);

  // The interpretation matters more than the number, and it changes meaning
  // entirely depending on whether anyone is here yet.
  $("chaos-line").textContent =
    "of requests from outside this site reach for a chaos parameter";

  const ext = c.externalRequests;
  const excluded = `Excluded: ${c.onsite.toLocaleString()} from this site's try-it widget and ${(c.bots || 0).toLocaleString()} automated — test scripts run from curl, which is a bot.`;
  $("chaos-hint").textContent =
    ext < 100
      ? `Only ${ext.toLocaleString()} request${ext === 1 ? "" : "s"} have come from a human outside this site, so there is nothing to read yet. ${excluded}`
      : c.externalShare === 0
      ? "Nobody outside this site has used a chaos parameter. Either they have not found them, or the landing page is not making the case."
      : c.externalShare < 0.05
      ? "Low. People are using this as a plain mock API — the thing that makes it different is not landing."
      : `People are reaching for the controls. This is the number to protect. ${excluded}`;

  renderReturning(d.returning);
  renderDwell(d.dwell || []);

  const refs = d.referrers;
  $("referrers").innerHTML = refs.length
    ? (() => {
        const peak = Math.max(...refs.map((r) => r.requests));
        return refs.map((r) => `<tr>
            <td class="mono">${clean(r.referrer)}</td>
            <td class="num">${num(r.requests)}</td>
            <td class="chart"><div class="track" data-w="${((r.requests / peak) * 100).toFixed(1)}"></div></td>
          </tr>`).join("");
      })()
    : '<tr><td colspan="3" class="muted">No referrers yet. Most API calls send none — this fills in when people arrive from links.</td></tr>';
  applySizes($("referrers"));
  summary("referrers-total", [
    part("sources", refs.length),
    part("requests", refs.reduce((n, r) => n + r.requests, 0)),
  ]);

  const paths = d.paths;
  $("paths").innerHTML = paths.length
    ? (() => {
        const peak = Math.max(...paths.map((p) => p.requests));
        return paths.map((p) => `<tr>
            <td class="mono">${clean(p.path)}</td>
            <td class="num">${num(p.requests)}</td>
            <td class="ms">${ms(p.avgMs)}</td>
            <td class="ms${p.maxMs > 2000 ? " slow" : ""}">${ms(p.maxMs)}</td>
            <td class="chart"><div class="track" data-w="${((p.requests / peak) * 100).toFixed(1)}"></div></td>
          </tr>`).join("");
      })()
    : '<tr><td colspan="5" class="muted">No requests recorded yet.</td></tr>';
  applySizes($("paths"));
  summary("paths-total", [
    part("endpoints", paths.length),
    part("requests", paths.reduce((n, p) => n + p.requests, 0)),
    part("slowest", ms(Math.max(0, ...paths.map((p) => p.maxMs)))),
  ]);

  $("slowest").innerHTML = d.slowest.length
    ? d.slowest.map((p) => `<tr>
        <td class="mono">${clean(p.path)}</td>
        <td class="ms${p.max_ms > 2000 ? " slow" : ""}">${ms(p.max_ms)}</td>
        <td class="ms">${ms(p.avg_ms)}</td>
        <td class="num">${num(p.requests)}</td>
      </tr>`).join("")
    : '<tr><td colspan="4" class="muted">Nothing recorded yet.</td></tr>';

  const worst = Math.max(0, ...d.slowest.map((p) => p.max_ms));
  summary("slowest-total", [
    part("endpoints", d.slowest.length),
    part("worst single response", ms(worst), worst > 2000 ? "warn" : ""),
  ]);

  $("gate").hidden = true;
  $("panel").hidden = false;
}

const secs = (n) => (n >= 60 ? Math.floor(n / 60) + "m " + (n % 60) + "s" : n + "s");

function renderReturning(r) {
  const back = r.today.returning, fresh = r.today.new, total = back + fresh;
  $("r-new").textContent = num(fresh);
  $("r-back").textContent = num(back);
  $("r-rate").textContent = total ? ((back / total) * 100).toFixed(0) + "%" : "—";

  // Ordinals rather than "2 days", which makes the reader do the translation.
  // A day is the unit because a visitor is counted once per day — two visits in
  // one afternoon is one row, and the note above the table says so.
  const ordinal = (n) =>
    n === 1 ? "Once — never returned"
    : n === 2 ? "Twice"
    : n === 3 ? "Three times"
    : `${n} times`;

  const rows = r.frequency;
  const everyone = rows.reduce((sum, f) => sum + f.people, 0);
  $("frequency").innerHTML = rows.length
    ? (() => {
        const peak = Math.max(...rows.map((f) => f.people));
        return rows.map((f) => `<tr${f.days > 1 ? ' class="repeat"' : ""}>
            <td>${ordinal(f.days)}</td>
            <td class="num">${num(f.people)}</td>
            <td class="num">${everyone ? ((f.people / everyone) * 100).toFixed(1) + "%" : "—"}</td>
            <td class="chart"><div class="track${f.days > 1 ? " sev" : ""}" data-w="${((f.people / peak) * 100).toFixed(1)}"></div></td>
          </tr>`).join("");
      })()
    : '<tr><td colspan="4" class="muted">Nobody recorded yet.</td></tr>';
  applySizes($("frequency"));
  const came = rows.filter((f) => f.days > 1).reduce((n, f) => n + f.people, 0);
  summary("frequency-total", [
    part("people", everyone),
    part("came back at all", came),
    part("return rate", everyone ? ((came / everyone) * 100).toFixed(1) + "%" : "—"),
  ]);
}

function renderDwell(rows) {
  $("dwell").innerHTML = rows.length
    ? rows.map((p) => `<tr>
        <td class="mono">${clean(p.path)}</td>
        <td class="num">${num(p.visits)}</td>
        <td class="num">${secs(p.avgSeconds)}</td>
        <td class="num">${secs(p.maxSeconds)}</td>
        <td class="num">${(p.bounceRate * 100).toFixed(0)}%</td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted">No page visits recorded yet. Only the landing page reports this, and only once someone leaves it.</td></tr>';

  const visits = rows.reduce((n, p) => n + p.visits, 0);
  const seconds = rows.reduce((n, p) => n + p.avgSeconds * p.visits, 0);
  summary("dwell-total", [
    part("pages", rows.length),
    part("visits", visits),
    part("average across all", visits ? secs(Math.round(seconds / visits)) : "—"),
  ]);
}

let authToken = null;

async function attempt(token) {
  $("error").hidden = true;
  try {
    const res = await fetch("/v1/admin/insights?days=14", {
      headers: { authorization: "Bearer " + token },
    });
    if (!res.ok) throw new Error(res.status === 401 ? "Token rejected." : "Request failed: " + res.status);
    render(await res.json());
    authToken = token;
    saveToken(token);
  } catch (err) {
    authToken = null;
    clearToken();
    $("error").textContent = err.message;
    $("error").hidden = false;
  }
}

async function downloadCsv(button) {
  const dataset = button.dataset.csv;
  button.disabled = true;
  try {
    const res = await fetch(`/v1/admin/export?dataset=${dataset}&days=90`, {
      headers: { authorization: "Bearer " + authToken },
    });
    if (!res.ok) throw new Error("Export failed: " + res.status);
    const named = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/);
    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: named ? named[1] : dataset + ".csv" });
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    $("error").textContent = err.message;
    $("error").hidden = false;
  } finally {
    button.disabled = false;
  }
}

$("go").addEventListener("click", () => attempt($("token").value.trim()));
$("token").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });
for (const b of document.querySelectorAll(".csv")) b.addEventListener("click", () => downloadCsv(b));

wireSessionControls(() => location.reload());

const saved = loadToken();
if (saved) attempt(saved);
