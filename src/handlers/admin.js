import { json, fail } from "../lib/response.js";
import { daysAgo, today } from "../lib/hash.js";

// Reads the D1 rollups, never the raw request log. The dashboard has to stay
// fast and free, and Analytics Engine is for ad-hoc SQL when a question comes
// up that the rollups cannot answer.
//
// This route bypasses the tier and rate-limit pipeline (router.js marks it
// auth: "admin"), so it does its own check first and ctx.auth is null here.

function authorised(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return Boolean(env.ADMIN_TOKEN) && token === env.ADMIN_TOKEN;
}

// GET /v1/admin/stats?days=14
export async function getStats(ctx) {
  if (!authorised(ctx.request, ctx.env)) {
    return fail(401, "Admin token required", "Send Authorization: Bearer <ADMIN_TOKEN>.");
  }

  const days = Math.min(Math.max(Number(ctx.query.get("days")) || 14, 1), 90);
  const since = daysAgo(days);

  const [daily, visitors, keys, topKeys] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT day, SUM(requests) AS requests, SUM(errors) AS errors
       FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day`
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
       FROM usage_daily WHERE day >= ? AND key_id != 'anon'
       GROUP BY key_id ORDER BY requests DESC LIMIT 10`
    ).bind(since).all(),
  ]);

  const rows = daily.results || [];
  const requests = rows.reduce((sum, row) => sum + (row.requests || 0), 0);
  const errors = rows.reduce((sum, row) => sum + (row.errors || 0), 0);

  return json({
    window: { from: since, to: today(), days },
    totals: {
      requests,
      errors,
      errorRate: requests ? Number((errors / requests).toFixed(4)) : 0,
      keysIssued: keys?.count || 0,
    },
    daily: rows,
    visitors: visitors.results || [],
    topKeys: topKeys.results || [],
  });
}
