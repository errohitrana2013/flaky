import { json, fail } from "../lib/response.js";
import { today } from "../lib/hash.js";
import { normalisePath } from "../middleware/analytics.js";

// POST /v1/beacon  { path, seconds }
//
// Sent by the site's own pages on unload, via navigator.sendBeacon. The server
// cannot measure dwell time itself — it sees arrivals, never departures.
//
// Nothing here is trusted. The body is caller-controlled, so the path is
// normalised and length-capped and the duration is clamped: a tab left open
// overnight is not a four-hour reading session, and an open endpoint that
// increments counters must not let anyone write arbitrary numbers into them.

const MAX_SECONDS = 1800;    // 30 minutes; beyond this it is an abandoned tab
const BOUNCE_UNDER = 10;     // seconds

export async function recordBeacon(ctx) {
  const body = await ctx.request.json().catch(() => null);
  if (!body || typeof body.path !== "string") {
    return fail(400, "Expected a path and seconds", 'Send {"path":"/","seconds":42} as JSON.');
  }

  const seconds = Math.min(Math.max(Math.round(Number(body.seconds) || 0), 0), MAX_SECONDS);
  // A beacon that reports nothing is not worth a write.
  if (seconds <= 0) return json({ recorded: false });

  const path = normalisePath(String(body.path).slice(0, 120));

  // Deferred, not awaited. A D1 write is a round trip, and it was making the
  // beacon the slowest endpoint on the site at 243ms average — for a request
  // whose entire point is that the browser has already navigated away and is not
  // waiting for the answer.
  const write = ctx.env.DB.prepare(
    `INSERT INTO page_time (day, path, visits, sum_seconds, max_seconds, bounced)
     VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT (day, path) DO UPDATE SET
       visits      = visits + 1,
       sum_seconds = sum_seconds + excluded.sum_seconds,
       max_seconds = MAX(max_seconds, excluded.max_seconds),
       bounced     = bounced + excluded.bounced`
  ).bind(today(), path, seconds, seconds, seconds < BOUNCE_UNDER ? 1 : 0).run()
   .catch(() => {}); // a lost beacon is not worth an error anyone will see

  ctx.ctx?.waitUntil ? ctx.ctx.waitUntil(write) : await write;

  return json({ recorded: true });
}
