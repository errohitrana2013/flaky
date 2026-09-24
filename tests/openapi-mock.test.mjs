// The OpenAPI-to-records converter behind /v1/custom/openapi.
//
// Pure, so it is tested directly: a spec in, records and reasons out. What is
// being held here is that every route is either served or accounted for, that
// the records are the shapes the spec promised, and that the same spec always
// gives the same records.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { specToMock } from "../src/lib/openapi-mock.js";

const example = JSON.parse(readFileSync("src/config/example.js", "utf8").match(/CUSTOM_SPEC_EXAMPLE = `([\s\S]*?)`;/)[1]);

const ok = (schema) => ({ 200: { description: "ok", content: { "application/json": { schema } } } });
const v3 = (paths, schemas = {}) => ({ openapi: "3.0.3", info: { title: "t", version: "1" }, paths, components: { schemas } });

test("the example spec becomes customers and orders, with the prefix taken off", () => {
  const m = specToMock(example);
  assert.deepEqual(Object.keys(m.data), ["customers", "orders"]);
  assert.equal(m.data.customers.length, 10);
  // The shared /api/v1 is the base URL, not part of either resource name — and
  // the person is told what to swap for the mock.
  assert.equal(m.replaces, "https://api.example.com/api/v1");
  assert.deepEqual(m.info, { title: "Orders API", version: "1.0.0" });
});

test("records have the fields and types the spec describes", () => {
  const { data } = specToMock(example);
  for (const c of data.customers) {
    assert.deepEqual(Object.keys(c), ["id", "name", "email", "city"]);
    assert.equal(typeof c.id, "number");
    assert.match(c.email, /^[a-z]+\.[a-z]+@example\.com$/, "an address a validator accepts, accents and all");
  }
  for (const o of data.orders) {
    assert.ok(["placed", "shipped", "delivered", "cancelled"].includes(o.status), "enum values only");
    assert.ok(!Number.isNaN(Date.parse(o.createdAt)));
    assert.equal(typeof o.total, "number");
  }
});

test("ids are positions, and a foreign key points at a record that exists", () => {
  const { data } = specToMock(example);
  assert.deepEqual(data.customers.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const ids = new Set(data.customers.map((c) => c.id));
  // customerId → customers: following it has to find someone, or the app's
  // "load the customer for this order" path is tested against a 404.
  assert.ok(data.orders.every((o) => ids.has(o.customerId)));
});

test("a person's name, email and username agree with each other", () => {
  const m = specToMock(v3({ "/users": { get: { responses: ok({ type: "array", items: { $ref: "#/components/schemas/U" } }) } } }, {
    U: { type: "object", properties: { id: { type: "integer" }, firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string" }, username: { type: "string" } } },
  }));
  for (const u of m.data.users) {
    const plain = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    assert.equal(u.email, `${plain(u.firstName)}.${plain(u.lastName)}@example.com`);
    assert.ok(u.username.startsWith(plain(u.firstName)));
  }
});

test("the same spec always gives the same records", () => {
  assert.deepEqual(specToMock(example), specToMock(example));
  // And adding a resource does not reshuffle the others.
  const more = structuredClone(example);
  more.paths["/api/v1/tags"] = { get: { responses: ok({ type: "array", items: { type: "string" } }) } };
  assert.deepEqual(specToMock(more).data.orders, specToMock(example).data.orders);
});

test("every route is served or accounted for", () => {
  const m = specToMock(example);
  // The POST is not mocked, and says so rather than vanishing.
  assert.match(m.skipped[0].path, /^1 write operation$/);
  // The { data: [...] } wrapper is served as a bare array — a difference the
  // app will feel, so it is a warning and not a footnote.
  assert.ok(m.warnings.some((w) => w.includes('{"data": [...]}')));
});

test("routes the mock cannot serve are skipped with the reason", () => {
  const item = { $ref: "#/components/schemas/P" };
  const m = specToMock(v3({
    "/pets": { get: { responses: ok({ type: "array", items: item }) } },
    "/pets/{id}/owners": { get: { responses: ok({ type: "array", items: item }) } },
    "/pets/find/byTag": { get: { responses: ok({ type: "array", items: item }) } },
    "/me": { get: { responses: ok(item) } },
    "/blobs": { get: { responses: { 200: { description: "a file", content: { "image/png": {} } } } } },
    "/things": { get: { responses: ok({ type: "array" }) } },
    "/export": { get: { responses: ok({ type: "array", items: item }) } },
  }, { P: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } }));

  assert.deepEqual(Object.keys(m.data), ["pets"]);
  const why = Object.fromEntries(m.skipped.map((s) => [s.path, s.reason]));
  assert.match(why["GET /pets/{id}/owners"], /Nested/);
  assert.match(why["GET /pets/find/byTag"], /More than one segment/);
  assert.match(why["GET /me"], /single object/);
  assert.match(why["GET /blobs"], /No JSON response schema/);
  assert.match(why["GET /things"], /not what is in it/, "ten empty objects would test nothing");
  assert.match(why["GET /export"], /downloads/);
});

test("Swagger 2.0 reads the same way", () => {
  const m = specToMock({
    swagger: "2.0", info: { title: "old", version: "1" }, host: "api.old.example", basePath: "/v2",
    paths: { "/pets": { get: { responses: { 200: { description: "ok", schema: { type: "array", items: { $ref: "#/definitions/Pet" } } } } } } },
    definitions: { Pet: { type: "object", properties: { id: { type: "integer", format: "int64" }, name: { type: "string" } } } },
  });
  assert.deepEqual(Object.keys(m.data), ["pets"]);
  assert.equal(m.data.pets[0].id, 1);
  assert.equal(m.replaces, "https://api.old.example/v2");
});

test("allOf, oneOf, nullable types and recursive schemas all produce a record", () => {
  const m = specToMock(v3({ "/nodes": { get: { responses: ok({ type: "array", items: { $ref: "#/components/schemas/Node" } }) } } }, {
    Base: { type: "object", properties: { id: { type: "integer" } } },
    Node: {
      allOf: [{ $ref: "#/components/schemas/Base" }, {
        type: "object",
        properties: {
          label: { type: ["string", "null"] },
          kind: { oneOf: [{ type: "null" }, { type: "string", enum: ["leaf", "branch"] }] },
          // A tree: without a depth limit this never ends.
          children: { type: "array", items: { $ref: "#/components/schemas/Node" } },
        },
      }],
    },
  }));
  const n = m.data.nodes[0];
  assert.equal(n.id, 1);
  assert.equal(typeof n.label, "string");
  assert.ok(["leaf", "branch"].includes(n.kind));
  assert.ok(Array.isArray(n.children));
});

test("examples are used, but ten identical users are not", () => {
  const m = specToMock(v3({ "/users": { get: { responses: ok({ type: "array", items: {
    type: "object", properties: { id: { type: "integer" }, email: { type: "string", example: "john@email.com" }, plan: { type: "string", example: "pro" } },
  } }) } } }));
  const users = m.data.users;
  assert.equal(users[0].email, "john@email.com", "the spec's own example comes first");
  assert.equal(new Set(users.map((u) => u.email)).size, 10, "then every email differs");
  // Nothing better than "plan 3" is on offer, so the example stands.
  assert.ok(users.every((u) => u.plan === "pro"));
});

test("an /{id} route that is not looked up by id warns how to reach it", () => {
  const m = specToMock(v3({ "/users/{username}": { get: { responses: ok({ type: "object", properties: { id: { type: "integer" }, username: { type: "string" } } }) } } }));
  assert.deepEqual(Object.keys(m.data), ["users"]);
  assert.ok(m.warnings.some((w) => /looked up by "id".*\/users\/1/.test(w)));
});

test("records too large for the limit are halved rather than refused", () => {
  const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`field${i}`, { type: "string", minLength: 200 }]));
  const m = specToMock(v3({ "/rows": { get: { responses: ok({ type: "array", items: { type: "object", properties: wide } }) } } }), { maxBytes: 60000 });
  assert.ok(m.data.rows.length < 10 && m.data.rows.length >= 1);
  assert.ok(JSON.stringify(m.data).length <= 60000);
  assert.ok(m.warnings.some((w) => /instead of 10/.test(w)));
});

test("anything that is not a spec is refused with a way forward", () => {
  assert.match(specToMock([]).error.message, /not an OpenAPI document/);
  assert.match(specToMock({ users: [] }).error.hint, /createMockServer/, "someone who pasted data is sent to the right page");
  assert.match(specToMock({ openapi: "3.1.0", paths: {} }).error.message, /no paths/);
});

test("a $ref outside the document is reported, not followed", () => {
  const m = specToMock(v3({ "/users": { get: { responses: ok({ type: "array", items: { type: "object", properties: {
    id: { type: "integer" }, address: { $ref: "https://other.example/schemas.json#/Address" },
  } } }) } } }));
  assert.equal(m.data.users[0].address, null);
  assert.ok(m.warnings.some((w) => w.includes("points outside this document")));
});
