const $ = (id) => document.getElementById(id);

// Set by the admin pages on the owner's own browser, and sent so the API counts
// these requests as traffic rather than as a visitor. A plain flag, never the
// token. A function declaration, not a const, because custom.js declares the
// same one and both can load on one page.
function ownerHeaders(headers = {}) {
  try { if (localStorage.getItem("flaky_owner") === "1") return { ...headers, "x-flaky-owner": "1" }; } catch { /* storage blocked */ }
  return headers;
}

// Copy-pasteable examples have to point at wherever this page is actually
// served from — localhost while developing, workers.dev today, a custom domain
// later. Hardcoding one of those means the other two are quietly wrong.
for (const el of document.querySelectorAll(".host")) el.textContent = location.origin;

// Clamp to the range the API accepts, and write the corrected number back into
// the field so the user sees what was actually sent. Sending an out-of-range
// value would earn an honest 400 from the API, but that reads as the demo being
// broken rather than as the input being wrong.
function clamp(input, min, max) {
  if (!input.value.trim()) return "";
  const bounded = Math.min(Math.max(Number(input.value), min), max);
  if (!Number.isFinite(bounded)) { input.value = ""; return ""; }
  input.value = String(bounded);
  return String(bounded);
}

function buildUrl() {
  const url = new URL($("path").value.trim() || "/v1/posts", location.origin);
  const delay = clamp($("delay"), 0, 10000);
  const fail = clamp($("fail"), 0, 1);
  const status = $("status").value;
  if (delay) url.searchParams.set("_delay", delay);
  if (status) url.searchParams.set("_status", status);
  if (fail) url.searchParams.set("_fail_rate", fail);
  return url;
}

// What each method starts with, so picking PUT does not leave a list URL in the
// box that can only answer 405. Swapped in only until the visitor edits a field
// themselves; after that, what they typed is theirs.
const EXAMPLES = {
  GET: { path: "/v1/posts?_limit=3" },
  POST: { path: "/v1/posts", body: { title: "Hello", body: "Sent from the try-it box.", userId: 1 } },
  PUT: { path: "/v1/posts/1", body: { title: "Replaced", body: "PUT sends the whole record.", userId: 1 } },
  PATCH: { path: "/v1/posts/1", body: { title: "Only this field changes" } },
  DELETE: { path: "/v1/posts/1" },
};
const edited = { path: false, body: false };

// The try-it box is on the landing page only. /docs/jsonplaceholder loads this
// file for the .host rewrite above, and wiring a box that is not there threw
// on every visit to it.
const hasTryIt = Boolean($("send"));

if (hasTryIt) {
  $("path").addEventListener("input", () => { edited.path = true; });
  $("req-body").addEventListener("input", () => { edited.body = true; });

  $("method").addEventListener("change", () => {
    const example = EXAMPLES[$("method").value];
    if (!edited.path) $("path").value = example.path;
    if (!edited.body) $("req-body").value = example.body ? JSON.stringify(example.body, null, 2) : "";
    $("req-body-wrap").hidden = !example.body;
  });
}

async function send() {
  const method = $("method").value;
  const init = { method };

  // Checked here because the API reads a body it cannot parse as {}, so a typo
  // would come back as a success with none of the fields that were typed.
  if (EXAMPLES[method].body && $("req-body").value.trim()) {
    try {
      JSON.parse($("req-body").value);
    } catch (err) {
      $("s-code").textContent = "not sent";
      $("s-code").className = "s-err";
      $("s-write").hidden = true;
      $("out").textContent = `The body is not valid JSON, so nothing was sent.\n\n${err.message}`;
      return;
    }
    init.body = $("req-body").value;
    init.headers = { "content-type": "application/json" };
  }

  init.headers = ownerHeaders(init.headers);

  const button = $("send");
  button.disabled = true;
  $("out").textContent = "…";

  const started = performance.now();
  try {
    const res = await fetch(buildUrl(), init);
    const elapsed = Math.round(performance.now() - started);
    const text = await res.text();

    $("s-code").textContent = res.status;
    $("s-code").className = res.ok ? "s-ok" : "s-err";
    $("s-time").textContent = elapsed + "ms";
    $("s-tier").textContent = res.headers.get("x-tier") || "—";
    $("s-left").textContent = res.headers.get("x-ratelimit-remaining") || "—";
    // An echoed write looks exactly like a stored one apart from this header.
    $("s-write").hidden = !res.headers.get("x-mock-write");

    try { $("out").textContent = JSON.stringify(JSON.parse(text), null, 2); }
    catch { $("out").textContent = text; }
  } catch (err) {
    $("s-code").textContent = "network";
    $("s-code").className = "s-err";
    $("s-write").hidden = true;
    $("out").textContent = String(err);
  } finally {
    button.disabled = false;
  }
}

if (hasTryIt) {
  $("send").addEventListener("click", send);
  $("path").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
}

// The resource and method tables are written into index.html by
// scripts/bake-tables.mjs, so crawlers that do not run JavaScript see them too.
// npm test fails if they fall out of step with /v1/meta.
