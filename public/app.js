const $ = (id) => document.getElementById(id);

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

async function send() {
  const button = $("send");
  button.disabled = true;
  $("out").textContent = "…";

  const started = performance.now();
  try {
    const res = await fetch(buildUrl());
    const elapsed = Math.round(performance.now() - started);
    const text = await res.text();

    $("s-code").textContent = res.status;
    $("s-code").className = res.ok ? "s-ok" : "s-err";
    $("s-time").textContent = elapsed + "ms";
    $("s-tier").textContent = res.headers.get("x-tier") || "—";
    $("s-left").textContent = res.headers.get("x-ratelimit-remaining") || "—";

    try { $("out").textContent = JSON.stringify(JSON.parse(text), null, 2); }
    catch { $("out").textContent = text; }
  } catch (err) {
    $("s-code").textContent = "network";
    $("s-code").className = "s-err";
    $("out").textContent = String(err);
  } finally {
    button.disabled = false;
  }
}

$("send").addEventListener("click", send);
$("path").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

// The resource table is rendered from /v1/meta so it can never drift from the
// actual dataset.
fetch("/v1/meta")
  .then((r) => r.json())
  .then((meta) => {
    $("resources").querySelector("tbody").innerHTML = meta.resources
      .map((r) => `<tr>
        <td class="mono"><a href="/v1/${r.name}">/v1/${r.name}</a></td>
        <td class="num">${r.count.toLocaleString()}</td>
        <td class="mono muted">${r.nested.join("<br>") || "—"}</td>
      </tr>`)
      .join("");
  })
  .catch(() => {
    $("resources").querySelector("tbody").innerHTML =
      '<tr><td colspan="3" class="muted">Could not reach /v1/meta.</td></tr>';
  });
