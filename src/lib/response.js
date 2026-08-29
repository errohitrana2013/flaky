import { CORS_HEADERS, SECURITY_HEADERS, PAGE_CSP, API_CSP } from "../config/constants.js";

// Hardening applied on the way out, in one place, so a new route cannot forget
// it. Pages and JSON get different content policies: a page loads its own CSS
// and JS, a JSON body should load nothing at all.
export function harden(response, { page = false } = {}) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  headers.set("content-security-policy", page ? PAGE_CSP : API_CSP);
  // frame-ancestors covers modern browsers; this covers the rest.
  headers.set("x-frame-options", "DENY");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Every response leaves through here, so CORS and content-type are applied in
// exactly one place.

export function json(data, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "content-length": String(new TextEncoder().encode(body).length),
      ...headers,
    },
  });
}

// Errors carry a hint, not just a message. A caller who gets this back should
// know what to do next without opening the docs.
export const fail = (status, message, hint = "") =>
  json({ error: { status, message, hint } }, { status });

// Use this for any caller-supplied value that appears in an error message.
//
// Echoing a raw query value back is safe for us — nothing here renders HTML —
// but this API exists to be consumed by other people's apps, and a beginner
// following a tutorial will eventually drop `error.hint` into innerHTML. At
// that point an unsanitised echo makes us the source of their XSS. Reducing it
// to a short, boring character set keeps the hint useful and removes the
// footgun rather than documenting it.
// All-or-nothing rather than character stripping. Stripping turns
// `<img src=x onerror=alert(1)>` into `imgsrcxonerroralert1`, which is safe but
// mangled and still carries the attacker's words — so a value is echoed only if
// it is entirely boring, and otherwise replaced outright. The common case, a
// typo'd number, still echoes cleanly.
const SAFE = /^[\w.:+-]*$/;

export function echo(value) {
  const raw = String(value ?? "");
  if (raw === "") return "(empty)";
  if (raw.length > 32) return "(too long)";
  return SAFE.test(raw) ? raw : "(unprintable)";
}

export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

// Add headers to an already-built response without rebuilding the body.
export function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
