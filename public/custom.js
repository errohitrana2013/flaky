const $ = (id) => document.getElementById(id);

// Two pages share this file: /createMockServer takes data, /openapiMockServer
// takes a spec. Everything after the request — the result panel, the exports,
// the day-long memory — is the same, because on the server it is the same thing.
const MODE = document.body?.dataset?.mode === "openapi" ? "openapi" : "json";

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

// The same example as src/config/example.js; check:docs fails if they drift.
const SPEC_SAMPLE = `{
  "openapi": "3.0.3",
  "info": { "title": "Orders API", "version": "1.0.0" },
  "servers": [{ "url": "https://api.example.com" }],
  "paths": {
    "/api/v1/customers": {
      "get": { "responses": { "200": { "description": "All customers",
        "content": { "application/json": { "schema": {
          "type": "array", "items": { "$ref": "#/components/schemas/Customer" } } } } } } }
    },
    "/api/v1/customers/{id}": {
      "get": { "responses": { "200": { "description": "One customer",
        "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Customer" } } } } } }
    },
    "/api/v1/orders": {
      "get": { "responses": { "200": { "description": "A page of orders",
        "content": { "application/json": { "schema": {
          "type": "object",
          "properties": {
            "data": { "type": "array", "items": { "$ref": "#/components/schemas/Order" } },
            "total": { "type": "integer" } } } } } } } },
      "post": { "responses": { "201": { "description": "Created" } } }
    }
  },
  "components": {
    "schemas": {
      "Customer": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "name": { "type": "string" },
          "email": { "type": "string", "format": "email" },
          "city": { "type": "string" }
        }
      },
      "Order": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "customerId": { "type": "integer" },
          "status": { "type": "string", "enum": ["placed", "shipped", "delivered", "cancelled"] },
          "total": { "type": "number" },
          "createdAt": { "type": "string", "format": "date-time" }
        }
      }
    }
  }
}`;

const bytes = (s) => new TextEncoder().encode(s).length;
// A spec is read and thrown away, so it may be larger than the records kept
// from it. Matches MAX_SPEC_BYTES and MAX_CUSTOM_BYTES in src/config/tiers.js.
const LIMIT = (MODE === "openapi" ? 1024 : 256) * 1024;

function showSize() {
  const n = bytes($("json").value);
  const el = $("size");
  el.textContent = n ? `${(n / 1024).toFixed(1)} KB of ${LIMIT / 1024}` : "";
  el.classList.toggle("over", n > LIMIT);
}

// Reported before the request, because a 413 after a slow upload is a worse way
// to learn the limit than a counter that was there all along.
$("json").addEventListener("input", showSize);
$("sample").addEventListener("click", () => {
  $("json").value = MODE === "openapi" ? SPEC_SAMPLE : SAMPLE;
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

  if (!raw) {
    return fail("Nothing to turn into an API", MODE === "openapi" ? "Paste your spec, or use the example." : "Paste some JSON, or use the example.");
  }

  // Parsed here as well as on the server so the message names the line you are
  // looking at rather than arriving after a round trip.
  try {
    JSON.parse(raw);
  } catch (err) {
    // A YAML spec is not a JSON typo, and saying "unexpected token o" would
    // send someone looking for one. The server says the same thing.
    if (MODE === "openapi" && /^\s*(openapi|swagger)\s*:/m.test(raw)) {
      return fail(
        "YAML specs are not supported yet — paste JSON",
        "Your app most likely serves it as JSON already: FastAPI at /openapi.json, springdoc at /v3/api-docs, " +
          "Swashbuckle at /swagger/v1/swagger.json. Or convert: npx js-yaml openapi.yaml > openapi.json"
      );
    }
    return fail("That is not valid JSON", err.message);
  }

  const button = $("create");
  // Put back whatever the page called it — the two pages label it differently.
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Creating…";

  try {
    // Up to nine days, chosen on the page; left off, the server's default is one.
    const days = $("days")?.value;
    const path = MODE === "openapi" ? "/v1/custom/openapi" : "/v1/custom";
    const res = await fetch(days ? `${path}?days=${encodeURIComponent(days)}` : path, {
      method: "POST",
      headers: ownerHeaders({ "content-type": "application/json" }),
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
    button.textContent = label;
  }
});

let current = null;

// The API lives for up to nine days on the server, so the page has to remember
// it for as long. Losing the id on a refresh — or on a trip to the ready-made API and
// back — means the endpoints are gone as far as the person is concerned, even
// though they are still being served.
// One per page, so a spec import does not replace the JSON one or the other way
// round — they are different things someone may well have both of.
const STORE = MODE === "openapi" ? "flaky.custom.openapi.v1" : "flaky.custom.v1";

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
// is left, not when it lands. Days once there are any: "in 214h" is arithmetic
// left to the reader.
function remaining(expiresAt) {
  const ms = Date.parse(expiresAt) - Date.now();
  if (!(ms > 0)) return null;
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d) return `in ${d}d ${h}h`;
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

  // Escaped: a name is whatever key someone pasted, or whatever path a spec
  // declared, and neither is markup.
  $("endpoints").innerHTML = data.resources
    .map((r) => {
      const name = esc(r.name);
      const path = esc(encodeURIComponent(r.name));
      return `<tr>
        <td class="mono">${name}</td>
        <td class="num">${r.count.toLocaleString()}</td>
        <td class="mono"><a href="${data.baseUrl}/${path}" target="_blank" rel="noopener">${esc(base)}/${path}</a></td>
      </tr>`;
    })
    .join("");

  renderSpecNotes(data);

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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Only a spec import has any of this to say. What to swap the base URL for is
// first, because it is the one thing the person has to do; then everything that
// was left out and why, because a mock that silently drops routes makes the
// app's failures look like the app's fault.
function renderSpecNotes(data) {
  const box = $("spec-notes");
  if (!box) return;
  const skipped = data.skipped || [];
  const warnings = data.warnings || [];
  if (!data.replaces && !skipped.length && !warnings.length) {
    box.hidden = true;
    return;
  }

  const base = location.origin + data.baseUrl;
  const swap = data.replaces
    ? `<p>Point your app at <code>${esc(base)}</code> where it now uses <code>${esc(data.replaces)}</code>.</p>`
    : `<p>Point your app's base URL at <code>${esc(base)}</code>.</p>`;
  const list = (title, items) => items.length
    ? `<h4>${title}</h4><ul>${items.join("")}</ul>`
    : "";

  box.innerHTML = swap +
    list("Differs from your spec", warnings.map((w) => `<li>${esc(w)}</li>`)) +
    list("Not mocked", skipped.map((s) => `<li><code>${esc(s.path)}</code> — ${esc(s.reason)}</li>`));
  box.hidden = false;
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
// Set by the admin pages on the owner's own browser, and sent so the API counts
// these requests as traffic rather than as a visitor. A plain flag, never the
// token. A hoisted function rather than a const: verify() can run while this
// file is still loading, and app.js declares the same one on the landing page.
function ownerHeaders(headers = {}) {
  try { if (localStorage.getItem("flaky_owner") === "1") return { ...headers, "x-flaky-owner": "1" }; } catch { /* storage blocked */ }
  return headers;
}

async function verify(data) {
  try {
    const res = await fetch(data.baseUrl, { headers: ownerHeaders({ accept: "application/json" }) });
    if (res.status === 404 || res.status === 410) {
      forget();
      fail("That API has expired", `Paste your ${MODE === "openapi" ? "spec" : "JSON"} again to create a new one.`);
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
    const res = await fetch(`${current.baseUrl}/export?format=${format}`, { headers: ownerHeaders() });
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
