// No imports here, ever. This file is the bottom of the dependency graph.

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
  "access-control-expose-headers":
    "x-total-count, x-page, x-total-pages, x-tier, x-ratelimit-limit, x-ratelimit-remaining, x-mock-write",
};

// Query params the API interprets itself. Everything else is treated as a
// field filter, so this set has to stay in sync with lib/query.js and
// middleware/chaos.js.
export const RESERVED_PARAMS = new Set([
  "_limit",
  "_page",
  "_sort",
  "_order",
  "_q",
  "_delay",
  "_status",
  "_fail_rate",
]);

export const DEFAULT_PAGE_SIZE = 30;

// Cache reads at the edge so the common case never reaches the Worker.
export const READ_CACHE_SECONDS = 300;

// Applied to every response, API and page alike.
//
// nosniff matters most for the API: without it a browser may sniff a JSON body
// containing attacker-chosen text as HTML and execute it.
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
};

// The HTML pages. Inline <script> and <style> were moved into their own files
// specifically so this can be 'self' rather than 'unsafe-inline' — an inline
// allowance would make the script policy close to decorative. Bar widths in the
// dashboard are set through the CSSOM, which CSP does not restrict.
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

// A JSON response should never load or execute anything at all.
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
