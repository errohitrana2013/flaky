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
