import { visitorId, today, daysAgo } from "../lib/hash.js";
import { VISITOR_RETENTION_DAYS, ROLLUP_RETENTION_DAYS } from "../config/tiers.js";

export { visitorId };

// Two sinks, on purpose:
//
//   Analytics Engine  one row per request, unlimited cardinality, SQL later.
//   D1 rollups        a tiny per-day summary the dashboard can read instantly.
//
// Neither is on the request path — index.js calls these inside waitUntil, so a
// telemetry outage can never turn into an API outage.

const BOT = /bot|crawl|spider|slurp|curl|wget|python-requests|httpie|postman|insomnia|axios\/|go-http|java\/|okhttp/i;

// What a request asks for is stronger evidence than what it claims to be.
// Credential sweeps send ordinary browser user-agents, so a UA check alone
// counted them as people — 49 "US visitors" turned out to be concentrated in
// Virginia, Oregon and Iowa, which are datacenter regions rather than places
// people live.
//
// Nobody browsing a mock API asks for .env. One of these is enough, and the bot
// flag is sticky for the day, so the rest of that visitor's traffic is
// classified correctly too.
const PROBE = new RegExp([
  // Anchored: things only ever asked for at the root.
  "^\\/(\\.env|\\.git|\\.aws|\\.ssh|\\.config|\\.vscode|\\.idea|\\.DS_Store|\\.npmrc|\\.bash_history)",
  // Anywhere in the path. Scanners prepend directories — /blog/wp-includes/…,
  // /shop/wp-includes/… — and anchoring to the root missed every one of them
  // while catching the bare version, so the same sweep landed half in "human".
  "(wp-includes|wp-admin|wp-login|wp-content|phpmyadmin|phpinfo|\\/vendor\\/|\\/storage\\/)",
  // We are a Worker. Any .php request is somebody looking for a different site.
  "\\.php($|\\?)",
  // Credential and backup file shapes, wherever they appear.
  "(env|config|credentials|secrets|settings|shell|eval-stdin)\\.(js|json|php|ya?ml|txt|bak|old)$",
  "\\.(sql|sqlite|bak|old|zip|tar|gz|pem|key)$",
].join("|"), "i");

export function isProbe(path) {
  if (PROBE.test(path)) return true;
  try {
    // Collapse repeated slashes too: /%2f%2eenv decodes to //.env, and the
    // doubled slash was enough to slip past on its own.
    const decoded = decodeURIComponent(path).replace(/\/{2,}/g, "/");
    return decoded !== path && PROBE.test(decoded);
  } catch {
    return false;
  }
}

export function classifyClient(request, path = "") {
  // Checked first: a browser user-agent asking for /.env is not a browser.
  if (path && isProbe(path)) return "bot";

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
      meta.country,
      meta.referrer,
      meta.keyId || "",
    ],
    doubles: [meta.durationMs, meta.bytes, meta.client === "bot" ? 1 : 0],
  });
}

// Two writes per request, not four. Daily totals, the hour-of-day histogram
// and the per-country breakdown are all GROUP BYs over the same row, so one
// bucket serves all three. See migrations/0003 for why that ceiling matters.
// /v1/posts/42 -> /v1/posts/:id, and sandbox ids likewise. Without this every
// record id would be its own row and the breakdown would be unreadable as well
// as unbounded.
export function normalisePath(path) {
  return path
    .split("/")
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{16}$/.test(segment)) return ":sandbox";
      return segment;
    })
    .join("/")
    .slice(0, 120);
}

// Host only, lowercased. A full referrer can carry a search query or a private
// path; the host is what answers "which channel worked".
export function referrerHost(raw) {
  if (!raw) return "";
  try { return new URL(raw).hostname.toLowerCase().slice(0, 80); } catch { return ""; }
}

export async function rollUp(env, ctx, meta) {
  if (!env.DB) return;
  const keyId = meta.keyId || "anon";
  const isError = meta.status >= 400 ? 1 : 0;

  // Only written on failures, so a healthy service pays nothing for it.
  const errorDetail = isError
    ? [
        env.DB.prepare(
          `INSERT INTO error_bucket (day, status, path, injected, bot, count)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT (day, status, path, injected, bot) DO UPDATE SET count = count + 1`
        ).bind(meta.day, meta.status, normalisePath(meta.path),
               meta.injected ? 1 : 0, meta.client === "bot" ? 1 : 0),
      ]
    : [];

  // A referrer from our own pages is the try-it widget, not a channel. It is
  // counted separately below rather than sitting at the top of a table meant to
  // show where people are arriving from.
  const host = referrerHost(meta.referrer);
  const onsite = host && meta.host && host === meta.host ? 1 : 0;
  const usedChaos = meta.chaos?.delay || meta.chaos?.status || meta.chaos?.failRate ? 1 : 0;
  const isBot = meta.client === "bot" ? 1 : 0;

  const referrerRow = host && !onsite
    ? [
        env.DB.prepare(
          `INSERT INTO referrer_bucket (day, referrer, requests) VALUES (?, ?, 1)
           ON CONFLICT (day, referrer) DO UPDATE SET requests = requests + 1`
        ).bind(meta.day, host),
      ]
    : [];

  await env.DB.batch([
    ...errorDetail,
    ...referrerRow,

    // Top endpoints, latency, and whether the chaos parameters are actually
    // being used — the last of which is the product's central question.
    env.DB.prepare(
      `INSERT INTO path_bucket (day, path, requests, sum_ms, max_ms, with_delay, with_status, with_fail_rate, onsite, onsite_chaos, bot_requests, bot_chaos)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, path) DO UPDATE SET
         requests       = requests + 1,
         sum_ms         = sum_ms + excluded.sum_ms,
         max_ms         = MAX(max_ms, excluded.max_ms),
         with_delay     = with_delay + excluded.with_delay,
         with_status    = with_status + excluded.with_status,
         with_fail_rate = with_fail_rate + excluded.with_fail_rate,
         onsite         = onsite + excluded.onsite,
         onsite_chaos   = onsite_chaos + excluded.onsite_chaos,
         bot_requests   = bot_requests + excluded.bot_requests,
         bot_chaos      = bot_chaos + excluded.bot_chaos`
    ).bind(
      meta.day, normalisePath(meta.path), meta.durationMs, meta.durationMs,
      meta.chaos?.delay ? 1 : 0, meta.chaos?.status ? 1 : 0, meta.chaos?.failRate ? 1 : 0,
      onsite, onsite && usedChaos ? 1 : 0,
      isBot, isBot && usedChaos ? 1 : 0
    ),
    env.DB.prepare(
      `INSERT INTO usage_bucket (day, hour, key_id, tier, country, requests, errors)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (day, hour, key_id, country) DO UPDATE SET
         requests = requests + 1,
         errors   = errors + excluded.errors`
    ).bind(meta.day, meta.hour, keyId, meta.tier, meta.country, isError),

    // One row per visitor per day. The country and region recorded are the ones
    // they first appeared from.
    //
    // Not OR IGNORE: a row written before region and ip_hash existed would keep
    // its blanks forever, because IGNORE never revisits an existing row. The
    // guarded DO UPDATE backfills such a row once and then no-ops, so a repeat
    // visitor still costs nothing on the steady path.
    env.DB.prepare(
      `INSERT INTO daily_visitors (day, visitor, country, region, ip_hash, bot, hour)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, visitor) DO UPDATE SET
         region  = excluded.region,
         ip_hash = excluded.ip_hash,
         -- Sticky: one bot-shaped request is enough to call it a bot for the
         -- day. A crawler that sends a browser user agent once should not
         -- launder itself into the human count.
         bot     = MAX(daily_visitors.bot, excluded.bot),
         -- Only ever fills a blank. The hour of first arrival must not drift
         -- forward every time the same person comes back.
         hour    = CASE WHEN daily_visitors.hour < 0 THEN excluded.hour ELSE daily_visitors.hour END
       WHERE daily_visitors.ip_hash = ''
          OR daily_visitors.hour < 0
          OR daily_visitors.region = ''
          OR daily_visitors.bot < excluded.bot`
    ).bind(meta.day, meta.visitor, meta.country, meta.region || "", meta.ipHash || "", meta.client === "bot" ? 1 : 0, meta.hour),
  ]);
}

// --- cron jobs -------------------------------------------------------------

// Everything that grows is trimmed here. Left alone, the rollups would grow for
// the life of the project — small per day, unbounded over years, and nothing
// else deletes from them.
export async function purgeExpired(env) {
  if (!env.DB) return;
  const now = Date.now();
  const visitorCutoff = daysAgo(VISITOR_RETENTION_DAYS);
  const rollupCutoff = daysAgo(ROLLUP_RETENTION_DAYS);

  await env.DB.batch([
    // Expired sandboxes, and the records belonging to them. Records first, or
    // the second statement removes the rows the first needs to find them by.
    env.DB.prepare(
      "DELETE FROM sandbox_records WHERE sandbox_id IN (SELECT id FROM sandboxes WHERE expires_at < ?)"
    ).bind(now),
    env.DB.prepare("DELETE FROM sandboxes WHERE expires_at < ?").bind(now),

    // Visitor hashes: the privacy clock, and the shortest of the three.
    env.DB.prepare("DELETE FROM daily_visitors WHERE day < ?").bind(visitorCutoff),

    // Aggregates: no identity in them, so they keep a year for comparison.
    env.DB.prepare("DELETE FROM usage_bucket WHERE day < ?").bind(rollupCutoff),
    env.DB.prepare("DELETE FROM path_bucket WHERE day < ?").bind(rollupCutoff),
    env.DB.prepare("DELETE FROM referrer_bucket WHERE day < ?").bind(rollupCutoff),
    env.DB.prepare("DELETE FROM error_bucket WHERE day < ?").bind(rollupCutoff),
  ]);
}

export async function sendDigest(env) {
  if (!env.DIGEST_WEBHOOK || !env.DB) return;

  const day = daysAgo(1);
  const totals = await env.DB.prepare(
    "SELECT SUM(requests) AS requests, SUM(errors) AS errors FROM usage_bucket WHERE day = ?"
  ).bind(day).first();

  const visitors = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM daily_visitors WHERE day = ? AND bot = 0"
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
