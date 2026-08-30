import { json, fail, echo } from "../lib/response.js";
import { daysAgo, today } from "../lib/hash.js";
import { toCsv, csvResponse } from "../lib/csv.js";

// Reads the D1 rollups, never the raw request log. The dashboard has to stay
// fast and free, and Analytics Engine is for ad-hoc SQL when a question comes
// up that the rollups cannot answer.
//
// This route bypasses the tier and rate-limit pipeline (router.js marks it
// auth: "admin"), so it does its own check first and ctx.auth is null here.

// ADMIN_TOKEN accepts a comma-separated list, so a token can be rotated
// without a window where the dashboard is locked out: add the new one, switch
// over, then drop the old one on the next `wrangler secret put`.
//
// Comparison is length-then-constant-time. A remote timing attack on a 48-char
// random token is not a realistic threat, but the correct comparison costs one
// line and removes the need to have that argument.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorised(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token || !env.ADMIN_TOKEN) return false;

  return String(env.ADMIN_TOKEN)
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .some((candidate) => safeEqual(token, candidate));
}

// GET /v1/admin/stats?days=14
export async function getStats(ctx) {
  if (!authorised(ctx.request, ctx.env)) {
    return fail(401, "Admin token required", "Send Authorization: Bearer <ADMIN_TOKEN>.");
  }

  const days = Math.min(Math.max(Number(ctx.query.get("days")) || 14, 1), 90);
  const since = daysAgo(days);

  const [daily, visitors, keys, topKeys, hourly, geoRequests, geoVisitors, errors_, regions, addresses, arrivals] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT day, SUM(requests) AS requests, SUM(errors) AS errors
       FROM usage_bucket WHERE day >= ? GROUP BY day ORDER BY day`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT day,
              SUM(CASE WHEN bot = 0 THEN 1 ELSE 0 END) AS visitors,
              SUM(bot) AS bots
       FROM daily_visitors WHERE day >= ? GROUP BY day ORDER BY day`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM api_keys WHERE revoked = 0 AND created_at >= ?"
    ).bind(Date.now() - days * 86400000).first(),

    ctx.env.DB.prepare(
      `SELECT key_id, SUM(requests) AS requests
       FROM usage_bucket WHERE day >= ? AND key_id != 'anon'
       GROUP BY key_id ORDER BY requests DESC LIMIT 10`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT hour, SUM(requests) AS requests, SUM(errors) AS errors
       FROM usage_bucket WHERE day >= ? GROUP BY hour ORDER BY hour`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT country, SUM(requests) AS requests
       FROM usage_bucket WHERE day >= ? GROUP BY country ORDER BY requests DESC LIMIT 25`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT country,
              SUM(CASE WHEN bot = 0 THEN 1 ELSE 0 END) AS visitors,
              SUM(bot) AS bots
       FROM daily_visitors WHERE day >= ? GROUP BY country`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT status, path, injected, bot, SUM(count) AS count
       FROM error_bucket WHERE day >= ?
       GROUP BY status, path, injected, bot ORDER BY injected ASC, count DESC LIMIT 40`
    ).bind(since).all(),

    // Region lives on daily_visitors rather than the hot rollup, so this counts
    // people and addresses per region, not requests.
    // Blanks are grouped as Unknown rather than filtered out. Dropping them
    // makes the region rows silently fail to add up to the visitor total, and
    // a number that does not reconcile reads as a bug even when it is not.
    ctx.env.DB.prepare(
      `SELECT country, CASE WHEN region = '' THEN 'Unknown' ELSE region END AS region,
              SUM(CASE WHEN bot = 0 THEN 1 ELSE 0 END) AS visitors,
              SUM(bot) AS bots,
              COUNT(DISTINCT NULLIF(ip_hash, '')) AS addresses
       FROM daily_visitors WHERE day >= ?
       GROUP BY country, region ORDER BY visitors DESC, bots DESC LIMIT 40`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT COUNT(DISTINCT CASE WHEN bot = 0 THEN NULLIF(ip_hash, '') END) AS count,
              SUM(bot) AS bots
       FROM daily_visitors WHERE day >= ?`
    ).bind(since).first(),

    // Arrivals per hour: people, not requests, and bots excluded.
    ctx.env.DB.prepare(
      `SELECT hour, COUNT(*) AS visitors
       FROM daily_visitors WHERE day >= ? AND bot = 0 AND hour >= 0
       GROUP BY hour ORDER BY hour`
    ).bind(since).all(),
  ]);

  const rows = daily.results || [];
  const requests = rows.reduce((sum, row) => sum + (row.requests || 0), 0);
  const errors = rows.reduce((sum, row) => sum + (row.errors || 0), 0);

  // Requests and visitors per country come from different tables, so join them
  // here rather than making the dashboard do it.
  const perCountry = Object.fromEntries(
    (geoVisitors.results || []).map((row) => [row.country, row])
  );
  const countries = (geoRequests.results || []).map((row) => ({
    country: row.country,
    requests: row.requests,
    visitors: perCountry[row.country]?.visitors || 0,
    bots: perCountry[row.country]?.bots || 0,
  }));

  // Always all 24 buckets, even the empty ones — a histogram with hours missing
  // is unreadable, and the dashboard would have to backfill them anyway.
  const byHour = Object.fromEntries((hourly.results || []).map((row) => [row.hour, row]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    requests: byHour[hour]?.requests || 0,
    errors: byHour[hour]?.errors || 0,
  }));

  return json({
    window: { from: since, to: today(), days },
    totals: {
      requests,
      errors,
      errorRate: requests ? Number((errors / requests).toFixed(4)) : 0,
      // Only unrequested 5xx. A 404 for a mistyped path is the API answering
      // correctly, and counting it here would bury the one number that means
      // something is actually broken.
      serverErrors: (errors_.results || [])
        .filter((e) => !e.injected && e.status >= 500)
        .reduce((n, e) => n + e.count, 0),
      clientErrors: (errors_.results || [])
        .filter((e) => !e.injected && e.status < 500)
        .reduce((n, e) => n + e.count, 0),
      keysIssued: keys?.count || 0,
      countries: countries.length,
      // The gap between visitors and addresses answers "ten people, or one
      // person with ten tabs".
      addresses: addresses?.count || 0,
      // Counted, not hidden. Scanners hitting a new domain are normal, and
      // seeing the split is the only way to read the visitor number honestly.
      bots: addresses?.bots || 0,
    },
    daily: rows,
    visitors: visitors.results || [],
    topKeys: topKeys.results || [],
    hourly: hours, // hour is UTC; the dashboard converts to the viewer's zone
    hourlyVisitors: (() => {
      const byHour = Object.fromEntries((arrivals.results || []).map((r) => [r.hour, r.visitors]));
      return Array.from({ length: 24 }, (_, hour) => ({ hour, visitors: byHour[hour] || 0 }));
    })(),
    countries,
    // What the error rate is actually made of.
    errors: errors_.results || [],
    regions: regions.results || [],
  });
}

// GET /v1/admin/insights?days=14
//
// Separate from /stats on purpose: stats answers "how is it going", insights
// answers "what should I change". Different questions, different page, and no
// reason to make the dashboard pay for queries it does not render.
export async function getInsights(ctx) {
  if (!authorised(ctx.request, ctx.env)) {
    return fail(401, "Admin token required", "Send Authorization: Bearer <ADMIN_TOKEN>.");
  }

  const days = Math.min(Math.max(Number(ctx.query.get("days")) || 14, 1), 90);
  const since = daysAgo(days);

  const [paths, referrers, chaos, slowest, retention, frequency, dwell] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT path, SUM(requests) AS requests, SUM(sum_ms) AS sum_ms, MAX(max_ms) AS max_ms
       FROM path_bucket WHERE day >= ? GROUP BY path ORDER BY requests DESC LIMIT 25`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT referrer, SUM(requests) AS requests
       FROM referrer_bucket WHERE day >= ? GROUP BY referrer ORDER BY requests DESC LIMIT 25`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT SUM(requests) AS requests, SUM(with_delay) AS delay,
              SUM(with_status) AS status, SUM(with_fail_rate) AS fail_rate,
              SUM(onsite) AS onsite, SUM(onsite_chaos) AS onsite_chaos,
              SUM(bot_requests) AS bot_requests, SUM(bot_chaos) AS bot_chaos
       FROM path_bucket WHERE day >= ?`
    ).bind(since).first(),

    // Mean hides the tail, so rank by the worst single response rather than the
    // average — that is where a real problem shows first.
    ctx.env.DB.prepare(
      `SELECT path, MAX(max_ms) AS max_ms, SUM(sum_ms) / SUM(requests) AS avg_ms, SUM(requests) AS requests
       FROM path_bucket WHERE day >= ? GROUP BY path
       HAVING requests > 0 ORDER BY max_ms DESC LIMIT 10`
    ).bind(since).all(),

    // New vs returning today. "Returning" means this visitor hash was also seen
    // on an earlier day — see the caveat in the README about hashes changing
    // when someone's address does.
    ctx.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN prior.visitor IS NULL THEN 1 ELSE 0 END) AS fresh,
         -- Not aliased "returning": that is a reserved word in SQLite (the
         -- RETURNING clause) and breaks the parse.
         SUM(CASE WHEN prior.visitor IS NOT NULL THEN 1 ELSE 0 END) AS came_back
       FROM (SELECT DISTINCT visitor FROM daily_visitors WHERE day = ? AND bot = 0) t
       LEFT JOIN (SELECT DISTINCT visitor FROM daily_visitors WHERE day < ? AND bot = 0) prior
         ON prior.visitor = t.visitor`
    ).bind(today(), today()).first(),

    // How many separate days each person showed up across the window.
    ctx.env.DB.prepare(
      `SELECT days, COUNT(*) AS people FROM (
         SELECT visitor, COUNT(DISTINCT day) AS days
         FROM daily_visitors WHERE day >= ? AND bot = 0 GROUP BY visitor
       ) GROUP BY days ORDER BY days`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT path, SUM(visits) AS visits, SUM(sum_seconds) AS sum_seconds,
              MAX(max_seconds) AS max_seconds, SUM(bounced) AS bounced
       FROM page_time WHERE day >= ? GROUP BY path ORDER BY visits DESC LIMIT 10`
    ).bind(since).all(),
  ]);

  const rows = (paths.results || []).map((r) => ({
    path: r.path,
    requests: r.requests,
    avgMs: r.requests ? Math.round(r.sum_ms / r.requests) : 0,
    maxMs: r.max_ms,
  }));

  const total = chaos?.requests || 0;
  return json({
    window: { from: since, to: today(), days },
    paths: rows,
    referrers: referrers.results || [],
    slowest: slowest.results || [],
    returning: {
      today: { new: retention?.fresh || 0, returning: retention?.came_back || 0 },
      // [{days, people}] — people who appeared on exactly that many days.
      frequency: frequency.results || [],
    },
    dwell: (dwell.results || []).map((r) => ({
      path: r.path,
      visits: r.visits,
      avgSeconds: r.visits ? Math.round(r.sum_seconds / r.visits) : 0,
      maxSeconds: r.max_seconds,
      bounceRate: r.visits ? Number((r.bounced / r.visits).toFixed(3)) : 0,
    })),
    // The product question, as a number: what share of traffic reaches for the
    // thing that makes this different from every other mock API.
    chaos: (() => {
      const used = (chaos?.delay || 0) + (chaos?.status || 0) + (chaos?.fail_rate || 0);
      const onsite = chaos?.onsite || 0;
      const onsiteChaos = chaos?.onsite_chaos || 0;
      // The figure that matters is the one excluding our own try-it widget:
      // clicking Send on the landing page is not someone adopting the feature.
      // Neither our own widget nor anything automated. Test scripts run from
      // curl, which is a bot, and counting them made a test suite look like
      // adoption.
      const botReq = chaos?.bot_requests || 0;
      const botChaos = chaos?.bot_chaos || 0;
      const extRequests = Math.max(0, total - onsite - botReq);
      const extUsed = Math.max(0, used - onsiteChaos - botChaos);
      return {
        requests: total,
        delay: chaos?.delay || 0,
        status: chaos?.status || 0,
        failRate: chaos?.fail_rate || 0,
        anyShare: total ? Number((used / total).toFixed(4)) : 0,
        onsite,
        bots: botReq,
        externalRequests: extRequests,
        externalShare: extRequests ? Number((extUsed / extRequests).toFixed(4)) : 0,
      };
    })(),
  });
}

// --- CSV export ------------------------------------------------------------
//
// One dataset per file rather than one endpoint returning everything, because
// a spreadsheet holds one table. Each entry declares its SQL and its column
// order together, so adding an export is one entry and nothing else.
//
// Hours stay UTC in the file. The dashboard converts for display, but a shifted
// number in a spreadsheet with no timezone recorded alongside it is a trap, so
// the column is named for what it holds.

const REGION = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
})();

const countryName = (code) => {
  if (!/^[A-Za-z]{2}$/.test(code || "") || code.toUpperCase() === "XX") return "Unknown";
  try { return REGION?.of(code.toUpperCase()) || code.toUpperCase(); } catch { return code.toUpperCase(); }
};

const DATASETS = {
  daily: {
    sql: `SELECT day, SUM(requests) AS requests, SUM(errors) AS errors
          FROM usage_bucket WHERE day >= ? GROUP BY day ORDER BY day`,
    columns: [["day", "day"], ["requests", "requests"], ["errors", "errors"]],
  },
  hourly: {
    sql: `SELECT hour, SUM(requests) AS requests, SUM(errors) AS errors
          FROM usage_bucket WHERE day >= ? GROUP BY hour ORDER BY hour`,
    columns: [["hour_utc", "hour"], ["requests", "requests"], ["errors", "errors"]],
  },
  countries: {
    sql: `SELECT g.country AS country, SUM(g.requests) AS requests,
                 (SELECT COUNT(*) FROM daily_visitors v WHERE v.day >= ? AND v.country = g.country) AS visitors
          FROM usage_bucket g WHERE g.day >= ? GROUP BY g.country ORDER BY requests DESC`,
    binds: 2,
    columns: [["country_code", "country"], ["country", "name"], ["visitors", "visitors"], ["requests", "requests"]],
    decorate: (rows) => rows.map((row) => ({ ...row, name: countryName(row.country) })),
  },
  visitors: {
    sql: `SELECT day,
                 SUM(CASE WHEN bot = 0 THEN 1 ELSE 0 END) AS visitors,
                 SUM(bot) AS bots
          FROM daily_visitors WHERE day >= ? GROUP BY day ORDER BY day`,
    columns: [["day", "day"], ["visitors", "visitors"], ["bots", "bots"]],
  },
  regions: {
    sql: `SELECT country, CASE WHEN region = '' THEN 'Unknown' ELSE region END AS region,
                 COUNT(*) AS visitors, COUNT(DISTINCT NULLIF(ip_hash, '')) AS addresses
          FROM daily_visitors WHERE day >= ? AND bot = 0
          GROUP BY country, region ORDER BY visitors DESC`,
    columns: [["country_code", "country"], ["region", "region"], ["visitors", "visitors"], ["addresses", "addresses"]],
  },
  paths: {
    sql: `SELECT day, path, SUM(requests) AS requests, SUM(sum_ms)/SUM(requests) AS avg_ms,
                 MAX(max_ms) AS max_ms, SUM(with_delay) AS with_delay,
                 SUM(with_status) AS with_status, SUM(with_fail_rate) AS with_fail_rate
          FROM path_bucket WHERE day >= ? GROUP BY day, path ORDER BY day, requests DESC`,
    columns: [["day","day"],["path","path"],["requests","requests"],["avg_ms","avg_ms"],["max_ms","max_ms"],
              ["with_delay","with_delay"],["with_status","with_status"],["with_fail_rate","with_fail_rate"]],
  },
  referrers: {
    sql: `SELECT day, referrer, SUM(requests) AS requests
          FROM referrer_bucket WHERE day >= ? GROUP BY day, referrer ORDER BY day, requests DESC`,
    columns: [["day","day"],["referrer","referrer"],["requests","requests"]],
  },
  errors: {
    sql: `SELECT day, status, path, injected, bot, SUM(count) AS count
          FROM error_bucket WHERE day >= ?
          GROUP BY day, status, path, injected, bot ORDER BY day, injected, count DESC`,
    columns: [["day","day"],["status","status"],["path","path"],["requested","injected"],["bot","bot"],["count","count"]],
  },
  keys: {
    sql: `SELECT key_id, tier, SUM(requests) AS requests, SUM(errors) AS errors
          FROM usage_bucket WHERE day >= ? AND key_id != 'anon'
          GROUP BY key_id, tier ORDER BY requests DESC`,
    columns: [["key_id", "key_id"], ["tier", "tier"], ["requests", "requests"], ["errors", "errors"]],
  },
};

// GET /v1/admin/export?dataset=daily&days=30
export async function exportCsv(ctx) {
  if (!authorised(ctx.request, ctx.env)) {
    return fail(401, "Admin token required", "Send Authorization: Bearer <ADMIN_TOKEN>.");
  }

  const name = ctx.query.get("dataset") || "daily";
  const spec = DATASETS[name];
  if (!spec) {
    return fail(400, `Unknown dataset '${echo(name)}'`, `Available: ${Object.keys(DATASETS).join(", ")}.`);
  }

  const days = Math.min(Math.max(Number(ctx.query.get("days")) || 30, 1), 365);
  const since = daysAgo(days);

  const binds = Array.from({ length: spec.binds || 1 }, () => since);
  const result = await ctx.env.DB.prepare(spec.sql).bind(...binds).all();
  const rows = spec.decorate ? spec.decorate(result.results || []) : result.results || [];

  return csvResponse(toCsv(rows, spec.columns), `flaky-${name}-${today()}.csv`);
}
