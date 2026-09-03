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
  {
    name: "_retry_after",
    description: "Seconds to put in the Retry-After header. Only meaningful with _status=429 or 503, where it defaults to 5.",
    schema: { type: "integer", minimum: 0, maximum: 3600, example: 30 },
  },
  {
    name: "_scenario",
    description: "A scenario id from POST /v1/scenario. Runs a deterministic sequence: fail N times then recover (retries, circuit breakers), or succeed N times then fail (rate limits, quotas, expiring tokens).",
    schema: { type: "string", pattern: "^[0-9a-f]{16}$" },
  },
  {
    name: "_malformed",
    description: "Truncate the body mid-record, as a dropped connection would. Valid-looking JSON that stops — the .json() failure path.",
    schema: { type: "integer", enum: [0, 1] },
  },
  {
    name: "_cors",
    description: "Set to `off` to omit the CORS headers, so a browser refuses the response cross-origin. From a server or curl it looks normal, because CORS is enforced by the browser.",
    schema: { type: "string", enum: ["off"] },
  },
];

const QUERY_PARAMS = [
  { name: "_limit", description: "Page size. Capped at your tier's maximum rather than rejected.", schema: { type: "integer", minimum: 1, example: 10 } },
  { name: "_page", description: "1-based page number.", schema: { type: "integer", minimum: 1 } },
  { name: "_start", description: "Offset, the json-server form. Wins over _page when both are given.", schema: { type: "integer", minimum: 0 } },
  { name: "_sort", description: "Field to sort by.", schema: { type: "string" } },
  { name: "_order", description: "asc (default) or desc.", schema: { type: "string", enum: ["asc", "desc"] } },
  { name: "_q", description: "Full-text search across the whole record.", schema: { type: "string" } },
  { name: "_select", description: "Comma-separated fields to return; id is always included. Also accepted as `select`, DummyJSON's spelling.", schema: { type: "string", example: "title,price" } },
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

  paths["/scenario"] = {
    post: {
      summary: "Create a failure sequence, in either direction",
      description:
        "_fail_rate is random and cannot be asserted on; _status never changes. A scenario is a counter, " +
        "which is what retry logic and circuit breakers actually need — fail twice and succeed on the third " +
        "so a test can prove the backoff worked, or fail N consecutive times to force a breaker open and " +
        "then let it close. Send `succeed` instead of `fail` to run it the other way round: work N times, " +
        "then fail from there on, which is how a rate limit, a quota, a free trial and an expiring token " +
        "all behave. Send one or the other, never both. Responses carry x-scenario-attempt.",
      tags: ["scenario"],
      requestBody: {
        content: { "application/json": { schema: { type: "object", properties: {
          fail: { type: "integer", minimum: 0, maximum: 50, default: 2,
            description: "Fail this many attempts, then succeed for good." },
          succeed: { type: "integer", minimum: 0, maximum: 50,
            description: "Succeed this many attempts, then fail for good. Mutually exclusive with fail." },
          status: { type: "integer", minimum: 400, maximum: 599,
            description: "The failure status. Defaults to 503 with fail, 429 with succeed." },
        } } } },
      },
      responses: { 201: { description: "The id, and how to use and reset it." }, 400: errorResponse("Bad policy.") },
    },
  };
  paths["/scenario/{id}"] = {
    get: { summary: "How far through the sequence you are", tags: ["scenario"],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Attempts so far and whether the next one fails." }, 404: errorResponse("No such scenario.") } },
  };
  paths["/scenario/{id}/reset"] = {
    post: { summary: "Rewind the counter without spending an attempt", tags: ["scenario"],
      description: "For a test's beforeEach. The inline ?_scenario_reset=1 rewinds too, but that request then becomes attempt 1.",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      responses: { 200: { description: "Rewound." }, 404: errorResponse("No such scenario.") } },
  };

  paths["/custom"] = {
    post: {
      summary: "Turn your own JSON into a mock API",
      description:
        "Send an array, or an object whose values are arrays; each array becomes an endpoint. " +
        "No account needed. Lives 24 hours, then is deleted — export it to keep it. Every query " +
        "and chaos parameter works on the result, which is the point: your shapes, failing how you ask.",
      tags: ["custom"],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { oneOf: [{ type: "array" }, { type: "object" }] } } },
      },
      responses: {
        201: { description: "The id, the endpoints it created, and an export link." },
        400: errorResponse("Not valid JSON, or no arrays in it to serve."),
        413: errorResponse("Larger than 256 KB."),
        429: errorResponse("Too many custom APIs from this address today."),
      },
    },
  };

  paths["/custom/{id}/{resource}"] = {
    get: {
      summary: "Read one of your own resources",
      description: "Filtering, sorting, paging, _select and every chaos parameter apply here exactly as they do to the built-in resources.",
      tags: ["custom"],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{16}$" } },
        { name: "resource", in: "path", required: true, schema: { type: "string" } },
        ...[...QUERY_PARAMS, ...CHAOS_PARAMS].map(param),
      ],
      responses: {
        200: { description: "Your records." },
        404: errorResponse("No such API, or no such resource in it."),
        410: errorResponse("It expired. They last 24 hours."),
      },
    },
  };

  paths["/custom/{id}/export"] = {
    get: {
      summary: "Download it as files that run locally",
      description:
        "node and python return a complete single-file server with your data embedded — no install, no " +
        "network, and the chaos parameters work locally exactly as they do here, which json-server " +
        "cannot do. json-server returns a db.json; msw returns handlers for a test suite. All four " +
        "work offline, in CI, and after this service is gone.",
      tags: ["custom"],
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "format", in: "query", schema: { type: "string", enum: ["node", "python", "json-server", "msw"], default: "json-server" } },
      ],
      responses: { 200: { description: "A file, as an attachment." }, 400: errorResponse("Unknown format.") },
    },
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
        { name: "custom", description: "Your own JSON, served as an API for 24 hours" },
        { name: "scenario", description: "Failure sequences that recover, for retry and circuit-breaker tests" },
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
