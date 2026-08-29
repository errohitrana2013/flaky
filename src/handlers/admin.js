import { json, fail } from "../lib/response.js";
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

  const [daily, visitors, keys, topKeys, hourly, geoRequests, geoVisitors] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT day, SUM(requests) AS requests, SUM(errors) AS errors
       FROM usage_bucket WHERE day >= ? GROUP BY day ORDER BY day`
    ).bind(since).all(),

    ctx.env.DB.prepare(
      `SELECT day, COUNT(*) AS visitors
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
      `SELECT country, COUNT(*) AS visitors
       FROM daily_visitors WHERE day >= ? GROUP BY country`
    ).bind(since).all(),
  ]);

  const rows = daily.results || [];
  const requests = rows.reduce((sum, row) => sum + (row.requests || 0), 0);
  const errors = rows.reduce((sum, row) => sum + (row.errors || 0), 0);

  // Requests and visitors per country come from different tables, so join them
  // here rather than making the dashboard do it.
  const visitorsPerCountry = Object.fromEntries(
    (geoVisitors.results || []).map((row) => [row.country, row.visitors])
  );
  const countries = (geoRequests.results || []).map((row) => ({
    country: row.country,
    requests: row.requests,
    visitors: visitorsPerCountry[row.country] || 0,
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
      keysIssued: keys?.count || 0,
      countries: countries.length,
    },
    daily: rows,
    visitors: visitors.results || [],
    topKeys: topKeys.results || [],
    hourly: hours, // hour is UTC; the dashboard converts to the viewer's zone
    countries,
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
    sql: `SELECT day, COUNT(*) AS visitors FROM daily_visitors
          WHERE day >= ? GROUP BY day ORDER BY day`,
    columns: [["day", "day"], ["visitors", "visitors"]],
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
    return fail(400, `Unknown dataset '${name}'`, `Available: ${Object.keys(DATASETS).join(", ")}.`);
  }

  const days = Math.min(Math.max(Number(ctx.query.get("days")) || 30, 1), 365);
  const since = daysAgo(days);

  const binds = Array.from({ length: spec.binds || 1 }, () => since);
  const result = await ctx.env.DB.prepare(spec.sql).bind(...binds).all();
  const rows = spec.decorate ? spec.decorate(result.results || []) : result.results || [];

  return csvResponse(toCsv(rows, spec.columns), `flaky-${name}-${today()}.csv`);
}
