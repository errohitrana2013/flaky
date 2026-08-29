import { DATA, RESOURCES } from "../data/index.js";
import { json, fail, echo } from "../lib/response.js";
import { queryCollection, pageHeaders } from "../lib/query.js";
import { TIERS, SANDBOX_TTL_MS, MAX_SANDBOX_RECORD_BYTES, MAX_SANDBOX_RECORDS } from "../config/tiers.js";

// A sandbox is an overlay, not a copy. The base dataset stays shared and
// cacheable; only the records a user has touched are stored in D1. That keeps
// storage proportional to what people actually change.

// POST /v1/sandbox
export async function createSandbox(ctx) {
  const allowance = TIERS[ctx.auth.tier].sandboxes;

  if (allowance === 0) {
    // 403, not 402. The caller is not unauthenticated — anonymous is a valid
    // tier — they are authenticated as a tier that does not include sandboxes.
    // 402 also reads as a billing failure, which misleads clients that treat it
    // as "payment declined" when the fix is a free key.
    return fail(403, "Sandboxes need an API key", "Create a free key at POST /v1/keys, then send it as a Bearer token.");
  }

  const live = await ctx.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM sandboxes WHERE key_id = ? AND expires_at > ?"
  ).bind(ctx.auth.keyId, Date.now()).first();

  if (live.count >= allowance) {
    return fail(429, "Sandbox limit reached", `Your tier allows ${allowance} live sandbox(es).`);
  }

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const expiresAt = Date.now() + SANDBOX_TTL_MS;

  await ctx.env.DB.prepare(
    "INSERT INTO sandboxes (id, key_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(id, ctx.auth.keyId, Date.now(), expiresAt).run();

  return json({
    id,
    expiresAt: new Date(expiresAt).toISOString(),
    baseUrl: `/v1/sandbox/${id}`,
    note: "Writes here persist until it expires. Everything outside /v1/sandbox is read-only.",
  }, { status: 201 });
}

async function loadSandbox(env, sandboxId) {
  const row = await env.DB.prepare("SELECT id, expires_at FROM sandboxes WHERE id = ?").bind(sandboxId).first();
  if (!row) return { error: fail(404, "No such sandbox", "Create one at POST /v1/sandbox.") };
  if (row.expires_at < Date.now()) return { error: fail(410, "Sandbox expired", "Create a fresh one at POST /v1/sandbox.") };
  return { sandbox: row };
}

// Merge the base dataset with this sandbox's overrides.
async function materialise(env, sandboxId, resource) {
  const overrides = await env.DB.prepare(
    "SELECT record_id, body, deleted FROM sandbox_records WHERE sandbox_id = ? AND resource = ?"
  ).bind(sandboxId, resource).all();

  const patched = new Map(overrides.results.map((row) => [String(row.record_id), row]));

  const rows = DATA[resource]
    .map((row) => {
      const override = patched.get(String(row.id));
      if (!override) return row;
      return override.deleted ? null : JSON.parse(override.body);
    })
    .filter(Boolean);

  // Records created inside the sandbox have no counterpart in the base data.
  for (const [recordId, row] of patched) {
    if (!row.deleted && !DATA[resource].some((base) => String(base.id) === recordId)) {
      rows.push(JSON.parse(row.body));
    }
  }

  return rows;
}

const upsert = (env, sandboxId, resource, recordId, record, deleted = 0) =>
  env.DB.prepare(
    "INSERT OR REPLACE INTO sandbox_records (sandbox_id, resource, record_id, body, deleted) VALUES (?, ?, ?, ?, ?)"
  ).bind(sandboxId, resource, String(recordId), JSON.stringify(record), deleted).run();

// * /v1/sandbox/:sandboxId/:resource/:id?
export async function handleSandbox(ctx) {
  const { sandboxId, resource, id } = ctx.params;
  const { error } = await loadSandbox(ctx.env, sandboxId);
  if (error) return error;

  if (!RESOURCES.includes(resource)) {
    return fail(404, `Unknown resource '${echo(resource)}'`, `Available: ${RESOURCES.join(", ")}`);
  }

  const method = ctx.request.method;

  if (method === "GET") {
    const rows = await materialise(ctx.env, sandboxId, resource);
    if (id) {
      const found = rows.find((row) => String(row.id) === id);
      return found ? json(found) : fail(404, `No ${echo(resource)} with id ${echo(id)}`);
    }
    const page = queryCollection(rows, ctx.query, TIERS[ctx.auth.tier].maxLimit);
    return json(page.rows, { headers: pageHeaders(page) });
  }

  // Reject on the declared length before reading the body, so an oversized
  // payload is refused rather than buffered.
  const declared = Number(ctx.request.headers.get("content-length")) || 0;
  if (declared > MAX_SANDBOX_RECORD_BYTES) {
    return fail(
      413,
      "Record too large",
      `Sandbox records are capped at ${MAX_SANDBOX_RECORD_BYTES / 1024} KB. This is a mock API, not storage.`
    );
  }

  const body = await ctx.request.json().catch(() => ({}));

  // A chunked request has no content-length, so the parsed size is checked too.
  if (JSON.stringify(body).length > MAX_SANDBOX_RECORD_BYTES) {
    return fail(413, "Record too large", `Sandbox records are capped at ${MAX_SANDBOX_RECORD_BYTES / 1024} KB.`);
  }

  if (method === "POST") {
    // Only new records can grow a sandbox, so the count is checked here and not
    // on the update paths below.
    const stored = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sandbox_records WHERE sandbox_id = ?"
    ).bind(sandboxId).first();

    if ((stored?.count || 0) >= MAX_SANDBOX_RECORDS) {
      return fail(
        429,
        "Sandbox is full",
        `A sandbox holds ${MAX_SANDBOX_RECORDS} records. Create a fresh one at POST /v1/sandbox.`
      );
    }

    const record = { id: Date.now(), ...body };
    await upsert(ctx.env, sandboxId, resource, record.id, record);
    return json(record, { status: 201 });
  }

  if (!id) {
    return fail(405, `${method} needs a record id`, `Try ${method} /v1/sandbox/${echo(sandboxId)}/${echo(resource)}/1`);
  }

  if (method === "DELETE") {
    await upsert(ctx.env, sandboxId, resource, id, {}, 1);
    return json({ deleted: true, id: Number(id) });
  }

  if (method === "PUT" || method === "PATCH") {
    const stored = await ctx.env.DB.prepare(
      "SELECT body FROM sandbox_records WHERE sandbox_id = ? AND resource = ? AND record_id = ?"
    ).bind(sandboxId, resource, String(id)).first();

    const base = stored ? JSON.parse(stored.body) : DATA[resource].find((row) => String(row.id) === id);
    if (!base) return fail(404, `No ${echo(resource)} with id ${echo(id)}`);

    // PUT replaces, PATCH merges.
    const record = method === "PUT" ? { id: base.id, ...body } : { ...base, ...body };
    await upsert(ctx.env, sandboxId, resource, id, record);
    return json(record);
  }

  return fail(405, `${echo(method)} is not supported here`);
}
