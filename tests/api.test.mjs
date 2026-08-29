// Run with: npm test
// Uses node:test — no dependencies. Env bindings are stubbed in memory so the
// whole suite runs offline in under a second.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function makeEnv({ keys = [], sandboxes = [], records = [] } = {}) {
  const kv = new Map();
  const points = [];

  const query = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, tier, revoked FROM api_keys")) return keys.find((k) => k.key === args[0]) || null;
    if (s.startsWith("SELECT key FROM api_keys")) return keys.find((k) => k.email === args[0]) || null;
    if (s.startsWith("SELECT COUNT(*) AS count FROM sandboxes")) return { count: sandboxes.filter((b) => b.key_id === args[0]).length };
    if (s.startsWith("SELECT id, expires_at FROM sandboxes")) return sandboxes.find((b) => b.id === args[0]) || null;
    if (s.startsWith("SELECT body FROM sandbox_records")) return records.find((r) => r.record_id === String(args[2])) || null;
    return null;
  };

  return {
    _points: points,
    VISITOR_SALT: "test-salt",
    ADMIN_TOKEN: "admin-token",
    ASSETS: { fetch: async () => new Response("landing page") },
    ANALYTICS: { writeDataPoint: (p) => points.push(p) },
    RATE_LIMITS: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
    DB: {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: async () => query(sql, args),
          all: async () => ({ results: sql.includes("sandbox_records") ? records : [] }),
          run: async () => ({ success: true }),
        }),
      }),
      batch: async () => [],
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
  assert.equal(res.status, 402);
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

test("exports CSV with a filename and the right content type", async () => {
  const res = await call("/v1/admin/export?dataset=daily", { headers: { authorization: "Bearer admin-token" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="flaky-daily-\d{4}-\d{2}-\d{2}\.csv"/);
  // Check the bytes, not res.text(): "UTF-8 decode" strips a leading BOM by
  // spec, so the string would look BOM-less even when the wire format has one.
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "starts with a UTF-8 BOM for Excel");
  assert.equal(new TextDecoder().decode(bytes.slice(3)), "day,requests,errors\r\n");
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
  assert.equal(res.headers.get("x-ratelimit-degraded"), "1", "and it says so");
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

test("runs the nightly job without throwing", async () => {
  await worker.scheduled({}, makeEnv(), ctx);
  await Promise.allSettled(waits);
});
