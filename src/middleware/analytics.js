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
  // Dotfiles, at any depth. This was anchored to the root, and a sweep of 182
  // paths — /app/.env, /laravel/.env, /var/www/html/.env — went through as a
  // person because not one of them was at the root. Exactly the mistake already
  // recorded two lines down for wp-includes, made twice.
  //
  // The trailing class keeps it to whole segments: /.git/config and .env.local
  // match, a path that merely starts with those letters does not.
  "(^|\\/)(\\.env|\\.git|\\.aws|\\.ssh|\\.config|\\.vscode|\\.idea|\\.DS_Store|\\.npmrc|\\.bash_history)($|[\\/.?])",
  // Cloud service-account keys, the other half of the same sweep. The stem has
  // to be the whole filename or the tail of a hyphenated one, so
  // /v1/openapi.json — a real route here — is not caught by it.
  "(^|\\/)([a-z0-9_-]+[-_])?(service-account|serviceaccount|firebase-adminsdk|gcp-key|google-key|sa|key|keyfile|credentials|creds|secret|secrets)\\.json$",
  // Anywhere in the path. Scanners prepend directories — /blog/wp-includes/…,
  // /shop/wp-includes/… — and anchoring to the root missed every one of them
  // while catching the bare version, so the same sweep landed half in "human".
  // wp-json joined late: the sweep POSTing to /blog/wp-json/batch/v1 had no
  // .php and none of the others in it, so it landed in the dashboard as a caller.
  "(wp-includes|wp-admin|wp-login|wp-content|wp-json|phpmyadmin|phpinfo|\\/vendor\\/|\\/storage\\/)",
  // A bare WordPress directory, which the same sweep asks for before anything
  // inside it — so /wordpress/index.php was a bot and /wordpress/ a person. Only
  // at the root: deeper, it could be a resource someone named in their own JSON.
  "^\\/(wordpress|wp)(\\/|$)",
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

  // A page only ever takes GET. Following a link never sends anything else, so a
  // POST to /blog/ is an exploit attempt whatever its user-agent says — these
  // showed up as 405s from "callers". /v1 is left out: a write there is the API
  // being used, the try-it box included.
  //
  // Judged on the URL the request was sent to, not `path`: the beacon passes the
  // page it is reporting, and it arrives as a POST to /v1/beacon, so testing
  // `path` would have filed every page view it records as a bot.
  const sentTo = new URL(request.url).pathname;
  if (!sentTo.startsWith("/v1") && !["GET", "HEAD"].includes(request.method)) return "bot";

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

// Daily totals, the hour-of-day histogram and the per-country breakdown are all
// GROUP BYs over the same row, so one bucket serves all three rather than three
// buckets serving one each. See migrations/0003 for why that ceiling matters,
// and 0020 for the third write that visitor_path adds on top of it.
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
  const path = normalisePath(meta.path);

  // Only written on failures, so a healthy service pays nothing for it.
  const errorDetail = isError
    ? [
        env.DB.prepare(
          `INSERT INTO error_bucket (day, status, path, injected, bot, count)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT (day, status, path, injected, bot) DO UPDATE SET count = count + 1`
        ).bind(meta.day, meta.status, path,
               meta.injected ? 1 : 0, meta.client === "bot" ? 1 : 0),
      ]
    : [];

  // A referrer from our own pages is the try-it widget, not a channel. It is
  // counted separately below rather than sitting at the top of a table meant to
  // show where people are arriving from.
  const host = referrerHost(meta.referrer);
  const onsite = host && meta.host && host === meta.host ? 1 : 0;
  // Any of the seven, counted once. Summing the per-control columns instead
  // double-counted a request carrying two of them, and ignored the four that
  // had no column at all.
  const usedChaos = Object.values(meta.chaos || {}).some(Boolean) ? 1 : 0;
  const isBot = meta.client === "bot" ? 1 : 0;

  // One row per person per path per day: what a returning visitor actually did,
  // which no other rollup can answer because none of them carry a visitor.
  //
  // Three exclusions, all deliberate. Bots never get a row — a credential sweep
  // touches dozens of probe paths and would be most of the table while telling
  // us nothing about anyone who chose to be here. And the beacon is this site's
  // own instrumentation, not something a person did; counting it would put
  // /v1/beacon at the top of every trail. The page it reports is recorded by the
  // beacon handler under the page's own path instead.
  //
  // Admin requests are excluded for the same reason the try-it widget is left
  // out of the chaos figure: it is us. Without this the operator reading the
  // dashboard is the first entry in the dashboard's own list of people who came
  // back, ahead of everybody it exists to show.
  // Two more, for the same reason. The site's owner, flagged by their own
  // browser once signed in to the dashboard: three of the 25 people listed as
  // having come back twice were them. And the /v1/meta fetch the landing page
  // makes by itself on every load — the person loaded a page, they did not call
  // an endpoint, and it was the top line of every trail. Clicking the /v1/meta
  // link is a navigation, so that still counts.
  const pageLoad = path === "/v1/meta" && onsite && meta.fetchMode !== "navigate";
  const trail = isBot || meta.owner || pageLoad || path === "/v1/beacon" || path.startsWith("/v1/admin")
    ? []
    : [
        env.DB.prepare(
          `INSERT INTO visitor_path (day, visitor, path, requests, chaos, errors)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT (day, visitor, path) DO UPDATE SET
             requests = requests + 1,
             chaos    = chaos + excluded.chaos,
             errors   = errors + excluded.errors`
        ).bind(meta.day, meta.visitor, path, usedChaos, isError),
      ];

  // Not for the operator, for the same reasons as the trail: admin requests
  // and the owner's own browser are us. Six "localhost" referrals on
  // 2026-09-25 were the dashboard run through a local dev server against the
  // live database. localhost itself stays — a developer calling flaky from an
  // app on localhost:3000 is exactly the channel worth seeing.
  const referrerRow = host && !onsite && !meta.owner && !path.startsWith("/v1/admin")
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
    ...trail,

    // Top endpoints, latency, and whether the chaos parameters are actually
    // being used — the last of which is the product's central question.
    env.DB.prepare(
      `INSERT INTO path_bucket (day, path, requests, sum_ms, max_ms, with_delay, with_status, with_fail_rate, with_scenario, with_malformed, with_any, onsite, onsite_chaos, bot_requests, bot_chaos)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, path) DO UPDATE SET
         requests       = requests + 1,
         sum_ms         = sum_ms + excluded.sum_ms,
         max_ms         = MAX(max_ms, excluded.max_ms),
         with_delay     = with_delay + excluded.with_delay,
         with_status    = with_status + excluded.with_status,
         with_fail_rate = with_fail_rate + excluded.with_fail_rate,
         with_scenario  = with_scenario + excluded.with_scenario,
         with_malformed = with_malformed + excluded.with_malformed,
         with_any       = with_any + excluded.with_any,
         onsite         = onsite + excluded.onsite,
         onsite_chaos   = onsite_chaos + excluded.onsite_chaos,
         bot_requests   = bot_requests + excluded.bot_requests,
         bot_chaos      = bot_chaos + excluded.bot_chaos`
    ).bind(
      meta.day, path, meta.durationMs, meta.durationMs,
      meta.chaos?.delay ? 1 : 0, meta.chaos?.status ? 1 : 0, meta.chaos?.failRate ? 1 : 0,
      meta.chaos?.scenario ? 1 : 0, meta.chaos?.malformed ? 1 : 0, usedChaos,
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
    //
    // None at all for the owner: every figure about people reads this table.
    ...(meta.owner ? [] : [env.DB.prepare(
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
    ).bind(meta.day, meta.visitor, meta.country, meta.region || "", meta.ipHash || "", meta.client === "bot" ? 1 : 0, meta.hour)]),
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
    env.DB.prepare("DELETE FROM custom_apis WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM scenarios WHERE expires_at < ?").bind(now),

    // Visitor hashes: the privacy clock, and the shortest of the three.
    env.DB.prepare("DELETE FROM daily_visitors WHERE day < ?").bind(visitorCutoff),
    // The per-visitor trail hangs off that hash, so it lives and dies with it.
    // Keeping it a day longer than the identity it belongs to would be keeping
    // it for no one, and the privacy page promises the same 90 days for both.
    env.DB.prepare("DELETE FROM visitor_path WHERE day < ?").bind(visitorCutoff),

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
