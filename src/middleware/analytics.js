import { visitorId, today, daysAgo } from "../lib/hash.js";
import { VISITOR_RETENTION_DAYS } from "../config/tiers.js";

export { visitorId };

// Two sinks, on purpose:
//
//   Analytics Engine  one row per request, unlimited cardinality, SQL later.
//   D1 rollups        a tiny per-day summary the dashboard can read instantly.
//
// Neither is on the request path — index.js calls these inside waitUntil, so a
// telemetry outage can never turn into an API outage.

const BOT = /bot|crawl|spider|slurp|curl|wget|python-requests|httpie|postman|insomnia|axios\/|go-http|java\/|okhttp/i;

export function classifyClient(request) {
  const agent = request.headers.get("user-agent") || "";
  if (!agent) return "unknown";
  if (BOT.test(agent)) return "bot";
  if (/mozilla|safari|chrome|firefox/i.test(agent)) return "browser";
  return "unknown";
}

// Column order is load-bearing: the SQL in the README refers to blob1..blob8
// and double1..double3 positionally. Append, never reorder.
export function logRequest(env, ctx, request, meta) {
  if (!env.ANALYTICS) return;
  env.ANALYTICS.writeDataPoint({
    indexes: [meta.visitor],
    blobs: [
      meta.path,
      meta.method,
      String(meta.status),
      meta.tier,
      meta.client,
      request.cf?.country || "",
      meta.referrer,
      meta.keyId || "",
    ],
    doubles: [meta.durationMs, meta.bytes, meta.client === "bot" ? 1 : 0],
  });
}

// One upsert per request would be a write per request. Instead we increment a
// per-day, per-key counter, which D1 collapses cheaply.
export async function rollUp(env, ctx, meta) {
  if (!env.DB) return;
  const keyId = meta.keyId || "anon";
  const isError = meta.status >= 400 ? 1 : 0;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO usage_daily (day, key_id, tier, requests, errors)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (day, key_id) DO UPDATE SET
         requests = requests + 1,
         errors   = errors + excluded.errors`
    ).bind(meta.day, keyId, meta.tier, isError),

    // Primary key makes this idempotent, so a repeat visitor costs one no-op.
    env.DB.prepare(
      "INSERT OR IGNORE INTO daily_visitors (day, visitor) VALUES (?, ?)"
    ).bind(meta.day, meta.visitor),
  ]);
}

// --- cron jobs -------------------------------------------------------------

export async function purgeExpired(env) {
  if (!env.DB) return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM sandbox_records WHERE sandbox_id IN (SELECT id FROM sandboxes WHERE expires_at < ?)"
    ).bind(now),
    env.DB.prepare("DELETE FROM sandboxes WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM daily_visitors WHERE day < ?").bind(daysAgo(VISITOR_RETENTION_DAYS)),
  ]);
}

export async function sendDigest(env) {
  if (!env.DIGEST_WEBHOOK || !env.DB) return;

  const day = daysAgo(1);
  const totals = await env.DB.prepare(
    "SELECT SUM(requests) AS requests, SUM(errors) AS errors FROM usage_daily WHERE day = ?"
  ).bind(day).first();

  const visitors = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM daily_visitors WHERE day = ?"
  ).bind(day).first();

  const requests = totals?.requests || 0;
  const errors = totals?.errors || 0;

  await fetch(env.DIGEST_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `flaky · ${day} — ${requests} requests, ${visitors?.count || 0} visitors, ${errors} errors`,
    }),
  }).catch(() => {});
}
