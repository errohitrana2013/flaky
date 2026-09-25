// Run with: npm test
// Uses node:test — no dependencies. Env bindings are stubbed in memory so the
// whole suite runs offline in under a second.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { isProbe } from "../src/middleware/analytics.js";

function makeEnv({ keys = [], sandboxes = [], records = [], customs = [], scenario = null, cohort = [], trails = [], dayErrors = [] } = {}) {
  const kv = new Map();
  const points = [];

  const query = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, tier, revoked FROM api_keys")) return keys.find((k) => k.key === args[0]) || null;
    if (s.startsWith("SELECT key FROM api_keys")) return keys.find((k) => k.email === args[0]) || null;
    if (s.startsWith("SELECT COUNT(*) AS count FROM sandboxes")) return { count: sandboxes.filter((b) => b.key_id === args[0]).length };
    if (s.startsWith("SELECT id, expires_at FROM sandboxes")) return sandboxes.find((b) => b.id === args[0]) || null;
    if (s.startsWith("SELECT body FROM sandbox_records")) return records.find((r) => r.record_id === String(args[2])) || null;
    if (s.startsWith("SELECT body, expires_at FROM custom_apis")) return customs.find((c) => c.id === args[0]) || null;
    if (s.startsWith("SELECT body, bytes, created_at, expires_at, country, region FROM custom_apis")) {
      return customs.find((c) => c.id === args[0]) || null;
    }
    if (s.startsWith("SELECT COUNT(*) AS live, SUM(is_sample) AS samples FROM custom_apis")) {
      const live = customs.filter((c) => c.expires_at > Date.now());
      return { live: live.length, samples: live.filter((c) => c.is_sample).length };
    }
    if (s.includes("MIN(day) AS from_day")) return { from_day: "2026-09-01" };
    // One day's error detail: the rows, and the totals over every one of them.
    if (s.includes("FROM error_bucket WHERE day = ?")) {
      const rows = dayErrors.filter((e) => e.day === args[0]);
      if (!s.includes("COUNT(*) AS kinds")) return null;
      return {
        kinds: rows.length,
        total: rows.reduce((n, e) => n + e.count, 0),
        requested: rows.filter((e) => e.injected).reduce((n, e) => n + e.count, 0),
        server: rows.filter((e) => !e.injected && e.status >= 500).reduce((n, e) => n + e.count, 0),
        bots: rows.filter((e) => e.bot).reduce((n, e) => n + e.count, 0),
      };
    }
    if (s.startsWith("SELECT fail_count, status, invert, attempts, expires_at FROM scenarios")) return scenario;
    // The counter advances in the same statement that reads it.
    if (s.startsWith("UPDATE scenarios SET attempts = attempts + 1")) {
      if (!scenario || scenario.expires_at < Date.now()) return null;
      scenario.attempts += 1;
      return { attempts: scenario.attempts, fail_count: scenario.fail_count, status: scenario.status, invert: scenario.invert ?? 0 };
    }
    if (s.startsWith("UPDATE scenarios SET attempts = 0")) {
      if (!scenario) return null;
      scenario.attempts = 0;
      return { fail_count: scenario.fail_count, status: scenario.status, invert: scenario.invert ?? 0 };
    }
    return null;
  };

  // Every statement the rollup prepares, so a test can assert on what was
  // written rather than only on what was returned. The dashboard is downstream
  // of these rows and nothing else could see them.
  const writes = [];

  return {
    _points: points,
    _writes: writes,
    VISITOR_SALT: "test-salt",
    ADMIN_TOKEN: "admin-token",
    ASSETS: { fetch: async () => new Response("landing page") },
    ANALYTICS: { writeDataPoint: (p) => points.push(p) },
    RATE_LIMITS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
    DB: {
      prepare: (sql) => ({
        // Real D1 lets a statement with no placeholders skip bind() entirely.
        first: async () => query(sql, []),
        all: async () => ({ results: [] }),
        bind: (...args) => ({
          _sql: sql.replace(/\s+/g, " ").trim(),
          _args: args,
          first: async () => query(sql, args),
          // Statements run on their own, not in a batch — the custom-API insert
          // is the one that matters here.
          run: async function () { writes.push(this); return { success: true }; },
          all: async () => {
            if (sql.includes("sandbox_records")) return { results: records };
            // The admin listing asks for the live ones only; the stub applies
            // the same cutoff so an expired fixture cannot pass by accident.
            // The two halves of /v1/admin/returning: the people, then their paths.
            if (sql.includes("JOIN daily_visitors v")) return { results: cohort };
            if (sql.includes("FROM visitor_path vp")) return { results: trails };
            if (sql.includes("FROM error_bucket WHERE day = ?")) {
              return { results: dayErrors.filter((e) => e.day === args[0]) };
            }
            if (sql.includes("FROM custom_apis")) {
              const live = customs.filter((c) => c.expires_at > Date.now());
              // The listing asks for is_sample = 0; the counting query does not.
              return { results: sql.includes("is_sample = 0") ? live.filter((c) => !c.is_sample) : live };
            }
            return { results: [] };
          },
        }),
      }),
      batch: async (statements) => {
        writes.push(...statements);
        return [];
      },
    },
  };
}

const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const call = (path, init = {}, env = makeEnv()) =>
  worker.fetch(new Request("https://flaky.test" + path, init), env, ctx);

const body = async (res) => JSON.parse(await res.text());

test("lists a collection with pagination headers", async () => {
  const res = await call("/v1/posts?_limit=5");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-total-count"), "100");
  assert.equal((await body(res)).length, 5);
});

test("fetches one record", async () => {
  const post = await body(await call("/v1/posts/1"));
  assert.equal(post.id, 1);
});

test("serves nested relations", async () => {
  const comments = await body(await call("/v1/posts/1/comments"));
  assert.ok(comments.length > 0);
  assert.ok(comments.every((c) => c.postId === 1));
});

test("rejects an unknown nested route with a hint", async () => {
  const res = await call("/v1/posts/1/nonsense");
  assert.equal(res.status, 404);
  assert.match((await body(res)).error.hint, /Known nested routes/);
});

test("filters by field", async () => {
  const todos = await body(await call("/v1/todos?userId=3&_limit=100"));
  assert.ok(todos.every((t) => t.userId === 3));
});

test("sorts descending", async () => {
  const products = await body(await call("/v1/products?_sort=price&_order=desc&_limit=5"));
  const prices = products.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
});

test("caps page size at the tier limit", async () => {
  const rows = await body(await call("/v1/photos?_limit=9999"));
  assert.equal(rows.length, 100); // anonymous maxLimit
});

test("forces the requested status code", async () => {
  const res = await call("/v1/posts?_status=503");
  assert.equal(res.status, 503);
  assert.match((await body(res)).error.hint, /_status=503/);
});

test("honours an injected delay", async () => {
  const started = Date.now();
  await call("/v1/posts?_delay=300");
  assert.ok(Date.now() - started >= 300);
});

test("fails every request at a failure rate of 1", async () => {
  const res = await call("/v1/posts?_fail_rate=1");
  assert.equal(res.status, 500);
});

// A chaos parameter that is ignored is worse than one that errors: someone
// testing a retry path would get a 200 and a green test for the wrong reason.
test("rejects an out-of-range _fail_rate instead of always failing", async () => {
  const res = await call("/v1/posts?_fail_rate=2");
  assert.equal(res.status, 400);
  assert.match((await body(res)).error.hint, /probability from 0 to 1/);
});

test("rejects an out-of-range _status instead of returning 200", async () => {
  const res = await call("/v1/posts?_status=999");
  assert.equal(res.status, 400);
  assert.match((await body(res)).error.hint, /100 to 599/);
});

test("rejects a _delay beyond the cap instead of silently clamping", async () => {
  const res = await call("/v1/posts?_delay=99999");
  assert.equal(res.status, 400);
  assert.match((await body(res)).error.hint, /0 to 10000/);
});

test("rejects non-numeric and negative chaos parameters", async () => {
  for (const query of ["_delay=abc", "_delay=-500", "_fail_rate=abc", "_fail_rate=-1", "_status=abc", "_status=503.5"]) {
    assert.equal((await call(`/v1/posts?${query}`)).status, 400, `${query} should be a 400`);
  }
});

test("treats an empty chaos parameter as absent", async () => {
  const res = await call("/v1/posts?_status=&_delay=&_fail_rate=&_limit=1");
  assert.equal(res.status, 200);
});

test("validates every parameter before acting on any of them", async () => {
  // A valid _delay must not be served before an invalid _status is caught.
  const started = Date.now();
  const res = await call("/v1/posts?_delay=2000&_status=999");
  assert.equal(res.status, 400);
  assert.ok(Date.now() - started < 500, "rejected without sitting through the delay");
});

test("_status=200 is valid and means behave normally", async () => {
  const res = await call("/v1/posts?_status=200&_limit=1");
  assert.equal(res.status, 200);
  assert.equal((await body(res)).length, 1);
});

test("echoes writes without persisting them", async () => {
  const res = await call("/v1/posts", { method: "POST", body: JSON.stringify({ title: "hello" }) });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("x-mock-write"), "not-persisted; use /v1/sandbox for real writes");
  assert.equal((await body(res)).title, "hello");
});

test("echoes PUT, PATCH and DELETE on one record", async () => {
  const original = await body(await call("/v1/posts/1"));

  const put = await call("/v1/posts/1", { method: "PUT", body: JSON.stringify({ title: "replaced" }) });
  assert.equal(put.status, 200);
  assert.equal(put.headers.get("x-mock-write"), "not-persisted; use /v1/sandbox for real writes");
  // PUT replaces the whole record, so the fields it did not send are gone...
  assert.deepEqual(await body(put), { id: 1, title: "replaced" });

  // ...and PATCH merges, so they stay.
  const patched = await body(await call("/v1/posts/1", { method: "PATCH", body: JSON.stringify({ title: "patched" }) }));
  assert.equal(patched.title, "patched");
  assert.equal(patched.userId, original.userId);

  const del = await call("/v1/posts/1", { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.deepEqual(await body(del), { deleted: true, id: 1 });
});

test("creates a record under its parent, taking the parent from the path", async () => {
  // The body claims post 99; the path says post 1, and the path wins.
  const res = await call("/v1/posts/1/comments", { method: "POST", body: JSON.stringify({ body: "hi", postId: 99 }) });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("x-mock-write"), "not-persisted; use /v1/sandbox for real writes");
  const comment = await body(res);
  assert.equal(comment.postId, 1);
  assert.equal(comment.body, "hi");
  assert.equal(comment.id, 501);

  assert.equal((await call("/v1/posts/99999/comments", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await call("/v1/posts/1/nonsense", { method: "POST", body: "{}" })).status, 404);
});

test("a write aimed at the wrong kind of path is a 405 that names the right one", async () => {
  // PUT on a collection used to be a 404 "No posts with id (empty)", and DELETE
  // on one answered 200 having deleted nothing.
  const put = await call("/v1/posts", { method: "PUT", body: "{}" });
  assert.equal(put.status, 405);
  assert.equal(put.headers.get("allow"), "GET, POST");
  assert.match((await body(put)).error.hint, /PUT \/v1\/posts\/1\./);

  assert.equal((await call("/v1/posts", { method: "DELETE" })).status, 405);

  const post = await call("/v1/posts/1", { method: "POST", body: "{}" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, PUT, PATCH, DELETE");
  assert.match((await body(post)).error.hint, /POST \/v1\/posts\./);

  const nested = await call("/v1/posts/1/comments", { method: "DELETE" });
  assert.equal(nested.status, 405);
  assert.equal(nested.headers.get("allow"), "GET, POST");
  assert.match((await body(nested)).error.hint, /DELETE \/v1\/comments\/1\./);
});

test("a sandbox takes nested writes and lists them under their parent", async () => {
  const sandboxes = [{ id: "live", key_id: "k1", expires_at: Date.now() + 60000 }];

  const created = await call(
    "/v1/sandbox/live/users/1/todos",
    { method: "POST", body: JSON.stringify({ title: "mine", userId: 7 }) },
    makeEnv({ sandboxes })
  );
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("x-mock-write"), null, "a sandbox write is stored, so it must not say otherwise");
  const todo = await body(created);
  assert.equal(todo.userId, 1);

  // Read back through the same nested route, alongside the shared todos.
  const records = [{ record_id: String(todo.id), body: JSON.stringify(todo), deleted: 0 }];
  const listed = await body(await call("/v1/sandbox/live/users/1/todos?_limit=100", {}, makeEnv({ sandboxes, records })));
  assert.ok(listed.some((t) => t.id === todo.id && t.title === "mine"));
  assert.ok(listed.every((t) => t.userId === 1));

  const wrong = await call("/v1/sandbox/live/posts", { method: "PUT", body: "{}" }, makeEnv({ sandboxes }));
  assert.equal(wrong.status, 405);
  assert.match((await body(wrong)).error.hint, /PUT \/v1\/sandbox\/live\/posts\/1\./);
});

test("reports the caller's tier on every response", async () => {
  const res = await call("/v1/posts");
  assert.equal(res.headers.get("x-tier"), "anonymous");
  assert.equal(res.headers.get("x-ratelimit-limit"), "1000");
});

test("upgrades the tier for a valid key", async () => {
  const env = makeEnv({ keys: [{ id: "k1", key: "flk_good", tier: "pro", revoked: 0 }] });
  const res = await call("/v1/posts", { headers: { authorization: "Bearer flk_good" } }, env);
  assert.equal(res.headers.get("x-tier"), "pro");
});

test("rejects an unknown key", async () => {
  const res = await call("/v1/posts", { headers: { authorization: "Bearer flk_nope" } });
  assert.equal(res.status, 401);
});

test("refuses a sandbox without a key", async () => {
  const res = await call("/v1/sandbox", { method: "POST" });
  // 403, not 402: anonymous is a valid tier, so the caller is authenticated but
  // not permitted. 402 reads as a billing failure to client error handling.
  assert.equal(res.status, 403);
});

test("validates _page and _limit as strictly as the chaos parameters", async () => {
  for (const query of ["_page=abc", "_page=-1", "_page=0", "_limit=abc", "_limit=-1", "_limit=0", "_limit=1.5"]) {
    assert.equal((await call(`/v1/posts?${query}`)).status, 400, `${query} should be a 400`);
  }
  // Capping above the tier maximum is the documented contract, not a silent
  // fallback, so it stays a 200.
  assert.equal((await call("/v1/photos?_limit=9999")).status, 200);
});

test("never echoes raw caller input back into an error hint", async () => {
  const payload = "<img src=x onerror=alert(1)>";
  const res = await call(`/v1/posts?_status=${encodeURIComponent(payload)}`);
  assert.equal(res.status, 400);

  const text = await res.text();
  // Not merely escaped — the value is refused outright, so none of the
  // attacker's words reach a consumer that renders the hint carelessly.
  assert.ok(!text.includes("onerror"), "no payload words survive");
  assert.ok(!/[<>]/.test(text), "no angle brackets anywhere in the body");
  assert.match((await body(await call("/v1/posts?_status=" + encodeURIComponent(payload)))).error.hint, /\(unprintable\)/);

  // A boring value still echoes, so the hint stays useful for the common typo.
  assert.match((await body(await call("/v1/posts?_status=99a"))).error.hint, /_status=99a/);
});

test("bounds total traffic per address even when several keys are held", async () => {
  const env = makeEnv({ keys: [{ id: "k1", key: "flk_good", tier: "free", revoked: 0 }] });
  // The key's own budget is untouched; the shared per-address ceiling is spent.
  env.RATE_LIMITS.get = async (k) => (k.startsWith("ip:") ? "20000" : "0");

  const res = await call("/v1/posts", { headers: { authorization: "Bearer flk_good", "cf-connecting-ip": "203.0.113.9" } }, env);
  assert.equal(res.status, 429);
  assert.match((await body(res)).error.message, /for this address/);
});

test("sends hardening headers on both the API and the pages", async () => {
  const api = await call("/v1/posts?_limit=1");
  assert.equal(api.headers.get("x-content-type-options"), "nosniff");
  assert.equal(api.headers.get("x-frame-options"), "DENY");
  assert.match(api.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(api.headers.get("strict-transport-security"), /max-age=31536000/);

  const page = await call("/");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  // 'self' rather than 'unsafe-inline' — the whole point of extracting the
  // inline script and style out of the HTML.
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.ok(!page.headers.get("content-security-policy").includes("unsafe-inline"));
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("creates a sandbox for a keyed caller", async () => {
  const env = makeEnv({ keys: [{ id: "k1", key: "flk_good", tier: "free", revoked: 0 }] });
  const res = await call("/v1/sandbox", { method: "POST", headers: { authorization: "Bearer flk_good" } }, env);
  assert.equal(res.status, 201);
  assert.match((await body(res)).baseUrl, /^\/v1\/sandbox\/[a-f0-9]{16}$/);
});

test("reports an expired sandbox as gone", async () => {
  const env = makeEnv({ sandboxes: [{ id: "old", key_id: "k1", expires_at: Date.now() - 1000 }] });
  const res = await call("/v1/sandbox/old/posts", {}, env);
  assert.equal(res.status, 410);
});

test("persists a write inside a live sandbox", async () => {
  const env = makeEnv({ sandboxes: [{ id: "live", key_id: "k1", expires_at: Date.now() + 60000 }] });
  const res = await call("/v1/sandbox/live/posts", { method: "POST", body: JSON.stringify({ title: "sticks" }) }, env);
  assert.equal(res.status, 201);
  assert.equal((await body(res)).title, "sticks");
});

test("validates the email on key creation", async () => {
  const res = await call("/v1/keys", { method: "POST", body: JSON.stringify({ email: "not-an-email" }) });
  assert.equal(res.status, 400);
});

test("issues a key for a valid email", async () => {
  const res = await call("/v1/keys", { method: "POST", body: JSON.stringify({ email: "dev@example.com" }) });
  assert.equal(res.status, 201);
  assert.match((await body(res)).key, /^flk_[a-f0-9]{32}$/);
});

test("guards the admin endpoint", async () => {
  assert.equal((await call("/v1/admin/stats")).status, 401);
  assert.equal((await call("/v1/admin/stats", { headers: { authorization: "Bearer admin-token" } })).status, 200);
});

test("the headline tiles get the bot share and what people asked to fail", async () => {
  const env = makeEnv();
  const prepare = env.DB.prepare;
  let usageSql = "";
  env.DB.prepare = (sql) => {
    if (sql.includes("SUM(bot_requests) AS bots")) {
      usageSql = sql.replace(/\s+/g, " ");
      return { bind: () => ({ first: async () => ({ requests: 8828, bots: 4803, chaos: 290 }) }) };
    }
    return prepare(sql);
  };

  const stats = await body(await call("/v1/admin/stats", { headers: { authorization: "Bearer admin-token" } }, env));
  // Numerator and denominator from the same table, so the share is honest.
  assert.equal(stats.totals.botShare, 0.5441);
  assert.equal(stats.totals.chaosRequests, 290);
  // Bots and the site's own try-it box are not anyone adopting the feature.
  // Clamped per row: backfilled rows can have more bot chaos than chaos, and an
  // unclamped sum once put the whole window at -106.
  assert.match(usageSql, /SUM\(MAX\(with_any - bot_chaos - onsite_chaos, 0\)\)/);
});

test("the needs-fixing list is unrequested 5xx only, and the totals still cover everything", async () => {
  // The list used to be every kind of error, and 90 days of WordPress scanners
  // buried the one row that meant something was broken. It is now only what
  // means flaky itself failed; the totals beside it still count everything, so
  // it cannot be read as "no errors at all".
  const broken = [{ status: 500, path: "/v1/scenario", bot: 1, count: 2, firstDay: "2026-09-03", lastDay: "2026-09-03" }];
  const everything = { kinds: 46, total: 2542, requested: 182, server: 30, client: 2330, bots: 2260 };

  const env = makeEnv();
  const prepare = env.DB.prepare;
  let listSql = "";
  env.DB.prepare = (sql) => {
    if (sql.includes("AS kinds")) return { bind: () => ({ first: async () => everything }) };
    if (sql.includes("FROM error_bucket") && sql.includes("LIMIT 40")) {
      listSql = sql.replace(/\s+/g, " ");
      return { bind: () => ({ all: async () => ({ results: broken }) }) };
    }
    return prepare(sql);
  };

  const stats = await body(await call("/v1/admin/stats", { headers: { authorization: "Bearer admin-token" } }, env));
  assert.match(listSql, /injected = 0 AND status >= 500/, "nothing asked for, nothing below 500");
  assert.match(listSql, /ORDER BY lastDay DESC/, "a failure from today above one from last month");
  assert.deepEqual(stats.errors, broken);
  assert.deepEqual(stats.errorTotals, everything);
  assert.equal(stats.totals.serverErrors, 30);
  assert.equal(stats.totals.clientErrors, 2330);
});

test("each day's errors are split into user, requested and need-fixing, where the split is known", async () => {
  // The 29th is from before error_bucket existed; the 30th is the day it began,
  // part-way through, so it saw 168 of 519. Neither may be split: a "user 155"
  // beside 519 errors is a number that looks exact and is not.
  const daily = [
    { day: "2026-08-29", requests: 1094, errors: 433 },
    { day: "2026-08-30", requests: 726, errors: 519 },
    { day: "2026-09-24", requests: 103, errors: 23 },
    { day: "2026-09-25", requests: 40, errors: 0 },
  ];
  const splits = [
    { day: "2026-08-30", total: 168, requested: 13, broken: 0 },
    { day: "2026-09-24", total: 23, requested: 15, broken: 2 },
  ];

  const env = makeEnv();
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => {
    if (sql.includes("SUM(errors) AS errors") && sql.includes("GROUP BY day")) return { bind: () => ({ all: async () => ({ results: daily }) }) };
    if (sql.includes("FROM error_bucket WHERE day >= ? GROUP BY day")) return { bind: () => ({ all: async () => ({ results: splits }) }) };
    return prepare(sql);
  };

  const stats = await body(await call("/v1/admin/stats", { headers: { authorization: "Bearer admin-token" } }, env));
  const byDay = Object.fromEntries(stats.daily.map((d) => [d.day, d]));
  assert.equal(byDay["2026-08-29"].userErrors, null);
  assert.equal(byDay["2026-08-30"].userErrors, null, "a partly recorded day is not split");
  assert.equal(byDay["2026-08-30"].fixErrors, null);
  // 23 errors: 15 asked for, 2 unrequested 5xx, and the 6 left are 4xx.
  assert.equal(byDay["2026-09-24"].userErrors, 6);
  assert.equal(byDay["2026-09-24"].requestedErrors, 15);
  assert.equal(byDay["2026-09-24"].fixErrors, 2);
  // No errors at all is a known split of zeros, not an unknown one.
  assert.equal(byDay["2026-09-25"].userErrors, 0);
  assert.equal(byDay["2026-09-25"].requestedErrors, 0);
  assert.equal(byDay["2026-09-25"].fixErrors, 0);

  // And the totals reconcile with the columns: 6 + 15 + 2 + (433 + 519) = 975.
  assert.equal(stats.totals.userErrors, 6);
  assert.equal(stats.totals.requestedErrors, 15);
  assert.equal(stats.totals.fixErrors, 2);
  assert.equal(stats.totals.unsplitErrors, 952);
  assert.equal(stats.totals.errors, 975);
});

test("exports CSV with a filename and the right content type", async () => {
  const res = await call("/v1/admin/export?dataset=daily", { headers: { authorization: "Bearer admin-token" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="flaky-daily-\d{4}-\d{2}-\d{2}\.csv"/);
  // Check the bytes, not res.text(): "UTF-8 decode" strips a leading BOM by
  // spec, so the string would look BOM-less even when the wire format has one.
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "starts with a UTF-8 BOM for Excel");
  // peak_hour_utc and the error split joined the export so the csv cannot
  // disagree with the table on screen.
  assert.equal(new TextDecoder().decode(bytes.slice(3)),
    "day,requests,errors,user_errors,requested_errors,fix_errors,peak_hour_utc\r\n");
});

test("guards the CSV export and rejects an unknown dataset", async () => {
  assert.equal((await call("/v1/admin/export?dataset=daily")).status, 401);
  const res = await call("/v1/admin/export?dataset=nonsense", { headers: { authorization: "Bearer admin-token" } });
  assert.equal(res.status, 400);
  assert.match((await body(res)).error.hint, /countries/);
});

test("csv quotes delimiters and neutralises spreadsheet formulas", async () => {
  const { toCsv } = await import("../src/lib/csv.js");

  const csv = toCsv(
    [
      { a: "plain", b: 1 },
      { a: 'has "quotes", a comma\nand a newline', b: 2 },
      // A field a stranger controls. Left alone, Excel executes this on open.
      { a: "=cmd|'/c calc'!A1", b: 3 },
      { a: "+1-555-0100", b: 4 },
      { a: null, b: undefined },
    ],
    [["a", "a"], ["b", "b"]]
  );

  // Split on CRLF: a newline *inside* a quoted field is a bare \n and must stay
  // part of that record, which is exactly what a correct parser will do too.
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "a,b");
  assert.equal(lines[1], "plain,1");
  assert.equal(lines[2], '"has ""quotes"", a comma\nand a newline",2');
  assert.equal(lines[3], "'=cmd|'/c calc'!A1,3");
  assert.equal(lines[4], "'+1-555-0100,4");
  assert.equal(lines[5], ",");
});

// KV's free tier allows 1,000 writes/day and the limiter writes once per
// request, so hitting the quota is what a successful day looks like. These
// guard the rule that a broken limiter must never take the API down with it.
test("serves traffic when the rate-limit store cannot be written", async () => {
  const env = makeEnv();
  env.RATE_LIMITS.put = async () => { throw new Error("KV PUT failed: 429"); };

  const res = await call("/v1/posts?_limit=1", {}, env);
  assert.equal(res.status, 200, "a dead limiter must not become an outage");
  // No degraded header for a write failure any more, and that is the accepted
  // cost of moving the write off the request path: the response is already sent
  // by the time the put resolves, so its outcome cannot be reported in it. Read
  // failures, which are still awaited, do set the header — see the next test.
});

test("serves traffic when the rate-limit store cannot be read", async () => {
  const env = makeEnv();
  env.RATE_LIMITS.get = async () => { throw new Error("KV GET failed"); };

  const res = await call("/v1/posts?_limit=1", {}, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-ratelimit-degraded"), "1");
});

test("still enforces the limit when only writes are broken", async () => {
  const env = makeEnv();
  // Reads work and report the caller is already over the anonymous limit.
  env.RATE_LIMITS.get = async () => "1000";
  env.RATE_LIMITS.put = async () => { throw new Error("KV PUT failed: 429"); };

  const res = await call("/v1/posts", {}, env);
  assert.equal(res.status, 429, "an over-quota caller is not let through by the outage");
});

test("an unexpected failure returns clean JSON, not an unhandled exception", async () => {
  const env = makeEnv();
  env.DB.prepare = () => { throw new Error("D1 unavailable"); };

  // The auth header forces a key lookup, so the broken D1 is reached.
  const res = await call("/v1/posts", { headers: { authorization: "Bearer flk_x" } }, env);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("access-control-allow-origin"), "*", "CORS survives, so browsers see the status");
  assert.match((await body(res)).error.message, /broke on our side/);
});

test("caps how many new keys one address can mint per day", async () => {
  const env = makeEnv();
  // Five already issued from this address today.
  env.RATE_LIMITS.get = async (k) => (k.startsWith("keys:") ? "5" : null);

  const res = await call("/v1/keys", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ email: "farmer@example.com" }),
  }, env);

  assert.equal(res.status, 429);
  assert.match((await body(res)).error.hint, /already have is always allowed/);
});

test("still returns an existing key when the mint cap is reached", async () => {
  const env = makeEnv({ keys: [{ id: "k1", key: "flk_mine", email: "me@example.com", tier: "free", revoked: 0 }] });
  env.RATE_LIMITS.get = async (k) => (k.startsWith("keys:") ? "99" : null);

  const res = await call("/v1/keys", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ email: "me@example.com" }),
  }, env);

  assert.equal(res.status, 200, "the idempotent path is never rate limited");
  assert.equal((await body(res)).key, "flk_mine");
});

test("refuses an oversized sandbox record", async () => {
  const env = makeEnv({ sandboxes: [{ id: "live", key_id: "k1", expires_at: Date.now() + 60000 }] });
  const huge = JSON.stringify({ title: "x".repeat(70 * 1024) });

  const res = await call("/v1/sandbox/live/posts", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(huge.length) },
    body: huge,
  }, env);

  assert.equal(res.status, 413);
  assert.match((await body(res)).error.hint, /64 KB/);
});

test("accepts multiple admin tokens so one can be rotated without downtime", async () => {
  const env = makeEnv();
  env.ADMIN_TOKEN = "old-token, new-token";

  for (const token of ["old-token", "new-token"]) {
    const res = await call("/v1/admin/stats", { headers: { authorization: `Bearer ${token}` } }, env);
    assert.equal(res.status, 200, `${token} should be accepted`);
  }
  assert.equal((await call("/v1/admin/stats", { headers: { authorization: "Bearer neither" } }, env)).status, 401);
});

// A 401 in the request log is a status and nothing else, so every way of
// getting one looks identical from the outside. These assert on the line the
// Worker writes instead — and on what it must never contain.
test("a rejected admin token says why in the log, without leaking the token", async () => {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => said.push(args.join(" "));

  try {
    const env = makeEnv();
    env.ADMIN_TOKEN = "admin-token"; // 11 characters

    await call("/v1/admin/stats", {}, env);
    assert.match(said.at(-1), /no bearer token/, "a missing header is its own case");

    await call("/v1/admin/stats", { headers: { authorization: "Bearer 0123456789012345678901234567890123456789" } }, env);
    assert.match(said.at(-1), /token is 40 chars, expected 11/);
    assert.match(said.at(-1), /wrong token for this environment/,
      "a length mismatch means the wrong environment, not a typo");

    await call("/v1/admin/stats", { headers: { authorization: "Bearer wrong-token" } }, env);
    assert.match(said.at(-1), /right length, wrong value/,
      "the same length is a typo, and saying so stops the hunt for the wrong thing");

    const unset = makeEnv();
    unset.ADMIN_TOKEN = "";
    await call("/v1/admin/stats", { headers: { authorization: "Bearer anything" } }, unset);
    assert.match(said.at(-1), /ADMIN_TOKEN is not set/,
      "an unconfigured environment must not look like a bad token");

    // The path is worth having; the secret never is, in any form.
    assert.ok(said.every((line) => line.includes("/v1/admin/stats")));
    for (const line of said) {
      assert.ok(!line.includes("admin-token"), "the configured token must never be logged");
      assert.ok(!line.includes("wrong-token"), "nor the one that was presented");
    }
  } finally {
    console.warn = warn;
  }
});

// --- One day's errors -------------------------------------------------------
//
// The per-day table gives a count. These cover the read behind it.
const DAY_ERRORS = [
  { day: "2026-09-23", status: 401, path: "/v1/admin/stats", injected: 0, bot: 1, count: 3 },
  { day: "2026-09-23", status: 404, path: "/v1/agent.json", injected: 0, bot: 1, count: 1 },
  { day: "2026-09-23", status: 503, path: "/v1/posts", injected: 1, bot: 0, count: 2 },
  { day: "2026-09-23", status: 500, path: "/v1/custom", injected: 0, bot: 0, count: 1 },
  { day: "2026-09-22", status: 404, path: "/v1/.env", injected: 0, bot: 1, count: 9 },
];

test("one day's errors come back for that day only", async () => {
  const env = makeEnv({ dayErrors: DAY_ERRORS });
  const res = await call("/v1/admin/errors?day=2026-09-23", ADMIN, env);
  assert.equal(res.status, 200);

  const data = await body(res);
  assert.equal(data.day, "2026-09-23");
  assert.equal(data.errors.length, 4, "the 22nd's rows belong to the 22nd");
  assert.ok(data.errors.every((e) => e.path !== "/v1/.env"));
});

test("a day's totals separate requested failures and real ones", async () => {
  const env = makeEnv({ dayErrors: DAY_ERRORS });
  const { totals } = await body(await call("/v1/admin/errors?day=2026-09-23", ADMIN, env));

  assert.equal(totals.total, 7);
  // A 503 somebody asked for with _status is the product working, and must not
  // be counted as something broken — this is the whole point of the column.
  assert.equal(totals.requested, 2);
  assert.equal(totals.server, 1, "only the unrequested 5xx");
  assert.equal(totals.bots, 4);
});

test("a day with nothing recorded says so rather than 404ing", async () => {
  const env = makeEnv({ dayErrors: DAY_ERRORS });
  const data = await body(await call("/v1/admin/errors?day=2026-01-01", ADMIN, env));
  assert.deepEqual(data.errors, []);
  assert.equal(data.totals.total, 0);
});

test("a day that is not a date is a 400, not an empty list", async () => {
  const env = makeEnv({ dayErrors: DAY_ERRORS });
  // An empty list would read as "nothing broke that day", which is a lie about
  // data that was never looked at.
  for (const bad of ["", "yesterday", "2026-9-3", "2026-09-23T00:00"]) {
    const res = await call(`/v1/admin/errors?day=${encodeURIComponent(bad)}`, ADMIN, env);
    assert.equal(res.status, 400, `${bad || "(empty)"} should be rejected`);
  }
  // And the hint never echoes anything that is not plainly alphanumeric.
  const hint = await body(await call("/v1/admin/errors?day=<script>", ADMIN, env));
  assert.ok(!JSON.stringify(hint).includes("<script>"));
});

test("what people did on a day comes back as totals, bots left out", async () => {
  const env = makeEnv();
  const prepare = env.DB.prepare;
  const seen = [];
  env.DB.prepare = (sql) => {
    const s = sql.replace(/\s+/g, " ");
    const rows = (results) => ({ bind: (...args) => { seen.push({ s, args }); return { all: async () => ({ results }) }; } });
    const one = (row) => ({ bind: (...args) => { seen.push({ s, args }); return { first: async () => row }; } });
    if (s.includes("FROM page_time") && s.includes("LIMIT 30")) return rows([{ path: "/createMockServer", visits: 3, sum_seconds: 527, max_seconds: 521, bounced: 2 }]);
    if (s.includes("FROM path_bucket") && s.includes("LIMIT 30")) return rows([{ path: "/v1/posts", requests: 30, chaos: 21, onsite: 1 }]);
    if (s.includes("FROM referrer_bucket")) return rows([{ referrer: "bing.com", requests: 1 }]);
    if (s.includes("FROM page_time")) return one({ pages: 2, views: 5, seconds: 541, bounced: 3 });
    if (s.includes("FROM path_bucket")) return one({ endpoints: 12, requests: 85, chaos: 31, onsite: 33 });
    return prepare(sql);
  };

  const res = await call("/v1/admin/visits?day=2026-09-24", ADMIN, env);
  assert.equal(res.status, 200);
  const data = await body(res);

  assert.deepEqual(data.pages[0], { path: "/createMockServer", views: 3, avgSeconds: 176, maxSeconds: 521, bounced: 2 });
  assert.deepEqual(data.api[0], { path: "/v1/posts", requests: 30, chaos: 21, fromSite: 1 });
  assert.equal(data.referrers[0].referrer, "bing.com");
  // Totals from their own queries, not a sum of the listed rows.
  assert.equal(data.totals.apiRequests, 85);
  assert.equal(data.totals.chaosRequests, 31);
  assert.equal(data.totals.views, 5);

  // Only the day asked for, bots subtracted, and the operator's own pages and
  // the beacon plumbing never counted as something a visitor did.
  assert.ok(seen.every((q) => q.args[0] === "2026-09-24"));
  const endpoints = seen.find((q) => q.s.includes("FROM path_bucket") && q.s.includes("LIMIT 30")).s;
  assert.match(endpoints, /requests - bot_requests/);
  assert.match(endpoints, /NOT LIKE '\/v1\/admin%'/);
  assert.match(endpoints, /path != '\/v1\/beacon'/);
  // Never the per-person table: the privacy page promises it is only read for
  // people who came back.
  assert.ok(!seen.some((q) => q.s.includes("visitor_path")));
});

test("what people did needs the token and a real date", async () => {
  assert.equal((await call("/v1/admin/visits?day=2026-09-24")).status, 401);
  assert.equal((await call("/v1/admin/visits?day=yesterday", ADMIN)).status, 400);
});

test("one day's errors need the admin token", async () => {
  assert.equal((await call("/v1/admin/errors?day=2026-09-23")).status, 401);
});

// A token that works must not write a line at all: a warning on the happy path
// is noise that trains you to ignore the log.
test("an accepted admin token logs nothing", async () => {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => said.push(args.join(" "));
  try {
    const res = await call("/v1/admin/stats", { headers: { authorization: "Bearer admin-token" } });
    assert.equal(res.status, 200);
    assert.deepEqual(said, []);
  } finally {
    console.warn = warn;
  }
});

test("groups error paths so record ids do not each become a row", async () => {
  const { normalisePath } = await import("../src/middleware/analytics.js");

  assert.equal(normalisePath("/v1/posts/9999"), "/v1/posts/:id");
  assert.equal(normalisePath("/v1/posts/1/comments"), "/v1/posts/:id/comments");
  assert.equal(normalisePath("/v1/sandbox/12e56f1b9ff640b8/posts"), "/v1/sandbox/:sandbox/posts");
  assert.equal(normalisePath("/v1/posts"), "/v1/posts");
  // Bounded, so a long junk path cannot make a wide row.
  assert.ok(normalisePath("/v1/" + "x".repeat(500)).length <= 120);
});

test("labels a requested failure differently from a validation rejection", async () => {
  // Merely carrying a chaos parameter is not enough — ?_status=999 is rejected
  // with a 400, and that is the API being correct, not a failure anyone asked
  // for. Getting this wrong made 21 validation errors read as "requested".
  const got503 = await call("/v1/posts?_status=503");
  assert.equal(got503.status, 503);

  const rejected = await call("/v1/posts?_status=999");
  assert.equal(rejected.status, 400);

  const failed = await call("/v1/posts?_fail_rate=1");
  assert.equal(failed.status, 500);

  const badRate = await call("/v1/posts?_fail_rate=2");
  assert.equal(badRate.status, 400);
});

test("supports _start, the offset paging JSONPlaceholder users arrive with", async () => {
  const offset = await body(await call("/v1/posts?_start=5&_limit=2"));
  assert.equal(offset.length, 2);
  assert.equal(offset[0].id, 6, "_start is an offset, not a page");

  // When both styles are given, the explicit offset wins.
  const both = await body(await call("/v1/posts?_start=10&_page=3&_limit=1"));
  assert.equal(both[0].id, 11);
});

test("rejects an unknown underscore parameter instead of filtering on it", async () => {
  // The bug this prevents: _start used to fall through to a field filter,
  // match no records, and return [] — so a migrating caller got no data and no
  // explanation.
  const res = await call("/v1/posts?_nonsense=1");
  assert.equal(res.status, 400);
  assert.match((await body(res)).error.hint, /_limit/);

  // A real field filter is untouched.
  assert.equal((await call("/v1/todos?userId=3&_limit=2")).status, 200);
});

test("classifies a credential sweep as a bot despite a browser user agent", async () => {
  const { classifyClient, isProbe } = await import("../src/middleware/analytics.js");
  const browser = new Request("https://flaky.test/", { headers: { "user-agent": "Mozilla/5.0 Chrome/120" } });

  // What it asks for beats what it claims to be.
  for (const path of ["/.env", "/.env.production", "/.git/config", "/config.json", "/js/env.js", "/backup.sql"]) {
    assert.equal(classifyClient(browser, path), "bot", `${path} should read as a probe`);
    assert.ok(isProbe(path));
  }

  // Real paths from the same user agent stay a browser.
  for (const path of ["/", "/docs/jsonplaceholder", "/v1/posts", "/v1/posts/1/comments", "/dashboard"]) {
    assert.equal(classifyClient(browser, path), "browser", `${path} must not be a probe`);
    assert.ok(!isProbe(path));
  }
});

test("serves an OpenAPI spec generated from the same source as /v1/meta", async () => {
  const spec = await body(await call("/v1/openapi.json"));
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.servers[0].url, "https://flakyapi.dev/v1");

  // Every resource is described, so adding one cannot leave the spec behind.
  const meta = await body(await call("/v1/meta"));
  for (const r of meta.resources) {
    assert.ok(spec.paths[`/${r.name}`], `${r.name} missing from the spec`);
    assert.ok(spec.paths[`/${r.name}/{id}`], `${r.name}/{id} missing`);
    for (const nested of r.nested) {
      const path = nested.replace("/v1", "").replace(":id", "{id}");
      assert.ok(spec.paths[path], `${path} missing from the spec`);
    }
  }

  // The chaos parameters are the point; they must be documented on a list route.
  const names = spec.paths["/posts"].get.parameters.map((p) => p.name);
  for (const p of ["_delay", "_status", "_fail_rate", "_start", "_page", "_limit"]) {
    assert.ok(names.includes(p), `${p} not documented`);
  }

  // Every method /v1/meta says a path accepts is described on that path, and no
  // other — the landing page's table and the spec cannot disagree.
  const ops = (path) => Object.keys(spec.paths[path]).map((m) => m.toUpperCase()).sort();
  assert.deepEqual(ops("/posts"), [...meta.methods.collection].sort());
  assert.deepEqual(ops("/posts/{id}"), [...meta.methods.record].sort());
  assert.deepEqual(ops("/posts/{id}/comments"), [...meta.methods.nested].sort());

  assert.equal(meta.openapi, "/v1/openapi.json", "/v1/meta should point at the spec");
});

test("a known path with the wrong method is a 405, not a 404", async () => {
  // POST /v1/meta used to answer "Unknown resource 'meta'", which sends someone
  // hunting for a typo in a URL that was correct.
  const res = await call("/v1/meta", { method: "POST" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "GET");
  assert.match((await body(res)).error.hint, /accepts GET/);

  assert.equal((await call("/v1/keys", { method: "DELETE" })).status, 405);
  assert.equal((await call("/v1/openapi.json", { method: "PUT" })).status, 405);

  // A path that genuinely does not exist is still a 404.
  assert.equal((await call("/v1/no-such-thing/deep/path")).status, 404);
  // And a collection takes POST, so creating a record does not 405.
  assert.equal((await call("/v1/posts", { method: "POST", body: "{}" })).status, 201);
});

test("spots a percent-encoded credential probe", async () => {
  const { isProbe } = await import("../src/middleware/analytics.js");
  // Scanners encode precisely to slip past filters like this one.
  for (const p of ["/.env", "/%2eenv", "/%2f%2eenv", "/.git/config", "/%2egit/config"]) {
    assert.ok(isProbe(p), `${p} should read as a probe`);
  }
  for (const p of ["/v1/posts", "/docs/jsonplaceholder", "/"]) {
    assert.ok(!isProbe(p), `${p} must not`);
  }
  // A malformed escape must not throw.
  assert.doesNotThrow(() => isProbe("/%zz"));
});

test("returns only the requested fields, keeping id", async () => {
  const rows = await body(await call("/v1/products?_select=title,price&_limit=2"));
  assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "price", "title"]);

  // DummyJSON spells it without the underscore; someone migrating sends that,
  // and it must not be treated as a filter on a field named "select".
  const same = await body(await call("/v1/products?select=title&_limit=1"));
  assert.deepEqual(Object.keys(same[0]).sort(), ["id", "title"]);

  // An unknown field simply is not there — no error, nothing invented.
  const partial = await body(await call("/v1/posts?_select=title,nope&_limit=1"));
  assert.deepEqual(Object.keys(partial[0]).sort(), ["id", "title"]);
});

test("sends Retry-After on the statuses that mean come back later", async () => {
  // A client that backs off correctly reads this. Nothing else returning these
  // codes provides one, so there is nothing to test backoff against.
  const busy = await call("/v1/posts?_status=429");
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "5");

  const down = await call("/v1/posts?_status=503&_retry_after=30");
  assert.equal(down.headers.get("retry-after"), "30");

  // Not on codes where it would be meaningless.
  assert.equal((await call("/v1/posts?_status=404")).headers.get("retry-after"), null);
});

test("returns a truncated body for _malformed, not random bytes", async () => {
  const res = await call("/v1/posts?_malformed=1&_limit=5");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-truncated"), "deliberately, by _malformed=1");

  const text = await res.text();
  // The realistic failure is a connection dropped mid-body: it starts as valid
  // JSON and stops. That is the .json() catch path nobody tests.
  assert.ok(text.startsWith("["), "still looks like the real response");
  assert.throws(() => JSON.parse(text), "must not parse");

  const intact = await call("/v1/posts?_limit=5");
  assert.ok((await intact.text()).length > text.length, "shorter than the real body");
});

test("omits CORS headers for _cors=off, and says so", async () => {
  const res = await call("/v1/posts?_cors=off&_limit=1");
  assert.equal(res.status, 200, "the server still answers — a browser is what refuses");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.match(res.headers.get("x-cors"), /browser will refuse/);

  assert.equal((await call("/v1/posts?_limit=1")).headers.get("access-control-allow-origin"), "*");
});

test("validates the new parameters like the rest", async () => {
  for (const q of ["_malformed=yes", "_malformed=2", "_cors=on", "_cors=true"]) {
    assert.equal((await call(`/v1/posts?${q}`)).status, 400, `${q} should be a 400`);
  }
});

test("classifies a scanner sweep however it prefixes the path", async () => {
  const { isProbe } = await import("../src/middleware/analytics.js");

  // The same sweep, with and without a directory in front. Anchoring to the
  // root caught only the bare form and filed the rest as human traffic.
  for (const p of [
    "/wp-includes/wlwmanifest.xml",
    "/blog/wp-includes/wlwmanifest.xml",
    "/shop/wp-includes/wlwmanifest.xml",
    "/wp-admin/install.php",
    "/test.php",
    "/phpinfo.php",
  ]) {
    assert.ok(isProbe(p), `${p} should read as a probe`);
  }

  // Nothing we actually serve may be swept up by widening it.
  for (const p of ["/", "/v1/posts", "/docs/jsonplaceholder", "/privacy",
                   "/app.js", "/og.png", "/v1/openapi.json", "/sitemap.xml"]) {
    assert.ok(!isProbe(p), `${p} must not`);
  }
});

test("counts a WordPress sweep as a bot even where no .php gives it away", async () => {
  const { classifyClient } = await import("../src/middleware/analytics.js");
  const chrome = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36" };
  const as = (method, sentTo, path = sentTo) =>
    classifyClient(new Request("https://flaky.test" + sentTo, { method, headers: chrome }), path);

  // One sweep, split in two on the dashboard: /wordpress/index.php was a bot
  // because of the .php, and these were callers.
  for (const p of ["/wordpress/", "/wp/", "/blog/wp-json/batch/v1", "/wordpress/wp-json/batch/v1"]) {
    assert.equal(as("GET", p), "bot", `${p} should read as a bot`);
  }

  // A page only takes GET, so a POST to one is never someone following a link.
  assert.equal(as("POST", "/blog/"), "bot");
  assert.equal(as("PUT", "/"), "bot");

  // What people actually do stays people.
  assert.equal(as("GET", "/blog/"), "browser", "a person could type /blog");
  assert.equal(as("GET", "/"), "browser");
  assert.equal(as("GET", "/docs/jsonplaceholder"), "browser");
  assert.equal(as("POST", "/v1/posts"), "browser", "a write to the API is the API being used");
  assert.equal(as("DELETE", "/v1/posts/1"), "browser");
  // A resource someone named in their own JSON is not a WordPress directory.
  assert.equal(as("GET", "/v1/custom/0123456789abcdef/wp"), "browser");

  // The beacon reports a page but is itself a POST to /v1/beacon. Judging the
  // method against the page path would file every page view it records as a bot.
  assert.equal(as("POST", "/v1/beacon", "/"), "browser");
});

const CUSTOM = {
  id: "a1b2c3d4e5f60718",
  body: JSON.stringify({ employees: [{ id: 1, name: "Asha", dept: "Platform" }, { id: 2, name: "Wei", dept: "Product" }] }),
  expires_at: Date.now() + 60000,
};

test("turns pasted JSON into an API", async () => {
  const res = await call("/v1/custom", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ employees: [{ id: 1, name: "Asha" }], projects: [] }),
  });
  assert.equal(res.status, 201);

  const made = await body(res);
  assert.match(made.id, /^[a-f0-9]{16}$/);
  assert.deepEqual(made.resources.map((r) => r.name), ["employees", "projects"]);
  assert.match(made.export.server, /format=node/);
  assert.match(made.export.python, /format=python/);
});

test("accepts a bare array and names it items", async () => {
  const made = await body(await call("/v1/custom", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify([{ id: 1 }, { id: 2 }]),
  }));
  assert.deepEqual(made.resources.map((r) => r.name), ["items"]);
});

test("rejects JSON it cannot serve, and says why", async () => {
  const broken = await call("/v1/custom", { method: "POST", body: "{oops" });
  assert.equal(broken.status, 400);
  // Someone pasting by hand needs the position, not "invalid input".
  assert.match((await body(broken)).error.message, /not valid JSON/);

  const noArrays = await call("/v1/custom", { method: "POST", body: JSON.stringify({ a: 1 }) });
  assert.equal(noArrays.status, 400);
  assert.match((await body(noArrays)).error.hint, /becomes an endpoint/);
});

test("turns an OpenAPI spec into an API", async () => {
  const spec = readFileSync("src/config/example.js", "utf8").match(/CUSTOM_SPEC_EXAMPLE = `([\s\S]*?)`;/)[1];
  const env = makeEnv();
  const res = await call("/v1/custom/openapi", { method: "POST", body: spec }, env);
  assert.equal(res.status, 201);

  const made = await body(res);
  assert.deepEqual(made.resources.map((r) => [r.name, r.count]), [["customers", 10], ["orders", 10]]);
  assert.equal(made.replaces, "https://api.example.com/api/v1");
  assert.equal(made.from.title, "Orders API");
  assert.ok(made.skipped.length && made.warnings.length, "what was left out, and what differs, come back with it");
  // The same exports as a paste: it is stored as one, and served as one.
  assert.match(made.export.java, /format=java/);

  const insert = env._writes.find((w) => w._sql.startsWith("INSERT INTO custom_apis"));
  assert.equal(JSON.parse(insert._args[1]).orders.length, 10);
  assert.equal(insert._args.at(-1), 1, "the page's own example is flagged as the example");

  const edited = makeEnv();
  await call("/v1/custom/openapi", { method: "POST", body: spec.replace('"city"', '"town"').replace('"city"', '"town"') }, edited);
  assert.equal(edited._writes.find((w) => w._sql.startsWith("INSERT INTO custom_apis"))._args.at(-1), 0, "a changed spec is somebody's own");
});

test("an OpenAPI import refuses what it cannot use, and says why", async () => {
  const post = (payload) => call("/v1/custom/openapi", { method: "POST", body: payload });

  // YAML is named as YAML, not reported as a JSON error at position 0.
  const yaml = await post("openapi: 3.0.0\ninfo:\n  title: x\n");
  assert.equal(yaml.status, 400);
  const y = await body(yaml);
  assert.match(y.error.message, /YAML/);
  assert.match(y.error.hint, /openapi\.json/);

  assert.match((await body(await post("{oops"))).error.message, /not valid JSON/);
  assert.match((await body(await post('{"users":[{"id":1}]}'))).error.hint, /createMockServer/);

  const nothing = await body(await post(JSON.stringify({ openapi: "3.0.0", paths: { "/me": { get: { responses: { 200: { description: "x" } } } } } })));
  assert.match(nothing.error.message, /Nothing in this spec could be mocked/);
  assert.match(nothing.error.hint, /GET \/me/, "the reasons, not just the verdict");

  const huge = await call("/v1/custom/openapi", { method: "POST", headers: { "content-length": String(2 * 1024 * 1024) }, body: "{}" });
  assert.equal(huge.status, 413);

  // The path takes POST only; a GET is the wrong method, not a missing API.
  assert.equal((await call("/v1/custom/openapi")).status, 405);
});

test("serves a custom API with the usual query parameters", async () => {
  const env = makeEnv({ customs: [CUSTOM] });
  const base = `/v1/custom/${CUSTOM.id}`;

  assert.equal((await body(await call(`${base}/employees`, {}, env))).length, 2);
  assert.equal((await body(await call(`${base}/employees?dept=Product`, {}, env)))[0].name, "Wei");
  assert.equal((await body(await call(`${base}/employees/1`, {}, env))).name, "Asha");
  assert.equal((await body(await call(`${base}/employees?_select=name`, {}, env)))[0].dept, undefined);

  const missing = await call(`${base}/nothing`, {}, env);
  assert.equal(missing.status, 404);
  assert.match((await body(missing)).error.hint, /employees/);
});

test("chaos works on a custom API — the reason it belongs here", async () => {
  const env = makeEnv({ customs: [CUSTOM] });
  const base = `/v1/custom/${CUSTOM.id}`;
  assert.equal((await call(`${base}/employees?_status=503`, {}, env)).status, 503);
  assert.equal((await call(`${base}/employees?_fail_rate=1`, {}, env)).status, 500);
  assert.equal((await call(`${base}/employees?_status=999`, {}, env)).status, 400);
});

test("exports something that runs locally and never expires", async () => {
  const env = makeEnv({ customs: [CUSTOM] });
  const base = `/v1/custom/${CUSTOM.id}`;

  const db = await call(`${base}/export?format=json-server`, {}, env);
  assert.match(db.headers.get("content-disposition"), /filename="db.json"/);
  assert.deepEqual(Object.keys(JSON.parse(await db.text())), ["employees"]);

  const msw = await call(`${base}/export?format=msw`, {}, env);
  const file = await msw.text();
  assert.match(file, /import \{ http, HttpResponse \} from "msw"/);
  assert.match(file, /http\.get\("\*\/employees"/);

  assert.equal((await call(`${base}/export?format=nope`, {}, env)).status, 400);

  // The runners are whole servers, and they must at least be syntactically
  // valid — a download that does not run is worse than no download.
  const node = await call(`${base}/export?format=node`, {}, env);
  assert.match(node.headers.get("content-disposition"), /mock-server\.mjs/);
  // Structure only here. Whether it *runs* is checked by actually running it —
  // see scripts/check-runners.mjs — because new Function() cannot evaluate an ES
  // module with a shebang, and an approximation that fails on valid code is
  // worse than no check.
  const nodeSrc = await node.text();
  assert.match(nodeSrc, /createServer/, "node runner must be a server");
  assert.match(nodeSrc, /_fail_rate/, "the chaos controls are the point of it");

  const py = await call(`${base}/export?format=python`, {}, env);
  assert.match(py.headers.get("content-disposition"), /mock_server\.py/);
  const pySrc = await py.text();
  // JSON true/false/null are not Python literals, so the data must be embedded
  // as a string and parsed — interpolating it directly is a NameError waiting.
  assert.match(pySrc, /DB = json\.loads\("/, "data must be parsed, not inlined");
  assert.ok(!/=\s*\{[^}]*\btrue\b/.test(pySrc), "no raw JSON booleans in Python source");

  const java = await call(`${base}/export?format=java`, {}, env);
  assert.match(java.headers.get("content-disposition"), /MockServer\.java/);
  assert.equal(java.headers.get("x-run-with"), "java MockServer.java");
  const javaSrc = await java.text();
  // A class file caps one constant at 64 KB and a paste may be 256 KB, so the
  // data has to arrive in pieces. One literal would not compile.
  assert.match(javaSrc, /static final String\[\] DATA = \{/, "data must be chunked");
  assert.match(javaSrc, /_fail_rate/, "the chaos controls are the point of it");

  const cs = await call(`${base}/export?format=csharp`, {}, env);
  assert.match(cs.headers.get("content-disposition"), /MockServer\.cs/);
  assert.equal(cs.headers.get("x-run-with"), "dotnet run MockServer.cs");
  const csSrc = await cs.text();
  assert.match(csSrc, /const string Data = "/, "data must be parsed, not inlined");
  assert.match(csSrc, /_fail_rate/, "the chaos controls are the point of it");
});

// javac only defaults to UTF-8 from JDK 18. On anything older a source file is
// read in the platform encoding, so a name with an accent in it comes back
// corrupted — from a file that compiled and ran without complaint.
test("the Java runner is pure ASCII, whatever was pasted", async () => {
  const env = makeEnv({
    customs: [{ ...CUSTOM, body: JSON.stringify({ staff: [{ id: 1, name: "José", city: "München", note: "✓ 🎲" }] }) }],
  });

  const res = await call(`/v1/custom/${CUSTOM.id}/export?format=java`, {}, env);
  const src = await res.text();

  const nonAscii = src.match(/[^\x00-\x7f]/g);
  assert.equal(nonAscii, null, `Java source must be ASCII, found ${JSON.stringify(nonAscii?.slice(0, 5))}`);
  assert.match(src, /\\u00e9/, "the accent survives as an escape");

  // The other runners are read as UTF-8 by every runtime that runs them, so
  // they keep the characters rather than paying for escapes.
  const csSrc = await (await call(`/v1/custom/${CUSTOM.id}/export?format=csharp`, {}, env)).text();
  assert.match(csSrc, /José/, "C# keeps the text as written");
});

test("an expired custom API is gone, not empty", async () => {
  const env = makeEnv({ customs: [{ ...CUSTOM, expires_at: Date.now() - 1000 }] });
  const res = await call(`/v1/custom/${CUSTOM.id}/employees`, {}, env);
  assert.equal(res.status, 410);
  assert.match((await body(res)).error.hint, /1 to 9/);
});

test("a custom API lives the days asked for, one if none, nine at most", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const create = async (query, path = "/v1/custom", payload = '{"todos":[{"id":1}]}') => {
    const env = makeEnv();
    const res = await call(`${path}${query}`, { method: "POST", body: payload }, env);
    const insert = env._writes.find((w) => w._sql.startsWith("INSERT INTO custom_apis"));
    return { res, made: await body(res), insert };
  };
  const lifetime = (insert) => insert._args[4] - insert._args[3];
  const near = (ms, days) => Math.abs(ms - days * DAY) < 5000;

  const plain = await create("");
  assert.equal(plain.made.days, 1, "an API call that never asks gets what it always got");
  assert.ok(near(lifetime(plain.insert), 1));
  assert.match(plain.made.note, /24 hours/);

  const nine = await create("?days=9");
  assert.equal(nine.res.status, 201);
  assert.ok(near(lifetime(nine.insert), 9), "the row itself expires in nine days, not just the answer");
  assert.match(nine.made.note, /9 days/);

  // A spec import takes the same option and means the same thing by it.
  const spec = readFileSync("src/config/example.js", "utf8").match(/CUSTOM_SPEC_EXAMPLE = `([\s\S]*?)`;/)[1];
  const fromSpec = await create("?days=5", "/v1/custom/openapi", spec);
  assert.ok(near(lifetime(fromSpec.insert), 5));

  // Never a quiet cap: 30 served as 9 would be discovered by a test that
  // suddenly 410s on day ten.
  for (const bad of ["10", "0", "-1", "1.5", "abc", ""]) {
    const refused = await create(`?days=${bad}`);
    assert.equal(refused.res.status, 400, `days=${bad}`);
    assert.match(refused.made.error.message, /1 to 9/);
    assert.equal(refused.insert, undefined, "nothing stored for a refused lifetime");
  }
});

// The admin view of /custom. Two guards matter more than the shape: the token,
// and the lifetime window — a listing that outlived the row would show documents
// the person who pasted them believes are gone.
const ADMIN = { headers: { authorization: "Bearer admin-token" } };

test("lists the custom APIs that are still live, without their bodies", async () => {
  const env = makeEnv({
    customs: [
      { ...CUSTOM, bytes: 2048, created_at: Date.now(), country: "IN", region: "Karnataka", resources: "employees:2" },
      { ...CUSTOM, id: "ffffffffffffffff", expires_at: Date.now() - 1000, resources: "old:1" },
    ],
  });

  const res = await call("/v1/admin/custom", ADMIN, env);
  assert.equal(res.status, 200);
  const data = await body(res);

  assert.equal(data.live, 1, "the expired one is not listed");
  assert.equal(data.apis[0].id, CUSTOM.id);
  assert.equal(data.apis[0].countryName, "India");
  assert.equal(data.apis[0].region, "Karnataka");
  assert.deepEqual(data.apis[0].resources, [{ name: "employees", count: 2 }]);
  assert.ok(!JSON.stringify(data).includes("Asha"), "the listing never carries a stored body");
});

test("leaves out pastes that are just the example, and says how many", async () => {
  const env = makeEnv({
    customs: [
      { ...CUSTOM, created_at: Date.now(), resources: "employees:2" },
      { ...CUSTOM, id: "1111111111111111", created_at: Date.now(), is_sample: 1 },
      { ...CUSTOM, id: "2222222222222222", created_at: Date.now(), is_sample: 1 },
    ],
  });

  const data = await body(await call("/v1/admin/custom", ADMIN, env));
  assert.equal(data.live, 1, "only somebody's own JSON is listed");
  assert.equal(data.apis[0].id, CUSTOM.id);
  assert.equal(data.samplesHidden, 2, "and the hidden ones are still counted");
  assert.equal(data.liveIncludingSamples, 3);
});

test("the example is recognised however it was pasted", async () => {
  // What matters is the document, not the formatting: the button's exact text,
  // the same thing minified, and the same thing with a value changed.
  const example = readFileSync("src/config/example.js", "utf8").match(/CUSTOM_EXAMPLE = `([\s\S]*?)`;/)[1];
  const flagOf = async (payload) => {
    const env = makeEnv();
    await call("/v1/custom", { method: "POST", body: payload }, env);
    const insert = env._writes.find((w) => w._sql.startsWith("INSERT INTO custom_apis"));
    return insert._args.at(-1);
  };

  assert.equal(await flagOf(example), 1, "the example as the button supplies it");
  assert.equal(await flagOf(JSON.stringify(JSON.parse(example))), 1, "and minified");
  assert.equal(await flagOf(example.replace("Asha Menon", "Someone Else")), 0, "one changed value is somebody's own data");
  assert.equal(await flagOf('{"todos":[{"id":1}]}'), 0);
});

test("shows one stored document in full", async () => {
  const env = makeEnv({ customs: [{ ...CUSTOM, bytes: 99, created_at: Date.now(), country: "IN", region: "Karnataka" }] });
  const res = await call(`/v1/admin/custom/${CUSTOM.id}`, ADMIN, env);
  assert.equal(res.status, 200);

  const data = await body(res);
  assert.equal(data.body.employees[0].name, "Asha");
  assert.equal(data.countryName, "India");
});

test("the custom admin views need the token", async () => {
  const env = makeEnv({ customs: [CUSTOM] });
  assert.equal((await call("/v1/admin/custom", {}, env)).status, 401);
  assert.equal((await call(`/v1/admin/custom/${CUSTOM.id}`, {}, env)).status, 401);
  assert.equal((await call("/v1/admin/custom", { headers: { authorization: "Bearer wrong" } }, env)).status, 401);
});

test("rejects an id that is not one", async () => {
  const env = makeEnv({ customs: [CUSTOM] });
  // Shape first, so nothing that is not 16 hex characters ever reaches a query.
  assert.equal((await call("/v1/admin/custom/zzzz", ADMIN, env)).status, 400);
  assert.equal((await call("/v1/admin/custom/%2e%2e%2fkeys", ADMIN, env)).status, 400);
  assert.equal((await call("/v1/admin/custom/0000000000000000", ADMIN, env)).status, 404);
});

test("a scenario fails a fixed number of times, then recovers", async () => {
  // _fail_rate is a coin toss and cannot be asserted on. Retry logic needs a
  // sequence: fail, fail, succeed — so a test can prove the backoff recovered.
  const env = makeEnv({ scenario: { fail_count: 2, status: 503, attempts: 0, expires_at: Date.now() + 60000 } });
  const url = "/v1/posts?_limit=1&_scenario=a1b2c3d4e5f60718";

  const first = await call(url, {}, env);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get("x-scenario-attempt"), "1");
  assert.equal(first.headers.get("retry-after"), "1", "503 tells a client when to come back");

  assert.equal((await call(url, {}, env)).status, 503);

  const third = await call(url, {}, env);
  assert.equal(third.status, 200, "recovers on the attempt after the last failure");
  assert.equal(third.headers.get("x-scenario-attempt"), "3");
  assert.equal((await call(url, {}, env)).status, 200, "and stays recovered");
});

test("a scenario can be rewound without spending an attempt", async () => {
  const scenario = { fail_count: 1, status: 500, attempts: 0, expires_at: Date.now() + 60000 };
  const env = makeEnv({ scenario });
  const url = "/v1/posts?_scenario=a1b2c3d4e5f60718";

  assert.equal((await call(url, {}, env)).status, 500);
  assert.equal((await call(url, {}, env)).status, 200);

  // A beforeEach needs the counter back at zero without the resetting request
  // itself becoming attempt 1.
  const reset = await call("/v1/scenario/a1b2c3d4e5f60718/reset", { method: "POST" }, env);
  assert.equal(reset.status, 200);
  assert.equal((await body(reset)).attempts, 0);

  assert.equal((await call(url, {}, env)).status, 500, "the sequence repeats exactly");
});

test("rejects a scenario id it never issued", async () => {
  const res = await call("/v1/posts?_scenario=not-a-real-id");
  assert.equal(res.status, 400);
  assert.match((await body(res)).error.hint, /POST \/v1\/scenario/);

  const gone = await call("/v1/posts?_scenario=a1b2c3d4e5f60718", {}, makeEnv({ scenario: null }));
  assert.equal(gone.status, 404);
});

test("an inverted scenario succeeds a fixed number of times, then fails for good", async () => {
  // The other direction, and the one a rate limit actually has: fine, fine,
  // fine, then 429 — and it never recovers, because a quota that ran out does
  // not un-run-out halfway through your test.
  const env = makeEnv({ scenario: { fail_count: 2, status: 429, invert: 1, attempts: 0, expires_at: Date.now() + 60000 } });
  const url = "/v1/posts?_limit=1&_scenario=a1b2c3d4e5f60718";

  const first = await call(url, {}, env);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-scenario-attempt"), "1");
  assert.equal(first.headers.get("x-scenario-remaining-successes"), "1");

  assert.equal((await call(url, {}, env)).status, 200);

  const third = await call(url, {}, env);
  assert.equal(third.status, 429, "starts failing once the allowance is spent");
  assert.equal(third.headers.get("retry-after"), "1", "a 429 says when to come back");
  assert.equal((await call(url, {}, env)).status, 429, "and stays failed — a quota does not refill");
});

test("an inverted scenario reports its direction without advancing the counter", async () => {
  const scenario = { fail_count: 1, status: 429, invert: 1, attempts: 0, expires_at: Date.now() + 60000 };
  const env = makeEnv({ scenario });

  const before = await body(await call("/v1/scenario/a1b2c3d4e5f60718", {}, env));
  assert.deepEqual(before.policy, { succeed: 1, thenFailsWith: 429 });
  assert.equal(before.remainingSuccesses, 1);
  assert.equal(before.nextWillFail, false);
  assert.equal(scenario.attempts, 0, "reading it must not spend an attempt");

  await call("/v1/posts?_scenario=a1b2c3d4e5f60718", {}, env);

  const after = await body(await call("/v1/scenario/a1b2c3d4e5f60718", {}, env));
  assert.equal(after.remainingSuccesses, 0);
  assert.equal(after.nextWillFail, true, "nextWillFail means the same thing in both directions");
});

test("succeed: 0 fails from the very first request", async () => {
  const env = makeEnv({ scenario: { fail_count: 0, status: 429, invert: 1, attempts: 0, expires_at: Date.now() + 60000 } });
  assert.equal((await call("/v1/posts?_scenario=a1b2c3d4e5f60718", {}, env)).status, 429);
});

test("validates the scenario policy on creation", async () => {
  for (const b of [{ fail: -1 }, { fail: 999 }, { fail: "lots" }, { status: 200 }, { status: 700 }]) {
    const res = await call("/v1/scenario", { method: "POST", body: JSON.stringify(b) });
    assert.equal(res.status, 400, `${JSON.stringify(b)} should be a 400`);
  }
  assert.equal((await call("/v1/scenario", { method: "POST", body: JSON.stringify({ fail: 3, status: 429 }) })).status, 201);
});

test("a scenario body is an object or nothing, and never a 500", async () => {
  const post = (payload) => call("/v1/scenario", { method: "POST", ...(payload === undefined ? {} : { body: payload }) });

  // No body is the documented default: fail twice with 503.
  const plain = await post();
  assert.equal(plain.status, 201);
  assert.deepEqual((await body(plain)).policy, { fail: 2, status: 503, thenSucceeds: true });

  // null reached body.fail and crashed — one of the two 500s in production.
  for (const [payload, message] of [["null", /JSON object/], ["[]", /JSON object/], ['"x"', /JSON object/], ["42", /JSON object/], ["{oops", /not valid JSON/]]) {
    const res = await post(payload);
    assert.equal(res.status, 400, `${payload} is the caller's mistake, not flaky's`);
    assert.match((await body(res)).error.message, message);
  }
});

test("a URL with a broken % escape is a 400 on every route, not a 500", async () => {
  // decodeURIComponent threw in the router, so /v1/posts/%E0%A4%A blamed flaky
  // for a URL that was never valid.
  for (const path of ["/v1/posts/%E0%A4%A", "/v1/scenario/%E0%A4%A", "/v1/custom/%E0%A4%A/users", "/v1/%zz"]) {
    const res = await call(path);
    assert.equal(res.status, 400, path);
    assert.match((await body(res)).error.message, /not validly encoded/);
  }
  // A correctly encoded one is untouched.
  assert.equal((await call("/v1/posts/%31")).status, 200);
});

test("a scenario cannot run in both directions at once", async () => {
  // Silently picking one would give a passing test that proves the opposite of
  // what it claims, so this is a 400 rather than a precedence rule.
  const res = await call("/v1/scenario", { method: "POST", body: JSON.stringify({ fail: 2, succeed: 3 }) });
  assert.equal(res.status, 400);
  assert.match((await body(res)).error.hint, /not both/);

  for (const b of [{ succeed: -1 }, { succeed: 999 }, { succeed: "many" }]) {
    assert.equal((await call("/v1/scenario", { method: "POST", body: JSON.stringify(b) })).status, 400,
      `${JSON.stringify(b)} should be a 400`);
  }
  assert.equal((await call("/v1/scenario", { method: "POST", body: JSON.stringify({ succeed: 3 }) })).status, 201);
});

test("answers preflight requests", async () => {
  const res = await call("/v1/posts", { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("serves the marketing site outside /v1", async () => {
  assert.equal(await (await call("/")).text(), "landing page");
});

test("404s an unknown resource with the list of real ones", async () => {
  const res = await call("/v1/nonsense");
  assert.equal(res.status, 404);
  assert.match((await body(res)).error.hint, /posts/);
});

test("logs telemetry without raw IPs", async () => {
  const env = makeEnv();
  await call("/v1/posts", { headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0 Chrome" } }, env);
  await Promise.allSettled(waits);
  const point = env._points.at(-1);
  assert.ok(point, "a data point was written");
  assert.equal(point.indexes[0].length, 16, "visitor id is a 16-char hash");
  assert.ok(!JSON.stringify(point).includes("203.0.113.9"), "raw IP never appears");
  assert.equal(point.blobs[4], "browser");
});

test("classifies bots so they can be excluded", async () => {
  const env = makeEnv();
  await call("/v1/posts", { headers: { "user-agent": "curl/8.4.0" } }, env);
  await Promise.allSettled(waits);
  assert.equal(env._points.at(-1).blobs[4], "bot");
});

// The dashboard's own claims, asserted at the row level. Both of these were
// wrong in production for as long as the features had existed: scenario
// failures were filed as unrequested server faults, and four of the seven
// controls did not count towards the adoption figure at all.
const rollup = async (url, env, init = {}) => {
  await call(url, init, env);
  await Promise.allSettled(waits);
  const find = (table) => env._writes.filter((w) => w._sql.startsWith(`INSERT INTO ${table}`)).at(-1);
  return { error: find("error_bucket"), path: find("path_bucket") };
};

test("a scenario failure is recorded as requested, not as a server fault", async () => {
  const env = makeEnv({ scenario: { fail_count: 1, status: 503, attempts: 0, expires_at: Date.now() + 60000 } });
  const { error, path } = await rollup("/v1/posts?_scenario=a1b2c3d4e5f60718", env);

  // error_bucket (day, status, path, injected, bot, count)
  assert.equal(error._args[1], 503);
  assert.equal(error._args[3], 1, "the caller scheduled this 503 — it is the product working");
  assert.equal(path._args[7], 1, "with_scenario");
  assert.equal(path._args[9], 1, "and it counts towards adoption");
});

test("a rejected control is a validation error, not an injected one", async () => {
  const env = makeEnv();
  const { error } = await rollup("/v1/posts?_status=999", env);
  assert.equal(error._args[1], 400);
  assert.equal(error._args[3], 0, "we returned this 400; nobody asked for it");
});

test("a genuine failure is still counted as ours", async () => {
  const env = makeEnv();
  const { error } = await rollup("/v1/nonsense", env);
  assert.equal(error._args[1], 404);
  assert.equal(error._args[3], 0);
});

test("every control counts towards adoption, and a request counts once", async () => {
  // Columns after max_ms: delay, status, fail_rate, scenario, malformed, any.
  const columns = (path) => path._args.slice(4, 10);

  for (const control of ["_delay=1", "_status=503", "_fail_rate=1", "_malformed=1", "_retry_after=2", "_cors=off"]) {
    const env = makeEnv();
    const { path } = await rollup(`/v1/posts?${control}`, env);
    assert.equal(columns(path).at(-1), 1, `${control} must count towards the share`);
  }

  // Two controls, one request. Summing the per-control columns reported this as
  // two, which is how the adoption figure came to double-count.
  const env = makeEnv();
  const { path } = await rollup("/v1/posts?_delay=1&_status=503", env);
  const [delay, status, , , , any] = columns(path);
  assert.deepEqual([delay, status, any], [1, 1, 1]);
});

// The per-visitor trail. It is the only table that records behaviour against an
// identity, so what it must NOT contain matters as much as what it does.
test("records the path a person used, with the chaos and error on it", async () => {
  const env = makeEnv();
  await call("/v1/posts?_delay=1", {}, env);
  await Promise.allSettled(waits);

  const row = env._writes.find((w) => w._sql.startsWith("INSERT INTO visitor_path"));
  assert.ok(row, "a visitor trail row is written");
  // (day, visitor, path, chaos, errors)
  assert.equal(row._args[2], "/v1/posts");
  assert.equal(row._args[3], 1, "the request asked for chaos");
  assert.equal(row._args[4], 0);
});

test("record ids are collapsed in the trail, as everywhere else", async () => {
  const env = makeEnv();
  await call("/v1/posts/42", {}, env);
  await Promise.allSettled(waits);

  const row = env._writes.find((w) => w._sql.startsWith("INSERT INTO visitor_path"));
  // Without this the table would carry one row per record anyone ever read,
  // which is unbounded and reads as noise.
  assert.equal(row._args[2], "/v1/posts/:id");
});

test("bots leave no trail", async () => {
  const env = makeEnv();
  await call("/v1/posts", { headers: { "user-agent": "curl/8.4.0" } }, env);
  await Promise.allSettled(waits);

  assert.equal(
    env._writes.filter((w) => w._sql.startsWith("INSERT INTO visitor_path")).length,
    0,
    "a scanner touching fifty probe paths must not become fifty rows"
  );
  // The aggregate rollups still count it — being scanned is real traffic.
  assert.ok(env._writes.some((w) => w._sql.startsWith("INSERT INTO path_bucket")));
});

test("a probe is a probe at any depth", async () => {
  // A sweep of 182 paths went through as a person because the dotfile patterns
  // were anchored to the root and not one of them was at the root. The same
  // mistake had already been found and fixed for wp-includes.
  for (const path of ["/app/.env", "/var/www/html/.env", "/laravel/.env", "/config/app/.env", "/.env.local"]) {
    assert.equal(isProbe(path), true, `${path} is a probe`);
  }
  // The other half of that sweep: cloud service-account keys.
  for (const path of ["/key.json", "/sa.json", "/gcp-sa.json", "/service-account.json", "/firebase-adminsdk.json"]) {
    assert.equal(isProbe(path), true, `${path} is a probe`);
  }
  // And the route this site actually serves, which ends in .json and must not
  // file everyone who reads the spec as a scanner.
  assert.equal(isProbe("/v1/openapi.json"), false);
  assert.equal(isProbe("/docs/jsonplaceholder"), false);
});

test("a scanner asking for /app/.env leaves no trail and counts as a bot", async () => {
  const env = makeEnv();
  // A browser user-agent, which is what these sweeps send — the UA check alone
  // filed them as people, which is why the path check exists.
  await call("/app/.env", { headers: { "user-agent": "Mozilla/5.0" } }, env);
  await Promise.allSettled(waits);

  assert.equal(env._points.at(-1).blobs[4], "bot");
  assert.equal(env._writes.filter((w) => w._sql.startsWith("INSERT INTO visitor_path")).length, 0);
});

test("reading the dashboard does not put you in the dashboard", async () => {
  const env = makeEnv();
  await call("/v1/admin/stats", ADMIN, env);
  await Promise.allSettled(waits);

  // Same reason the try-it widget is excluded from the chaos share: it is us,
  // and it was sitting at the top of the list of people who came back.
  assert.equal(env._writes.filter((w) => w._sql.startsWith("INSERT INTO visitor_path")).length, 0);
  // Still counted as traffic, though — the request did happen.
  assert.ok(env._writes.some((w) => w._sql.startsWith("INSERT INTO path_bucket")));
});

test("the beacon is not itself an activity, but the page it reports is", async () => {
  const env = makeEnv();
  await call("/v1/beacon", {
    method: "POST",
    headers: { "user-agent": "Mozilla/5.0", "content-type": "application/json" },
    body: JSON.stringify({ path: "/docs/jsonplaceholder", seconds: 45 }),
  }, env);
  await Promise.allSettled(waits);

  const trail = env._writes.filter((w) => w._sql.startsWith("INSERT INTO visitor_path"));
  assert.equal(trail.length, 1, "one row, for the page — not one for /v1/beacon too");
  assert.equal(trail[0]._args[2], "/docs/jsonplaceholder");
});

test("the owner's own visits are traffic, never a person", async () => {
  const env = makeEnv();
  await call("/v1/posts", { headers: { "user-agent": "Mozilla/5.0", "x-flaky-owner": "1" } }, env);
  await Promise.allSettled(waits);

  // Three of the 25 people listed as having come back twice were the owner.
  const people = env._writes.filter((w) => /^INSERT INTO (visitor_path|daily_visitors)/.test(w._sql));
  assert.equal(people.length, 0, "no visitor row and no trail");
  assert.ok(env._writes.some((w) => w._sql.startsWith("INSERT INTO path_bucket")), "the request still happened");
});

test("the owner's beacon records no reading time and no visitor", async () => {
  const env = makeEnv();
  const res = await call("/v1/beacon", {
    method: "POST",
    headers: { "user-agent": "Mozilla/5.0", "content-type": "application/json" },
    body: JSON.stringify({ path: "/", seconds: 300, owner: true }),
  }, env);
  await Promise.allSettled(waits);

  assert.deepEqual(await body(res), { recorded: false });
  // sendBeacon cannot send the header, so the flag comes in the body — and has to
  // reach this request's own telemetry, not just the handler's writes.
  assert.equal(env._writes.filter((w) => /^INSERT INTO (page_time|visitor_path|daily_visitors)/.test(w._sql)).length, 0);
});

test("the landing page's own /v1/meta fetch is not something the person did", async () => {
  const onsite = { "user-agent": "Mozilla/5.0", referer: "https://flaky.test/" };
  const trailFor = async (headers, path = "/v1/meta") => {
    const env = makeEnv();
    await call(path, { headers }, env);
    await Promise.allSettled(waits);
    return env._writes.filter((w) => w._sql.startsWith("INSERT INTO visitor_path")).length;
  };

  // Every load of / fetches it, so it topped every trail at one "request" a page view.
  assert.equal(await trailFor({ ...onsite, "sec-fetch-mode": "cors" }), 0);
  // Clicking the /v1/meta link is a navigation, and a choice.
  assert.equal(await trailFor({ ...onsite, "sec-fetch-mode": "navigate" }), 1);
  // And the try-it box — same page, same referrer, also a fetch — is still the person.
  assert.equal(await trailFor({ ...onsite, "sec-fetch-mode": "cors" }, "/v1/posts"), 1);
});

test("the trail is purged on the same clock as the hash it belongs to", async () => {
  const env = makeEnv();
  await worker.scheduled({}, env, ctx);
  await Promise.allSettled(waits);

  const purges = env._writes.filter((w) => w._sql.startsWith("DELETE FROM"));
  const visitors = purges.find((w) => w._sql.includes("daily_visitors"));
  const trail = purges.find((w) => w._sql.includes("visitor_path"));
  assert.ok(trail, "the trail is purged at all");
  // Keeping it past the hash would be keeping it for nobody.
  assert.equal(trail._args[0], visitors._args[0]);
});

// GET /v1/admin/returning
const COHORT = [
  { visitor: "aaaa", days: 4, first_day: "2026-09-01", last_day: "2026-09-05", country: "IN", region: "Karnataka", hour: 2 },
  { visitor: "bbbb", days: 2, first_day: "2026-09-02", last_day: "2026-09-03", country: "US", region: "Iowa", hour: -1 },
];
const TRAILS = [
  { visitor: "aaaa", path: "/v1/posts", requests: 41, chaos: 8, errors: 1 },
  { visitor: "aaaa", path: "/", requests: 3, chaos: 0, errors: 0 },
];

test("lists the people who came back, with what they did", async () => {
  const env = makeEnv({ cohort: COHORT, trails: TRAILS });
  const res = await call("/v1/admin/returning", ADMIN, env);
  assert.equal(res.status, 200);

  const data = await body(res);
  assert.equal(data.people.length, 2);

  const [first] = data.people;
  assert.equal(first.countryName, "India");
  assert.equal(first.region, "Karnataka");
  assert.equal(first.days, 4);
  assert.equal(first.requests, 44, "totals come from the trail, not a second query");
  assert.equal(first.chaos, 8);
  assert.deepEqual(first.paths.map((p) => p.path), ["/v1/posts", "/"]);

  // Somebody with no rows yet is reported as having none rather than dropped —
  // the trail only starts when it starts.
  assert.deepEqual(data.people[1].paths, []);
  assert.equal(data.trailsFrom, "2026-09-01");
});

test("the visitor hash never leaves the server", async () => {
  const env = makeEnv({ cohort: COHORT, trails: TRAILS });
  const raw = await (await call("/v1/admin/returning", ADMIN, env)).text();
  // It is a stable pseudonym; a browser has no use for one, and shipping it
  // would make every screenshot of this page a correlation key.
  assert.ok(!raw.includes("aaaa"), "no visitor hash in the response");
  assert.match(raw, /"n":1/);
});

test("never lists people who came only once", async () => {
  const env = makeEnv({ cohort: COHORT, trails: TRAILS });
  // min=1 would turn this into a list of every visitor with their browsing
  // attached, which is not what the privacy page describes.
  const data = await body(await call("/v1/admin/returning?min=1", ADMIN, env));
  assert.equal(data.min, 2);
  assert.equal((await body(await call("/v1/admin/returning?min=0", ADMIN, env))).min, 2);
  assert.equal((await body(await call("/v1/admin/returning?min=3", ADMIN, env))).min, 3);
});

test("the returning view needs the token", async () => {
  const env = makeEnv({ cohort: COHORT });
  assert.equal((await call("/v1/admin/returning", {}, env)).status, 401);
  assert.equal((await call("/v1/admin/returning", { headers: { authorization: "Bearer wrong" } }, env)).status, 401);
});

test("runs the nightly job without throwing", async () => {
  await worker.scheduled({}, makeEnv(), ctx);
  await Promise.allSettled(waits);
});
