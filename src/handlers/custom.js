import { json, fail, echo } from "../lib/response.js";
import { queryCollection, pageHeaders } from "../lib/query.js";
import { today } from "../lib/hash.js";
import { TIERS, MAX_CUSTOM_BYTES, DAY_MS, CUSTOM_DEFAULT_DAYS, CUSTOM_MAX_DAYS, CUSTOM_PER_IP_PER_DAY } from "../config/tiers.js";
import { CUSTOM_EXAMPLE } from "../config/example.js";
import { nodeRunner, pythonRunner, javaRunner, csharpRunner } from "./runner.js";

// Paste JSON, get a REST API for it, for one to nine days.
//
// The whole point is that nothing else has to happen: no account, no schema, no
// dashboard. Someone with a JSON file gets working endpoints before they have
// finished reading the paragraph telling them how.
//
// Every chaos parameter works on these routes too, which is the actual reason
// this belongs here rather than being a separate product — you can point your
// app at your own shapes and still ask for the 503.

const ID = /^[0-9a-f]{16}$/;

// Accepts either {users: [...], posts: [...]} or a bare [...] which becomes
// "items". Anything else has no resources to serve.
function collections(parsed) {
  if (Array.isArray(parsed)) return { items: parsed };
  if (!parsed || typeof parsed !== "object") return null;

  const found = Object.entries(parsed).filter(([, v]) => Array.isArray(v));
  return found.length ? Object.fromEntries(found) : null;
}

// The example as it would be stored. Comparing the stored form rather than the
// pasted text means indentation, spacing and trailing newlines do not matter —
// every whitespace variant of the example serialises to this one string, and
// changing a single value makes it stop matching.
const EXAMPLE_BODY = JSON.stringify(collections(JSON.parse(CUSTOM_EXAMPLE)));

// POST /v1/custom
export async function createCustom(ctx) {
  const declared = Number(ctx.request.headers.get("content-length")) || 0;
  if (declared > MAX_CUSTOM_BYTES) {
    return fail(413, "That JSON is too large", `The limit is ${MAX_CUSTOM_BYTES / 1024} KB.`);
  }

  const raw = await ctx.request.text();
  if (raw.length > MAX_CUSTOM_BYTES) {
    return fail(413, "That JSON is too large", `The limit is ${MAX_CUSTOM_BYTES / 1024} KB.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // The one error worth being specific about: they are pasting by hand, and
    // "unexpected token at position 412" is the difference between fixing it and
    // giving up.
    return fail(400, "That is not valid JSON", String(err.message).slice(0, 120));
  }

  const data = collections(parsed);
  if (!data) {
    return fail(
      400,
      "No arrays found",
      'Send either an array, or an object whose values are arrays — {"users":[…],"posts":[…]}. Each array becomes an endpoint.'
    );
  }

  return publish(ctx, data);
}

// Stores a set of collections as a custom API and answers with where it lives.
// Shared with the OpenAPI import, which reaches the same { name: [rows] } by a
// different road; `extra` is whatever that road has to say about the result,
// and `sample` marks the other road's own example coming back in.
export async function publish(ctx, data, extra = {}, { sample = false } = {}) {
  // Checked before anything is counted or stored. A lifetime of 30 quietly
  // served as 9 would be found out on day 10, by a test that suddenly 410s.
  const asked = ctx.query.get("days");
  const days = asked === null ? CUSTOM_DEFAULT_DAYS : Number(asked);
  if (!Number.isInteger(days) || days < 1 || days > CUSTOM_MAX_DAYS) {
    return fail(400, `days must be a whole number from 1 to ${CUSTOM_MAX_DAYS}`,
      `Leave it out for ${CUSTOM_DEFAULT_DAYS} day. For longer than ${CUSTOM_MAX_DAYS}, export it — the export runs locally and never expires.`);
  }

  // Rate limited by address, not by key, because this is meant to work with no
  // account at all. Fails open like everything else.
  if (ctx.env.RATE_LIMITS) {
    const ip = ctx.request.headers.get("cf-connecting-ip");
    if (ip) {
      const bucket = `custom:${today()}:${ip}`;
      try {
        const made = Number(await ctx.env.RATE_LIMITS.get(bucket)) || 0;
        if (made >= CUSTOM_PER_IP_PER_DAY) {
          return fail(429, "Too many custom APIs from this address today", `Up to ${CUSTOM_PER_IP_PER_DAY} a day. Each expires after the days it was created for.`);
        }
        ctx.ctx?.waitUntil?.(
          ctx.env.RATE_LIMITS.put(bucket, String(made + 1), { expirationTtl: 172800 }).catch(() => {})
        );
      } catch { /* a broken counter must not stop someone trying this */ }
    }
  }

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const expiresAt = Date.now() + days * DAY_MS;
  const body = JSON.stringify(data);

  // Country and region only, matching daily_visitors. A summary of the shapes
  // rather than a second copy of them, so the admin list never has to read a
  // quarter-megabyte body to say what an API holds.
  const summary = Object.entries(data)
    .map(([name, rows]) => `${name}:${rows.length}`)
    .join(",")
    .slice(0, 500);

  await ctx.env.DB.prepare(
    `INSERT INTO custom_apis (id, body, bytes, created_at, expires_at, country, region, resources, is_sample)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, body, body.length, Date.now(), expiresAt,
    ctx.request.cf?.country || "XX", ctx.request.cf?.region || "", summary,
    // Recorded, not rejected: the example still has to work like anything else.
    // The flag only decides whether it is worth an operator's attention later.
    body === EXAMPLE_BODY || sample ? 1 : 0
  ).run();

  const base = `/v1/custom/${id}`;
  return json(
    {
      id,
      baseUrl: base,
      expiresAt: new Date(expiresAt).toISOString(),
      days,
      resources: Object.entries(data).map(([name, rows]) => ({
        name,
        count: rows.length,
        url: `${base}/${name}`,
      })),
      chaos: `Every control works here too, e.g. ${base}/${Object.keys(data)[0]}?_status=503`,
      export: {
        server: `${base}/export?format=node`,
        python: `${base}/export?format=python`,
        java: `${base}/export?format=java`,
        csharp: `${base}/export?format=csharp`,
        jsonServer: `${base}/export?format=json-server`,
        msw: `${base}/export?format=msw`,
      },
      note: `Deleted ${days === 1 ? "24 hours" : `${days} days`} from now. Export it if you want to keep it — the export runs locally and never expires.`,
      ...extra,
    },
    { status: 201 }
  );
}

async function load(env, id) {
  if (!ID.test(id)) return { error: fail(404, "No such API", "Ids are 16 hex characters.") };
  const row = await env.DB.prepare("SELECT body, expires_at FROM custom_apis WHERE id = ?").bind(id).first();
  if (!row) return { error: fail(404, "No such API", "It may have expired. Create another at POST /v1/custom.") };
  if (row.expires_at < Date.now()) {
    return { error: fail(410, "That API expired", `Each lasts the days it was created for, 1 to ${CUSTOM_MAX_DAYS}. Create another at POST /v1/custom.`) };
  }
  return { data: JSON.parse(row.body) };
}

// GET /v1/custom/:id
// GET /v1/custom/:id/:resource
// GET /v1/custom/:id/:resource/:recordId
export async function readCustom(ctx) {
  const { id, resource, recordId } = ctx.params;
  const { error, data } = await load(ctx.env, id);
  if (error) return error;

  const cache = { "cache-control": "private, max-age=30" };

  if (!resource) {
    return json({
      id,
      resources: Object.entries(data).map(([name, rows]) => ({ name, count: rows.length, url: `/v1/custom/${id}/${name}` })),
    }, { headers: cache });
  }

  if (resource === "export") return exportCustom(ctx, data, id);

  const rows = data[resource];
  if (!rows) {
    return fail(404, `No '${echo(resource)}' in this API`, `It has: ${Object.keys(data).join(", ")}.`);
  }

  if (recordId) {
    const found = rows.find((row) => String(row?.id) === recordId);
    return found
      ? json(found, { headers: cache })
      : fail(404, `No ${echo(resource)} with id ${echo(recordId)}`, "Records need an `id` field to be addressable.");
  }

  const page = queryCollection(rows, ctx.query, TIERS[ctx.auth.tier].maxLimit);
  return json(page.rows, { headers: { ...pageHeaders(page), ...cache } });
}

// GET /v1/custom/:id/export?format=…
//
// The point of the whole feature. A hosted mock that expires is useful for a
// day; the same data as a file you run locally is useful forever, works offline
// and in CI, and cannot be taken away when this service goes down.
function exportCustom(ctx, data, id) {
  const format = ctx.query.get("format") || "json-server";

  if (format === "json-server") {
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="db.json"`,
        "x-run-with": "npx json-server db.json",
      },
    });
  }

  // A whole server, not just data. json-server can serve db.json but cannot fail
  // on purpose, so a runner that carries the chaos controls is the only way the
  // local copy behaves like the hosted one.
  if (format === "node") {
    return new Response(nodeRunner(data), {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "content-disposition": 'attachment; filename="mock-server.mjs"',
        "x-run-with": "node mock-server.mjs",
      },
    });
  }

  if (format === "python") {
    return new Response(pythonRunner(data), {
      headers: {
        "content-type": "text/x-python; charset=utf-8",
        "content-disposition": 'attachment; filename="mock_server.py"',
        "x-run-with": "python3 mock_server.py",
      },
    });
  }

  // Java and C# are here because the people most likely to be stuck with a
  // hand-rolled fake are on Spring or ASP.NET, where json-server and MSW are not
  // an answer — neither is in their toolchain and neither can fail on demand.
  if (format === "java") {
    return new Response(javaRunner(data), {
      headers: {
        "content-type": "text/x-java-source; charset=utf-8",
        "content-disposition": 'attachment; filename="MockServer.java"',
        "x-run-with": "java MockServer.java",
      },
    });
  }

  if (format === "csharp") {
    return new Response(csharpRunner(data), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="MockServer.cs"',
        "x-run-with": "dotnet run MockServer.cs",
      },
    });
  }

  if (format === "msw") {
    const handlers = Object.entries(data)
      .map(([name]) => `  http.get("*/${name}", () => HttpResponse.json(db.${name})),`)
      .join("\n");
    const file = `// Generated by flakyapi.dev — runs offline, never expires.
//   npm i -D msw
import { http, HttpResponse } from "msw";
import db from "./db.json";

export const handlers = [
${handlers}
];
`;
    return new Response(file, {
      headers: {
        "content-type": "text/javascript",
        "content-disposition": `attachment; filename="handlers.js"`,
      },
    });
  }

  return fail(400, `Unknown format '${echo(format)}'`, "Available: node, python, java, csharp, json-server, msw.");
}
