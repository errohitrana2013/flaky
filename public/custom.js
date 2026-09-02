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
    render(data);
  } catch (err) {
    fail("Could not reach the API", err.message);
  } finally {
    button.disabled = false;
    button.textContent = "Create the API";
  }
});

let current = null;

function render(data) {
  current = data;
  const base = location.origin + data.baseUrl;

  $("expires").textContent = new Date(data.expiresAt).toLocaleString();

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
  $("result").scrollIntoView({ behavior: "smooth", block: "start" });
}

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

$("dl-json").addEventListener("click", () => download("json-server", "db.json"));
$("dl-msw").addEventListener("click", () => download("msw", "handlers.js"));
