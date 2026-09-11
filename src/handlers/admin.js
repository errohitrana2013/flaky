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

  const [daily, visitors, keys, topKeys, hourly, geoRequests, geoVisitors, errors_, errorSums, regions, addresses, arrivals] = await Promise.all([
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

    // Totals over every error, not a sum of the 40 rows above. The list sorts
    // requested failures last, so once scanners filled it none of them were
    // listed, and summing it reported "requested 0" beside 182 of them — and a
    // server-error figure that could only ever undercount.
    ctx.env.DB.prepare(
      `SELECT COUNT(*) AS kinds, SUM(count) AS total,
              SUM(CASE WHEN injected = 1 THEN count ELSE 0 END) AS requested,
              SUM(CASE WHEN injected = 0 AND status >= 500 THEN count ELSE 0 END) AS server,
              SUM(CASE WHEN injected = 0 AND status < 500 THEN count ELSE 0 END) AS client,
              SUM(CASE WHEN bot = 1 THEN count ELSE 0 END) AS bots
       FROM (SELECT status, injected, bot, SUM(count) AS count
             FROM error_bucket WHERE day >= ? GROUP BY status, path, injected, bot)`
    ).bind(since).first(),

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
      serverErrors: errorSums?.server || 0,
      clientErrors: errorSums?.client || 0,
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
    // What the error rate is actually made of: the 40 biggest kinds, then totals
    // over all of them, which the list alone cannot give.
    errors: errors_.results || [],
    errorTotals: {
      kinds: errorSums?.kinds || 0,
      total: errorSums?.total || 0,
      requested: errorSums?.requested || 0,
      server: errorSums?.server || 0,
      client: errorSums?.client || 0,
      bots: errorSums?.bots || 0,
    },
    regions: regions.results || [],
  });
}

// Visitors who are not people, judged by what they did rather than what their
// user-agent claimed. Either every request they made failed — a crawler walking
// a list of paths that do not exist here, which nobody who found the site does —
// or they used the admin pages, which is the owner, from before 7 Sept when
// admin requests still reached the trail. Five and two of the 39 who came back.
//
// Only a visitor with a trail can be judged. Anyone seen before trails began is
// kept, because nothing says they were not a person.
const NOT_PEOPLE = `SELECT visitor FROM visitor_path WHERE day >= ?
                    GROUP BY visitor
                    HAVING SUM(errors) >= SUM(requests) OR SUM(path LIKE '/v1/admin%') > 0`;

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
              SUM(with_scenario) AS scenario, SUM(with_malformed) AS malformed,
              SUM(with_any) AS any_chaos,
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
       FROM (SELECT DISTINCT visitor FROM daily_visitors
             WHERE day = ? AND bot = 0 AND visitor NOT IN (${NOT_PEOPLE})) t
       LEFT JOIN (SELECT DISTINCT visitor FROM daily_visitors WHERE day < ? AND bot = 0) prior
         ON prior.visitor = t.visitor`
    ).bind(today(), since, today()).first(),

    // How many separate days each person showed up across the window.
    ctx.env.DB.prepare(
      `SELECT days, COUNT(*) AS people FROM (
         SELECT visitor, COUNT(DISTINCT day) AS days
         FROM daily_visitors WHERE day >= ? AND bot = 0 AND visitor NOT IN (${NOT_PEOPLE})
         GROUP BY visitor
       ) GROUP BY days ORDER BY days`
    ).bind(since, since).all(),

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
      // One per request, not the sum of the per-control columns — a request
      // asking for a slow failure carries two of them and is still one request.
      const used = chaos?.any_chaos || 0;
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
        scenario: chaos?.scenario || 0,
        malformed: chaos?.malformed || 0,
        anyShare: total ? Number((used / total).toFixed(4)) : 0,
        onsite,
        bots: botReq,
        externalRequests: extRequests,
        externalShare: extRequests ? Number((extUsed / extRequests).toFixed(4)) : 0,
      };
    })(),
  });
}

// --- Custom APIs -----------------------------------------------------------
//
// The live contents of /custom: who created what, and the JSON itself.
//
// Only the ones still inside their 24 hours, because that is the whole life of
// the row — the nightly purge deletes the rest, and listing a body that is
// about to disappear invites acting on it. This reads `custom_apis` directly
// rather than a rollup: there are at most a few dozen live at a time, and a
// summary of them would answer none of the questions worth asking.

// GET /v1/admin/custom
export async function listCustom(ctx) {
  if (!authorised(ctx.request, ctx.env)) {
    return fail(401, "Admin token required", "Send Authorization: Bearer <ADMIN_TOKEN>.");
  }

  // Never the body. A listing that carries every stored document is megabytes
  // of payload for a table that shows none of it.
  //
  // is_sample = 0 drops the pastes that are the built-in example unchanged.
  // Clicking "Use an example" and then Create is the most common thing that
  // happens on that page and tells us nothing, so it would crowd out the rows
  // that do. They are counted below rather than disappearing — a filtered table
  // that does not admit to filtering is how you end up trusting a wrong number.
  const [{ results = [] }, counts] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT id, bytes, created_at, expires_at, country, region, resources
       FROM custom_apis WHERE expires_at > ? AND is_sample = 0
       ORDER BY created_at DESC LIMIT 200`
    ).bind(Date.now()).all(),

    ctx.env.DB.prepare(
      `SELECT COUNT(*) AS live, SUM(is_sample) AS samples
       FROM custom_apis WHERE expires_at > ?`
    ).bind(Date.now()).first(),
  ]);

  return json({
    live: results.length,
    // Everything alive right now, and how much of it was the example.
    liveIncludingSamples: counts?.live || 0,
    samplesHidden: counts?.samples || 0,
    apis: results.map((row) => ({
      id: row.id,
      bytes: row.bytes,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      country: row.country || "XX",
      countryName: countryName(row.country),
      region: row.region || "",
      // "todos:3,users:2" as it was stored. Rows created before the column
      // existed have nothing to report rather than a wrong answer.
      resources: row.resources
        ? row.resources.split(",").map((part) => {
            const at = part.lastIndexOf(":");
            return { name: part.slice(0, at), count: Number(part.slice(at + 1)) || 0 };
          })
        : [],
    })),
  });
}

// GET /v1/admin/custom/:id
export async function readCustomBody(ctx) {
  if (!authorised(ctx.request, ctx.env)) {
    return fail(401, "Admin token required", "Send Authorization: Bearer <ADMIN_TOKEN>.");
  }

  const { id } = ctx.params;
  if (!/^[0-9a-f]{16}$/.test(id || "")) {
    return fail(400, "Not an API id", "Ids are 16 hex characters.");
  }

  const row = await ctx.env.DB.prepare(
    "SELECT body, bytes, created_at, expires_at, country, region FROM custom_apis WHERE id = ?"
  ).bind(id).first();

  if (!row) return fail(404, "No such API", "It may have expired and been purged.");

  // The stored document verbatim, not re-serialised — what the caller pasted is
  // the thing worth looking at, down to the key order.
  return json({
    id,
    bytes: row.bytes,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    expired: row.expires_at <= Date.now(),
    country: row.country || "XX",
    countryName: countryName(row.country),
    region: row.region || "",
    body: JSON.parse(row.body),
  });
}

// --- Returning people ------------------------------------------------------
//
// The frequency table on /insights says how many people came back and nothing
// else about them. This is the row behind the number: who each of them was,
// coarsely, and what they actually did across the window.
//
// Only people who came back. Somebody who arrived once and left is the bulk of
// every day's traffic and there is nothing to learn from listing them
// individually — the interesting population is the handful who chose to return,
// and it is small enough to show one row per person rather than a summary.

// GET /v1/admin/returning?days=30&min=2
export async function getReturning(ctx) {
  if (!authorised(ctx.request, ctx.env)) {
    return fail(401, "Admin token required", "Send Authorization: Bearer <ADMIN_TOKEN>.");
  }

  const days = Math.min(Math.max(Number(ctx.query.get("days")) || 30, 1), 90);
  // Never below 2. This endpoint exists for people who came back, and dropping
  // the floor to 1 would turn it into a list of every visitor with their
  // browsing attached — a different thing entirely, and not one the privacy
  // page describes.
  const min = Math.min(Math.max(Number(ctx.query.get("min")) || 2, 2), 90);
  const since = daysAgo(days);

  // The cohort, defined once and used by both queries: non-bots seen on at
  // least `min` separate days inside the window.
  const cohort = `SELECT visitor, COUNT(DISTINCT day) AS days,
                         MIN(day) AS first_day, MAX(day) AS last_day
                  FROM daily_visitors
                  WHERE day >= ? AND bot = 0 AND visitor NOT IN (${NOT_PEOPLE})
                  GROUP BY visitor
                  HAVING days >= ?`;

  const [people, trails, trailStart] = await Promise.all([
    // Joined back to the visitor's *first* day, so country, region and hour are
    // where they arrived from rather than an arbitrary row — the same meaning
    // those columns carry everywhere else.
    ctx.env.DB.prepare(
      `SELECT c.visitor, c.days, c.first_day, c.last_day, v.country, v.region, v.hour
       FROM (${cohort}) c
       JOIN daily_visitors v ON v.visitor = c.visitor AND v.day = c.first_day
       ORDER BY c.days DESC, c.last_day DESC
       LIMIT 200`
    ).bind(since, since, min).all(),

    // Their trails, in one round trip rather than one query per person.
    ctx.env.DB.prepare(
      `SELECT vp.visitor, vp.path,
              SUM(vp.requests) AS requests, SUM(vp.chaos) AS chaos, SUM(vp.errors) AS errors
       FROM visitor_path vp
       JOIN (${cohort}) c ON c.visitor = vp.visitor
       WHERE vp.day >= ?
       GROUP BY vp.visitor, vp.path
       ORDER BY requests DESC
       LIMIT 2000`
    ).bind(since, since, min, since).all(),

    // The first day anything was recorded. Trails began when 0020 shipped, so
    // for a while the window reaches back further than the data does — and a
    // person with an empty trail has to read as "not recorded yet" rather than
    // as "did nothing", which is what an empty list looks like.
    ctx.env.DB.prepare("SELECT MIN(day) AS from_day FROM visitor_path").first(),
  ]);

  const byVisitor = new Map();
  for (const row of trails.results || []) {
    if (!byVisitor.has(row.visitor)) byVisitor.set(row.visitor, []);
    byVisitor.get(row.visitor).push({
      path: row.path,
      requests: row.requests,
      chaos: row.chaos,
      errors: row.errors,
    });
  }

  return json({
    window: { from: since, to: today(), days },
    min,
    // null until the first request lands after 0020.
    trailsFrom: trailStart?.from_day || null,
    // The hash itself never leaves the server. It is a stable pseudonym and
    // there is no reason for a browser to hold one; the index is enough to tell
    // two rows apart, which is all the page does with it.
    people: (people.results || []).map((row, i) => {
      const paths = byVisitor.get(row.visitor) || [];
      return {
        n: i + 1,
        days: row.days,
        firstDay: row.first_day,
        lastDay: row.last_day,
        country: row.country || "XX",
        countryName: countryName(row.country),
        region: row.region || "",
        // -1 means the row predates the hour column; the page shows a dash.
        hour: row.hour,
        requests: paths.reduce((n, p) => n + p.requests, 0),
        chaos: paths.reduce((n, p) => n + p.chaos, 0),
        errors: paths.reduce((n, p) => n + p.errors, 0),
        paths,
      };
    }),
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
                 SUM(with_status) AS with_status, SUM(with_fail_rate) AS with_fail_rate,
                 SUM(with_scenario) AS with_scenario, SUM(with_malformed) AS with_malformed,
                 SUM(with_any) AS with_any
          FROM path_bucket WHERE day >= ? GROUP BY day, path ORDER BY day, requests DESC`,
    columns: [["day","day"],["path","path"],["requests","requests"],["avg_ms","avg_ms"],["max_ms","max_ms"],
              ["with_delay","with_delay"],["with_status","with_status"],["with_fail_rate","with_fail_rate"],
              ["with_scenario","with_scenario"],["with_malformed","with_malformed"],["with_any","with_any"]],
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
