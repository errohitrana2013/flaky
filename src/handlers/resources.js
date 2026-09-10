import { DATA, RESOURCES } from "../data/index.js";
import { RELATIONS, childrenOf } from "../data/relations.js";
import { json, fail, echo } from "../lib/response.js";
import { queryCollection, pageHeaders } from "../lib/query.js";
import { wrongMethod } from "../lib/allow.js";
import { TIERS } from "../config/tiers.js";
import { READ_CACHE_SECONDS } from "../config/constants.js";

const unknownResource = (name) =>
  fail(404, `Unknown resource '${echo(name)}'`, `Available resources: ${RESOURCES.join(", ")}.`);

function unknownNested(resource, child) {
  const known = childrenOf(resource);
  return fail(
    404,
    `'${echo(resource)}' has no nested '${echo(child)}'`,
    known.length
      ? `Known nested routes for ${echo(resource)}: ${known.join(", ")}.`
      : `Known nested routes: none for ${echo(resource)}. Try /v1/posts/1/comments.`
  );
}

const noRecord = (resource, id) =>
  fail(404, `No ${echo(resource)} with id ${echo(id)}`, `Ids run from 1 to ${DATA[resource].length}.`);

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
    if (!foreignKey) return unknownNested(resource, child);

    const rows = DATA[child].filter((row) => String(row[foreignKey]) === id);
    const page = queryCollection(rows, ctx.query, maxLimit);
    return json(page.rows, { headers: { ...pageHeaders(page), ...cache } });
  }

  if (id) {
    const found = DATA[resource].find((row) => String(row.id) === id);
    return found ? json(found, { headers: cache }) : noRecord(resource, id);
  }

  const page = queryCollection(DATA[resource], ctx.query, maxLimit);
  return json(page.rows, { headers: { ...pageHeaders(page), ...cache } });
}

// POST             /v1/:resource
// PUT/PATCH/DELETE /v1/:resource/:id
// POST             /v1/:resource/:id/:child
//
// Echoed, never stored. JSONPlaceholder does the same and it confuses people
// every time, so the response says so in a header rather than leaving them to
// discover it when their write vanishes.
export async function echoWrite(ctx) {
  const { resource, id, child } = ctx.params;
  if (!RESOURCES.includes(resource)) return unknownResource(resource);

  const foreignKey = child ? RELATIONS[resource]?.[child] : null;
  if (child && !foreignKey) return unknownNested(resource, child);

  const method = ctx.request.method;
  const refused = wrongMethod(method, { at: "/v1", resource, id, child });
  if (refused) return refused;

  const headers = {
    "x-mock-write": "not-persisted; use /v1/sandbox for real writes",
    "cache-control": "no-store",
  };

  if (method === "DELETE") {
    return json({ deleted: true, id: Number(id) || null }, { headers });
  }

  const body = await ctx.request.json().catch(() => ({}));

  if (method === "POST" && child) {
    // The path decides the parent, whatever the body says: a comment sent to
    // /v1/posts/1/comments belongs to post 1. And the parent has to exist — a
    // record pointing at nothing is not a success.
    const parent = DATA[resource].find((row) => String(row.id) === id);
    if (!parent) return noRecord(resource, id);
    return json({ id: DATA[child].length + 1, ...body, [foreignKey]: parent.id }, { status: 201, headers });
  }

  if (method === "POST") {
    const nextId = DATA[resource].length + 1;
    return json({ id: nextId, ...body }, { status: 201, headers });
  }

  // PUT replaces, PATCH merges — same contract as the sandbox, so switching
  // from echo to persisted writes is a URL change and nothing else.
  const base = DATA[resource].find((row) => String(row.id) === id);
  if (!base) return noRecord(resource, id);

  const record = method === "PUT" ? { id: base.id, ...body } : { ...base, ...body };
  return json(record, { headers });
}
