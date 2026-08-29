import { DATA, RESOURCES } from "../data/index.js";
import { RELATIONS, childrenOf } from "../data/relations.js";
import { json, fail } from "../lib/response.js";
import { queryCollection, pageHeaders } from "../lib/query.js";
import { TIERS } from "../config/tiers.js";
import { READ_CACHE_SECONDS } from "../config/constants.js";

const unknownResource = (name) =>
  fail(404, `Unknown resource '${name}'`, `Available resources: ${RESOURCES.join(", ")}.`);

// GET /v1/:resource
// GET /v1/:resource/:id
// GET /v1/:resource/:id/:child
export function readResource(ctx) {
  const { resource, id, child } = ctx.params;
  if (!RESOURCES.includes(resource)) return unknownResource(resource);

  const maxLimit = TIERS[ctx.auth.tier].maxLimit;
  const cache = { "cache-control": `public, max-age=${READ_CACHE_SECONDS}` };

  if (child) {
    const foreignKey = RELATIONS[resource]?.[child];
    if (!foreignKey) {
      const known = childrenOf(resource);
      return fail(
        404,
        `'${resource}' has no nested '${child}'`,
        known.length
          ? `Known nested routes for ${resource}: ${known.join(", ")}.`
          : `Known nested routes: none for ${resource}. Try /v1/posts/1/comments.`
      );
    }

    const rows = DATA[child].filter((row) => String(row[foreignKey]) === id);
    const page = queryCollection(rows, ctx.query, maxLimit);
    return json(page.rows, { headers: { ...pageHeaders(page), ...cache } });
  }

  if (id) {
    const found = DATA[resource].find((row) => String(row.id) === id);
    return found
      ? json(found, { headers: cache })
      : fail(404, `No ${resource} with id ${id}`, `Ids run from 1 to ${DATA[resource].length}.`);
  }

  const page = queryCollection(DATA[resource], ctx.query, maxLimit);
  return json(page.rows, { headers: { ...pageHeaders(page), ...cache } });
}

// POST/PUT/PATCH/DELETE /v1/:resource[/:id]
//
// Echoed, never stored. JSONPlaceholder does the same and it confuses people
// every time, so the response says so in a header rather than leaving them to
// discover it when their write vanishes.
export async function echoWrite(ctx) {
  const { resource, id } = ctx.params;
  if (!RESOURCES.includes(resource)) return unknownResource(resource);

  const method = ctx.request.method;
  const headers = {
    "x-mock-write": "not-persisted; use /v1/sandbox for real writes",
    "cache-control": "no-store",
  };

  if (method === "DELETE") {
    return json({ deleted: true, id: Number(id) || null }, { headers });
  }

  const body = await ctx.request.json().catch(() => ({}));

  if (method === "POST") {
    const nextId = DATA[resource].length + 1;
    return json({ id: nextId, ...body }, { status: 201, headers });
  }

  // PUT replaces, PATCH merges — same contract as the sandbox, so switching
  // from echo to persisted writes is a URL change and nothing else.
  const base = DATA[resource].find((row) => String(row.id) === id);
  if (!base) return fail(404, `No ${resource} with id ${id}`);

  const record = method === "PUT" ? { id: base.id, ...body } : { ...base, ...body };
  return json(record, { headers });
}
