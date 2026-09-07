const $ = (id) => document.getElementById(id);

const SAMPLE = `{
  "todos": [
    { "id": 1, "title": "Test the loading state", "done": false, "userId": 1 },
    { "id": 2, "title": "Test the error state",   "done": true,  "userId": 1 },
    { "id": 3, "title": "Test the retry logic",   "done": false, "userId": 2 }
  ],
  "users": [
    { "id": 1, "name": "Asha Menon",  "team": "Platform" },
    { "id": 2, "name": "Wei Chen",    "team": "Product" }
  ]
}`;

const bytes = (s) => new TextEncoder().encode(s).length;
const LIMIT = 256 * 1024;

function showSize() {
  const n = bytes($("json").value);
  const el = $("size");
  el.textContent = n ? `${(n / 1024).toFixed(1)} KB of 256` : "";
  el.classList.toggle("over", n > LIMIT);
}

// Reported before the request, because a 413 after a slow upload is a worse way
// to learn the limit than a counter that was there all along.
$("json").addEventListener("input", showSize);
$("sample").addEventListener("click", () => {
  $("json").value = SAMPLE;
  showSize();
  $("json").focus();
});

function fail(title, detail) {
  $("error").innerHTML = `<b></b><span></span>`;
  $("error").querySelector("b").textContent = title;
  $("error").querySelector("span").textContent = detail || "";
  $("error").hidden = false;
  $("result").hidden = true;
}

$("create").addEventListener("click", async () => {
  const raw = $("json").value.trim();
  $("error").hidden = true;

  if (!raw) return fail("Nothing to turn into an API", "Paste some JSON, or use the example.");

  // Parsed here as well as on the server so the message names the line you are
  // looking at rather than arriving after a round trip.
  try {
    JSON.parse(raw);
  } catch (err) {
    return fail("That is not valid JSON", err.message);
  }

  const button = $("create");
  button.disabled = true;
  button.textContent = "Creating…";

  try {
    const res = await fetch("/v1/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    const data = await res.json();
    if (!res.ok) return fail(data.error?.message || `Failed (${res.status})`, data.error?.hint);
    remember(data, raw);
    render(data);
  } catch (err) {
    fail("Could not reach the API", err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Create the API";
  }
});

let current = null;

// The API lives for a day on the server, so the page has to remember it for a
// day too. Losing the id on a refresh — or on a trip to the ready-made API and
// back — means the endpoints are gone as far as the person is concerned, even
// though they are still being served.
const STORE = "flaky.custom.v1";

function remember(data, json) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ data, json }));
  } catch { /* private mode, or full: the API still works, it just will not persist */ }
}

function forget() {
  try {
    localStorage.removeItem(STORE);
  } catch { /* nothing to do about it */ }
  current = null;
  $("result").hidden = true;
}

// "in 7h 12m" beside the timestamp, because the number that matters is how much
// is left, not when it lands.
function remaining(expiresAt) {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!(ms > 0)) return null;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h ? `in ${h}h ${m}m` : `in ${m}m`;
}

function showExpiry(data) {
  const left = remaining(data.expiresAt);
  if (!left) return forget();
  $("expires").textContent = `${new Date(data.expiresAt).toLocaleString()} — ${left}`;
}

function render(data, { scroll = true } = {}) {
  current = data;
  const base = location.origin + data.baseUrl;

  showExpiry(data);

  $("endpoints").innerHTML = data.resources
    .map((r) => `<tr>
        <td class="mono">${r.name}</td>
        <td class="num">${r.count.toLocaleString()}</td>
        <td class="mono"><a href="${data.baseUrl}/${r.name}" target="_blank" rel="noopener">${base}/${r.name}</a></td>
      </tr>`)
    .join("");

  // Built from the caller's own first resource, so the examples are copy-pasteable
  // rather than illustrative.
  const first = data.resources[0]?.name || "items";
  $("chaos").textContent =
    `# three seconds slower, to see your loading state\n` +
    `${base}/${first}?_delay=3000\n\n` +
    `# a hard failure, to see your error state\n` +
    `${base}/${first}?_status=503\n\n` +
    `# one request in three fails, to test retries\n` +
    `${base}/${first}?_fail_rate=0.3\n\n` +
    `# a body that stops mid-record, to test your JSON parsing\n` +
    `${base}/${first}?_malformed=1`;

  $("result").hidden = false;
  // Only when it has just been created. Yanking a restored page down to the
  // result on every load would fight whoever came back to paste something else.
  if (scroll) $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

// Restore on load: the same panel, with the exports still wired up, so a refresh
// costs nothing. Anything unreadable or expired is dropped rather than shown.
function restore() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE) || "null");
  } catch { /* corrupt or unavailable — treated as nothing saved */ }

  const data = saved?.data;
  if (!data?.baseUrl || !Array.isArray(data.resources)) return;
  if (!remaining(data.expiresAt)) return forget();

  if (saved.json && !$("json").value) {
    $("json").value = saved.json;
    showSize();
  }
  render(data, { scroll: false });
  verify(data);
}

// The server is the authority on whether it still exists. A local copy can
// outlive the row — the nightly purge, or a database that was reset — and
// showing endpoints that 404 is worse than showing nothing.
async function verify(data) {
  try {
    const res = await fetch(data.baseUrl, { headers: { accept: "application/json" } });
    if (res.status === 404 || res.status === 410) {
      forget();
      fail("That API has expired", "Paste your JSON again to create a new one — they last 24 hours.");
    }
  } catch { /* offline: keep showing what we have rather than wiping it */ }
}

// Keeps the countdown honest on a tab left open, and clears the panel at the
// moment it stops working instead of an hour later.
setInterval(() => {
  if (current) showExpiry(current);
}, 60000);

async function download(format, filename) {
  if (!current) return;
  try {
    const res = await fetch(`${current.baseUrl}/export?format=${format}`);
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    fail("Could not export", err.message);
  }
}

$("dl-node").addEventListener("click", () => download("node", "mock-server.mjs"));
$("dl-python").addEventListener("click", () => download("python", "mock_server.py"));
$("dl-java").addEventListener("click", () => download("java", "MockServer.java"));
$("dl-csharp").addEventListener("click", () => download("csharp", "MockServer.cs"));
$("dl-json").addEventListener("click", () => download("json-server", "db.json"));
$("dl-msw").addEventListener("click", () => download("msw", "handlers.js"));

// Last, so everything it touches exists. Nothing here clears the saved API but
// creating another one or the day running out — coming back to the page is
// supposed to find it exactly where it was left.
restore();
