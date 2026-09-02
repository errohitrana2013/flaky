import { COUNTS, RESOURCES } from "../data/index.js";
import { RELATIONS } from "../data/relations.js";
import { TIERS } from "../config/tiers.js";
import { json } from "../lib/response.js";

// A machine-readable description of the whole API. Anything a client would
// otherwise hardcode — resource names, row counts, tier limits — is served
// from here, so the docs page and the landing page have no baked-in duplicates
// that can drift.

// GET /v1/meta
export function getMeta(ctx) {
  return json({
    name: "flaky",
    tagline: "A mock REST API that fails on purpose.",
    version: "1",
    openapi: "/v1/openapi.json",
    custom: { url: "/v1/custom", method: "POST", note: "Send your own JSON, get endpoints for it for 24 hours." },
    resources: RESOURCES.map((name) => ({
      name,
      count: COUNTS[name],
      url: `/v1/${name}`,
      nested: Object.keys(RELATIONS[name] || {}).map((child) => `/v1/${name}/:id/${child}`),
    })),
    query: {
      "<field>=<value>": "filter by any field, e.g. ?userId=3",
      _q: "full-text search across the record",
      _sort: "field to sort by",
      _order: "asc (default) or desc",
      _page: "1-based page number",
      _limit: "page size, capped at your tier's maxLimit",
    },
    chaos: {
      _delay: "milliseconds to stall before responding, up to 10000",
      _status: "force this HTTP status, e.g. ?_status=503",
      _fail_rate: "probability from 0 to 1 that the request returns 500",
    },
    tiers: TIERS,
    you: { tier: ctx.auth.tier, limits: TIERS[ctx.auth.tier] },
  });
}
