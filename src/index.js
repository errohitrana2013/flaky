// Entry point. Deliberately thin: it wires middleware to the router and gets
// out of the way. Business logic lives in src/handlers.
//
//   request → CORS → route → auth → rate limit → chaos → handler
//                                                          ↓
//                                          response ← telemetry (after send)

import { matchRoute } from "./router.js";
import { preflight, fail, withHeaders } from "./lib/response.js";
import { resolveTier } from "./middleware/auth.js";
import { checkRateLimit, rateHeaders } from "./middleware/ratelimit.js";
import { applyChaos } from "./middleware/chaos.js";
import { visitorId, classifyClient, logRequest, rollUp, sendDigest, purgeExpired } from "./middleware/analytics.js";
import { today, utcHour } from "./lib/hash.js";

async function handle(request, env, ctx, url) {
  const route = matchRoute(request.method, url.pathname);
  if (!route) return fail(404, "No such route", "See GET /v1/meta for what this API offers.");

  const context = { request, env, ctx, url, query: url.searchParams, params: route.params, auth: null };

  // The admin endpoint has its own guard and is exempt from tiers and limits.
  if (route.auth === "admin") return route.handler(context);

  const auth = await resolveTier(request, env);
  if (auth.invalid) {
    return fail(401, "Unrecognised API key", "Create one at POST /v1/keys, or drop the header for the anonymous tier.");
  }
  context.auth = auth;

  const identity = auth.key || request.headers.get("cf-connecting-ip") || "unknown";
  const rate = await checkRateLimit(env, identity, auth.tier);
  if (!rate.ok) {
    return fail(429, "Daily request limit reached", `The ${auth.tier} tier allows ${rate.limit} requests/day. Limits reset at 00:00 UTC.`);
  }

  const headers = rateHeaders(rate, auth.tier);

  const injected = await applyChaos(url.searchParams);
  if (injected) return withHeaders(injected, headers);

  return withHeaders(await route.handler(context), headers);
}

// Telemetry runs after the response is returned, so it costs the caller
// nothing and can never break a request.
function recordTelemetry(ctx, request, env, url, response, startedAt) {
  ctx.waitUntil((async () => {
    try {
      const auth = await resolveTier(request, env).catch(() => ({ tier: "anonymous", keyId: null }));
      const meta = {
        visitor: await visitorId(request, env.VISITOR_SALT || "change-me"),
        client: classifyClient(request),
        path: url.pathname,
        method: request.method,
        status: response.status,
        tier: auth.tier,
        keyId: auth.keyId,
        referrer: request.headers.get("referer") || "",
        // 'XX' rather than empty, so an unknown region is a visible row in the
        // dashboard instead of a blank one that looks like a bug.
        country: request.cf?.country || "XX",
        durationMs: Date.now() - startedAt,
        bytes: Number(response.headers.get("content-length")) || 0,
      };
      logRequest(env, ctx, request, meta);
      await rollUp(env, ctx, { day: today(), hour: utcHour(), ...meta });
    } catch {
      // Telemetry failures are never surfaced to the caller.
    }
  })());
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const startedAt = Date.now();

    if (request.method === "OPTIONS") return preflight();

    // Anything outside /v1 is the marketing site and docs.
    if (!url.pathname.startsWith("/v1")) return env.ASSETS.fetch(request);

    const response = await handle(request, env, ctx, url);
    recordTelemetry(ctx, request, env, url, response, startedAt);
    return response;
  },

  // Nightly: purge expired sandboxes, post yesterday's numbers.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([purgeExpired(env), sendDigest(env)]));
  },
};
