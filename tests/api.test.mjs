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
