// Entry point. Deliberately thin: it wires middleware to the router and gets
// out of the way. Business logic lives in src/handlers.
//
//   request → CORS → route → auth → rate limit → chaos → handler
//                                                          ↓
//                                          response ← telemetry (after send)

import { matchRoute } from "./router.js";
import { validatePaging } from "./lib/query.js";
import { TIERS } from "./config/tiers.js";
import { preflight, fail, withHeaders, harden } from "./lib/response.js";
import { resolveTier } from "./middleware/auth.js";
import { checkRateLimit, rateHeaders } from "./middleware/ratelimit.js";
import { applyChaos } from "./middleware/chaos.js";
import { visitorId, classifyClient, logRequest, rollUp, sendDigest, purgeExpired } from "./middleware/analytics.js";
import { today, utcHour, ipId } from "./lib/hash.js";

async function handle(request, env, ctx, url, state) {
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
  state.auth = auth;

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rate = await checkRateLimit(env, { key: auth.key, ip }, auth.tier, ctx);
  if (!rate.ok) {
    return rate.scope === "ip"
      ? fail(429, "Daily request limit reached for this address", `All keys from one address share a ceiling of ${rate.limit} requests/day. Limits reset at 00:00 UTC.`)
      : fail(429, "Daily request limit reached", `The ${auth.tier} tier allows ${rate.limit} requests/day. Limits reset at 00:00 UTC.`);
  }

  const headers = rateHeaders(rate, auth.tier);

  const paging = validatePaging(url.searchParams, TIERS[auth.tier].maxLimit);
  if (paging) return withHeaders(paging, headers);

  const injected = await applyChaos(url.searchParams);
  if (injected) return withHeaders(injected, headers);

  return withHeaders(await route.handler(context), headers);
}

// Telemetry runs after the response is returned, so it costs the caller
// nothing and can never break a request.
function recordTelemetry(ctx, request, env, url, response, state) {
  ctx.waitUntil((async () => {
    try {
      // Reuses what handle() already resolved. Re-querying here cost a second
      // D1 round trip on every authenticated request, for an answer already in
      // hand.
      const auth = state.auth || { tier: "anonymous", keyId: null };
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
        // State/province. Coarse on purpose — city plus a quiet day starts to
        // identify a person, which the visitor hashing exists to prevent.
        region: request.cf?.region || "",
        ipHash: await ipId(request, env.VISITOR_SALT || "change-me"),
        // Which of the three controls this caller reached for. The whole
        // product thesis is that people want these; nothing measured it.
        chaos: {
          delay: url.searchParams.has("_delay"),
          status: url.searchParams.has("_status"),
          failRate: url.searchParams.has("_fail_rate"),
        },
        // A failure the caller requested is the product working, not a fault.
        // Only _status and _fail_rate can cause one; _delay cannot.
        injected:
          response.status >= 400 &&
          (url.searchParams.has("_status") || url.searchParams.has("_fail_rate")),
        durationMs: state.durationMs,
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

    if (request.method === "OPTIONS") return harden(preflight());

    const isApi = url.pathname.startsWith("/v1");

    // Filled in by handle(), read by recordTelemetry.
    const state = { auth: null, durationMs: 0 };

    // No redirect from the old workers.dev host, and that is a decision rather
    // than an omission: Cloudflare serves a matching static asset *before* the
    // Worker runs, so a redirect here would never execute for the pages it was
    // meant to catch. Forcing it would mean run_worker_first, which turns every
    // asset request into a Worker invocation against a 100k/day budget.
    //
    // The duplicate-content problem it was meant to solve is already handled by
    // the <link rel="canonical"> in public/index.html, which is the cheaper and
    // more standard answer.


    let response;
    try {
      // Anything outside /v1 is the marketing site and docs.
      response = isApi
        ? await handle(request, env, ctx, url, state)
        : harden(await env.ASSETS.fetch(request), { page: true });
    } catch (err) {
      // Last line of defence. Without it an unexpected throw — a D1 outage, a
      // KV blip — becomes a Cloudflare 1101 page: no CORS headers, no JSON, and
      // a browser client sees an opaque network error rather than a status it
      // can actually handle.
      response = fail(500, "Something broke on our side", "This is a bug in flaky, not a problem with your request.");
    }

    // Assets are hardened above with the page policy; everything else, including
    // the catch path, gets the API policy here.
    if (isApi || response.status === 500) response = harden(response);

    // Measured HERE, not inside waitUntil. Taking it there included the
    // telemetry's own D1 round trip — work that happens after the response has
    // already been sent — and reported ~300ms for endpoints that answer from a
    // bundled array in single digits.
    //
    // An injected delay is subtracted for the same reason: a caller who asked
    // to wait three seconds got what they wanted, and counting it as service
    // latency would make the chaos feature look like a performance problem.
    const injectedDelay = Math.max(0, Number(url.searchParams.get("_delay")) || 0);
    state.durationMs = Math.max(0, Date.now() - startedAt - injectedDelay);

    recordTelemetry(ctx, request, env, url, response, state);
    return response;
  },

  // Nightly: purge expired sandboxes, post yesterday's numbers.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([purgeExpired(env), sendDigest(env)]));
  },
};
