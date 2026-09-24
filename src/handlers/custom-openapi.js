import { fail } from "../lib/response.js";
import { specToMock } from "../lib/openapi-mock.js";
import { MAX_CUSTOM_BYTES, MAX_SPEC_BYTES } from "../config/tiers.js";
import { CUSTOM_SPEC_EXAMPLE } from "../config/example.js";
import { publish } from "./custom.js";

// Paste an OpenAPI spec, get a mock of your own API, for one to nine days.
//
// The paste-JSON page needs data someone already has. Most teams have a spec
// first — Spring, ASP.NET and FastAPI all serve one from the running app — so
// this writes the records from it and hands them to the same machinery: every
// chaos control, the four runners and the lifetime all come from publish(), and
// nothing downstream knows the data was generated.

// The example's records, as they will be stored. The generator is deterministic,
// so the example spec always produces exactly this, and a match means the button
// was clicked rather than anybody's API described.
const EXAMPLE_BODY = JSON.stringify(specToMock(JSON.parse(CUSTOM_SPEC_EXAMPLE), { maxBytes: MAX_CUSTOM_BYTES }).data);

// POST /v1/custom/openapi
export async function createFromSpec(ctx) {
  const tooLarge = () => fail(413, "That spec is too large", `The limit is ${MAX_SPEC_BYTES / 1024} KB.`);
  if ((Number(ctx.request.headers.get("content-length")) || 0) > MAX_SPEC_BYTES) return tooLarge();

  const raw = await ctx.request.text();
  if (raw.length > MAX_SPEC_BYTES) return tooLarge();

  // Said outright rather than reported as a JSON syntax error at position 0,
  // which would send someone hunting for a typo in a file that has none.
  if (!raw.trimStart().startsWith("{") && /^\s*(openapi|swagger)\s*:/m.test(raw)) {
    return fail(
      400,
      "YAML specs are not supported yet — send JSON",
      "Your app most likely serves it as JSON already: FastAPI at /openapi.json, springdoc at /v3/api-docs, " +
        "Swashbuckle at /swagger/v1/swagger.json. Or convert: npx js-yaml openapi.yaml > openapi.json"
    );
  }

  let spec;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    return fail(400, "That is not valid JSON", String(err.message).slice(0, 120));
  }

  const mock = specToMock(spec, { maxBytes: MAX_CUSTOM_BYTES });
  if (mock.error) return fail(400, mock.error.message, mock.error.hint);

  if (!Object.keys(mock.data).length) {
    // The reasons are the useful part: "nothing to mock" alone gives nobody a
    // way forward, and the first few say what shape the spec would need.
    const why = mock.skipped.slice(0, 3).map((s) => `${s.path}: ${s.reason}`).join(" ");
    return fail(400, "Nothing in this spec could be mocked", why || "It has no GET routes that return JSON.");
  }

  const body = JSON.stringify(mock.data);
  return publish(
    ctx,
    mock.data,
    {
      from: mock.info,
      // What the app's base URL should stop being, so pointing it at the mock is
      // one change rather than a guess.
      replaces: mock.replaces,
      skipped: mock.skipped,
      warnings: mock.warnings,
    },
    { sample: body === EXAMPLE_BODY }
  );
}
