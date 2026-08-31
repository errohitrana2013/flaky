import { RESOURCES, COUNTS } from "../data/index.js";
import { RELATIONS } from "../data/relations.js";
import { TIERS, MAX_INJECTED_DELAY_MS } from "../config/tiers.js";
import { json } from "../lib/response.js";

// GET /v1/openapi.json
//
// Generated from the same values as /v1/meta — RESOURCES, RELATIONS, COUNTS and
// TIERS — so the spec cannot drift from what the API does. Adding a resource to
// the generator makes it appear here too, with no second place to remember.
//
// This exists because a spec is the difference between "read the docs and type
// it out" and "import it into Postman". Nothing else in this category publishes
// one, and scanners probing for /v1/openapi.json is how the gap got noticed.

const CHAOS_PARAMS = [
  {
    name: "_delay",
    description: `Stall this many milliseconds before responding, 0 to ${MAX_INJECTED_DELAY_MS}. Anything else is a 400.`,
    schema: { type: "integer", minimum: 0, maximum: MAX_INJECTED_DELAY_MS, example: 3000 },
  },
  {
    name: "_status",
    description: "Force this HTTP status. 100 to 599; 200 means behave normally. Anything else is a 400.",
    schema: { type: "integer", minimum: 100, maximum: 599, example: 503 },
  },
  {
    name: "_fail_rate",
    description: "Probability from 0 to 1 that this request returns 500. Rolled independently per request.",
    schema: { type: "number", minimum: 0, maximum: 1, example: 0.3 },
  },
];

const QUERY_PARAMS = [
  { name: "_limit", description: "Page size. Capped at your tier's maximum rather than rejected.", schema: { type: "integer", minimum: 1, example: 10 } },
  { name: "_page", description: "1-based page number.", schema: { type: "integer", minimum: 1 } },
  { name: "_start", description: "Offset, the json-server form. Wins over _page when both are given.", schema: { type: "integer", minimum: 0 } },
  { name: "_sort", description: "Field to sort by.", schema: { type: "string" } },
  { name: "_order", description: "asc (default) or desc.", schema: { type: "string", enum: ["asc", "desc"] } },
  { name: "_q", description: "Full-text search across the whole record.", schema: { type: "string" } },
];

const param = (p) => ({ name: p.name, in: "query", required: false, description: p.description, schema: p.schema });

const errorResponse = (description) => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
});

function pathsFor(resource) {
  const collection = { type: "array", items: { type: "object", additionalProperties: true } };
  const listParams = [...QUERY_PARAMS, ...CHAOS_PARAMS].map(param);

  const paths = {
    [`/${resource}`]: {
      get: {
        summary: `List ${resource}`,
        description: `${COUNTS[resource]} records. Any field can also be used as a filter, e.g. ?userId=3.`,
        tags: [resource],
        parameters: listParams,
        responses: {
          200: {
            description: "Matching records. x-total-count carries the unfiltered total.",
            content: { "application/json": { schema: collection } },
          },
          400: errorResponse("A query parameter was out of range or not recognised."),
          429: errorResponse("Daily request limit reached."),
        },
      },
      post: {
        summary: `Create a ${resource} record (echoed, not stored)`,
        description:
          "Returns the record with an id, exactly as JSONPlaceholder does, and does not persist it. " +
          "The response carries x-mock-write to say so. Use a sandbox for writes that stick.",
        tags: [resource],
        requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        responses: { 201: { description: "The echoed record." } },
      },
    },
    [`/${resource}/{id}`]: {
      get: {
        summary: `Get one ${resource} record`,
        tags: [resource],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1, maximum: COUNTS[resource] } },
          ...CHAOS_PARAMS.map(param),
        ],
        responses: {
          200: { description: "The record." },
          404: errorResponse("No record with that id."),
        },
      },
    },
  };

  for (const [child, foreignKey] of Object.entries(RELATIONS[resource] || {})) {
    paths[`/${resource}/{id}/${child}`] = {
      get: {
        summary: `List the ${child} belonging to a ${resource}`,
        description: `Matches on ${child}.${foreignKey}.`,
        tags: [resource],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
          ...listParams,
        ],
        responses: { 200: { description: `Matching ${child}.` } },
      },
    };
  }

  return paths;
}

export function getOpenApi(ctx) {
  const paths = Object.assign({}, ...RESOURCES.map(pathsFor));

  paths["/keys"] = {
    post: {
      summary: "Issue a free API key",
      description:
        "No confirmation email; the key is returned immediately. Asking again with the same address " +
        "returns the key you already have rather than minting another.",
      tags: ["account"],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } } } },
      },
      responses: {
        201: { description: "A new key. Shown once." },
        200: { description: "The key this address already had." },
        400: errorResponse("The email was not valid."),
        429: errorResponse("Too many new keys from this address today."),
      },
    },
  };

  paths["/sandbox"] = {
    post: {
      summary: "Create a sandbox where writes persist",
      description: "Needs a key. Lives 24 hours. Writes inside it are stored; everything outside is read-only.",
      tags: ["sandbox"],
      security: [{ bearerAuth: [] }],
      responses: {
        201: { description: "The sandbox id and its base URL." },
        403: errorResponse("The anonymous tier does not include sandboxes."),
        429: errorResponse("Your tier's sandbox allowance is already in use."),
      },
    },
  };

  paths["/sandbox/{sandboxId}/{resource}"] = {
    get: { summary: "List records in a sandbox", tags: ["sandbox"], parameters: [
      { name: "sandboxId", in: "path", required: true, schema: { type: "string" } },
      { name: "resource", in: "path", required: true, schema: { type: "string", enum: RESOURCES } },
    ], responses: { 200: { description: "Base data merged with your changes." }, 410: errorResponse("The sandbox expired.") } },
    post: { summary: "Create a record that persists", tags: ["sandbox"], parameters: [
      { name: "sandboxId", in: "path", required: true, schema: { type: "string" } },
      { name: "resource", in: "path", required: true, schema: { type: "string", enum: RESOURCES } },
    ], responses: { 201: { description: "The stored record." }, 413: errorResponse("Record larger than 64 KB.") } },
  };

  paths["/meta"] = {
    get: {
      summary: "Machine-readable description of the API",
      description: "Resource names, row counts, tier limits, and which tier you are on.",
      tags: ["account"],
      responses: { 200: { description: "The description." } },
    },
  };

  return json(
    {
      openapi: "3.1.0",
      info: {
        title: "flaky",
        version: "1.0.0",
        summary: "A mock REST API that fails on purpose.",
        description:
          "Real-looking data at real URLs, with the same resource shapes as JSONPlaceholder. " +
          "The difference is that the caller decides how it behaves: _delay, _status and _fail_rate " +
          "work on every endpoint, so a slow or broken backend is a query parameter rather than a " +
          "local mock server.\n\n" +
          "Out-of-range values are rejected with a 400 rather than ignored — a tool for testing " +
          "failures should not fail quietly itself.",
        license: { name: "MIT", identifier: "MIT" },
        contact: { url: "https://github.com/errohitrana2013/flaky/issues" },
      },
      servers: [{ url: "https://flakyapi.dev/v1", description: "Production" }],
      tags: [
        ...RESOURCES.map((name) => ({ name, description: `${COUNTS[name]} records` })),
        { name: "sandbox", description: "Writes that persist for 24 hours" },
        { name: "account", description: "Keys and API description" },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: `Optional. Without a key you get the anonymous tier: ${TIERS.anonymous.requestsPerDay} requests/day. A free key raises that to ${TIERS.free.requestsPerDay} and adds a sandbox.`,
          },
        },
        schemas: {
          Error: {
            type: "object",
            properties: {
              error: {
                type: "object",
                properties: {
                  status: { type: "integer" },
                  message: { type: "string" },
                  hint: { type: "string", description: "What to do about it." },
                },
              },
            },
          },
        },
      },
      paths,
    },
    { headers: { "cache-control": "public, max-age=300" } }
  );
}
