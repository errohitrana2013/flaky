// The /custom page, run for real in a DOM stub.
//
// `node --check` proves the file parses and the e2e checks prove it is served;
// neither notices that a saved API is never restored, which is the entire point
// of the code below. This executes public/custom.js the way a browser does —
// top-level first, then the handlers it registered.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync("public/custom.js", "utf8");

const DAY = 24 * 60 * 60 * 1000;

const made = (expiresIn) => ({
  id: "0123456789abcdef",
  baseUrl: "/v1/custom/0123456789abcdef",
  expiresAt: new Date(Date.now() + expiresIn).toISOString(),
  resources: [{ name: "todos", count: 3, url: "/v1/custom/0123456789abcdef/todos" }],
});

// Thin enough to read, thick enough to run the page. Every element records what
// was written to it, so a test can assert something arrived rather than that
// nothing threw.
function load({ stored = null, respond } = {}) {
  const nodes = new Map();
  const handlers = new Map();
  // A string is stored verbatim, so a test can hand it something unparseable.
  const store = new Map(
    stored ? [["flaky.custom.v1", typeof stored === "string" ? stored : JSON.stringify(stored)]] : []
  );
  const requested = [];

  // The two panels custom.html ships with a `hidden` attribute. Starting them
  // visible would let "never touched" pass as "shown".
  const element = (id) => ({
    id,
    value: "",
    hidden: id === "result" || id === "error",
    _html: "",
    _text: "",
    classList: { toggle() {}, add() {}, remove() {} },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    addEventListener(event, fn) { handlers.set(`${id}:${event}`, fn); },
    querySelector: () => element(`${id} child`),
    scrollIntoView() {},
    focus() {},
    remove() {},
    click() {},
  });
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    TextEncoder,
    setInterval: () => 0,
    document: { getElementById: el, createElement: () => element("a"), body: { appendChild() {} } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    location: { origin: "https://flakyapi.dev" },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    fetch: async (url, init) => {
      requested.push(url);
      return respond ? respond(url, init) : { ok: true, status: 200, json: async () => ({}) };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  return { el, store, requested, fire: (key, ...args) => handlers.get(key)?.(...args) };
}

test("restores a saved API on load, exactly as it was rendered", async () => {
  const data = made(DAY);
  const { el, requested } = load({ stored: { data, json: '{"todos":[]}' } });

  assert.equal(el("result").hidden, false);
  assert.match(el("endpoints").innerHTML, /todos/);
  assert.match(el("chaos").textContent, /_status=503/);
  assert.match(el("expires").textContent, /in 23h/);
  assert.equal(el("json").value, '{"todos":[]}', "the JSON they pasted comes back too");

  // Asks the server whether it is still there, and does not wipe the panel on a 200.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(requested, ["/v1/custom/0123456789abcdef"]);
  assert.equal(el("result").hidden, false);
});

test("drops an API whose day is up rather than showing dead links", () => {
  const { el, store, requested } = load({ stored: { data: made(-1000), json: "{}" } });

  assert.equal(el("result").hidden, true);
  assert.equal(store.has("flaky.custom.v1"), false);
  assert.deepEqual(requested, [], "nothing to verify — it was never rendered");
});

test("drops one the server no longer has", async () => {
  const data = made(DAY);
  const { el, store } = load({
    stored: { data, json: "{}" },
    respond: async () => ({ ok: false, status: 410, json: async () => ({}) }),
  });

  await new Promise((r) => setImmediate(r));
  assert.equal(el("result").hidden, true);
  assert.equal(store.has("flaky.custom.v1"), false);
  assert.equal(el("error").hidden, false);
});

test("survives storage that is unavailable or corrupt", () => {
  assert.equal(load({ stored: "{ not json" }).el("result").hidden, true);
  assert.equal(load({ stored: '{"data":{"baseUrl":"/v1/custom/x"}}' }).el("result").hidden, true);
});

test("creating an API saves it, and creating another replaces it", async () => {
  const first = made(DAY);
  const second = { ...made(DAY), id: "fedcba9876543210", baseUrl: "/v1/custom/fedcba9876543210" };
  let next = first;

  const { el, store, fire } = load({ respond: async () => ({ ok: true, status: 201, json: async () => next }) });

  el("json").value = '{"todos":[{"id":1}]}';
  await fire("create:click");
  assert.equal(JSON.parse(store.get("flaky.custom.v1")).data.id, first.id);

  next = second;
  el("json").value = '{"users":[{"id":1}]}';
  await fire("create:click");

  const saved = JSON.parse(store.get("flaky.custom.v1"));
  assert.equal(saved.data.id, second.id, "the newest one is what comes back on a refresh");
  assert.equal(saved.json, '{"users":[{"id":1}]}');
});

test("a failed create leaves the previous one alone", async () => {
  const data = made(DAY);
  const { el, store, fire } = load({
    stored: { data, json: "{}" },
    respond: async (url) =>
      url === "/v1/custom"
        ? { ok: false, status: 429, json: async () => ({ error: { message: "Too many", hint: "tomorrow" } }) }
        : { ok: true, status: 200, json: async () => ({}) },
  });

  el("json").value = '{"todos":[]}';
  await fire("create:click");

  assert.equal(JSON.parse(store.get("flaky.custom.v1")).data.id, data.id);
  assert.equal(el("error").hidden, false);
});
