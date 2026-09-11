import { json, fail } from "../lib/response.js";
import { today, visitorId } from "../lib/hash.js";
import { normalisePath, classifyClient } from "../middleware/analytics.js";

// POST /v1/beacon  { path, seconds }
//
// Sent by the site's own pages on unload, via navigator.sendBeacon. The server
// cannot measure dwell time itself — it sees arrivals, never departures.
//
// Nothing here is trusted. The body is caller-controlled, so the path is
// normalised and length-capped and the duration is clamped: a tab left open
// overnight is not a four-hour reading session, and an open endpoint that
// increments counters must not let anyone write arbitrary numbers into them.

// Ten minutes, lowered from thirty. A single abandoned tab hitting the old cap
// was 30 of a 30-minute total across three visits, making the average read as
// ten minutes of reading. Nobody reads a docs page for ten minutes either, so
// anything at the cap is a tab left open and the cap is where it stops counting.
const MAX_SECONDS = 600;
const BOUNCE_UNDER = 10;     // seconds

export async function recordBeacon(ctx) {
  const body = await ctx.request.json().catch(() => null);
  if (!body || typeof body.path !== "string") {
    return fail(400, "Expected a path and seconds", 'Send {"path":"/","seconds":42} as JSON.');
  }

  // The owner reading their own site is not a reader. Their browser marks it once
  // they have signed in to the dashboard; the flag rides in the body because
  // sendBeacon cannot send headers, and goes on through state so this request's
  // own telemetry leaves them out of the visitor counts too. Anyone can send it —
  // doing so only removes themselves from the numbers.
  if (body.owner === true) {
    if (ctx.state) ctx.state.owner = true;
    return json({ recorded: false });
  }

  const seconds = Math.min(Math.max(Math.round(Number(body.seconds) || 0), 0), MAX_SECONDS);
  // A beacon that reports nothing is not worth a write.
  if (seconds <= 0) return json({ recorded: false });

  const path = normalisePath(String(body.path).slice(0, 120));

  // The pages themselves never reach this Worker — Cloudflare serves anything
  // matching public/ before the Worker runs — so this beacon is the only place
  // a page read can be attributed to the person who read it. Without it a
  // visitor's trail would be API calls only, and most of what people do here is
  // read the landing page and the migration guide.
  //
  // Same hash and the same bot exclusion as the request rollup, so the row joins
  // the ones written there and a scanner that somehow sends a beacon is left out
  // of both.
  const trail = classifyClient(ctx.request, path) === "bot"
    ? []
    : [
        ctx.env.DB.prepare(
          `INSERT INTO visitor_path (day, visitor, path, requests, chaos, errors)
           VALUES (?, ?, ?, 1, 0, 0)
           ON CONFLICT (day, visitor, path) DO UPDATE SET requests = requests + 1`
        ).bind(today(), await visitorId(ctx.request, ctx.env.VISITOR_SALT || "change-me"), path),
      ];

  // Deferred, not awaited. A D1 write is a round trip, and it was making the
  // beacon the slowest endpoint on the site at 243ms average — for a request
  // whose entire point is that the browser has already navigated away and is not
  // waiting for the answer.
  const write = ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO page_time (day, path, visits, sum_seconds, max_seconds, bounced)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT (day, path) DO UPDATE SET
         visits      = visits + 1,
         sum_seconds = sum_seconds + excluded.sum_seconds,
         max_seconds = MAX(max_seconds, excluded.max_seconds),
         bounced     = bounced + excluded.bounced`
    ).bind(today(), path, seconds, seconds, seconds < BOUNCE_UNDER ? 1 : 0),
    ...trail,
  ]).catch(() => {}); // a lost beacon is not worth an error anyone will see

  ctx.ctx?.waitUntil ? ctx.ctx.waitUntil(write) : await write;

  return json({ recorded: true });
}
