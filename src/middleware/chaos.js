import { fail, echo, withHeaders } from "../lib/response.js";
import { MAX_INJECTED_DELAY_MS } from "../config/tiers.js";

// The reason this API exists. Callers ask for the failure they want to test
// against, so a broken backend is one query parameter away instead of a local
// mock server.
//
// Returns a Response to short-circuit with, or null to continue normally.
//
// Every parameter is validated and a bad one is a 400. That matters more here
// than in a normal API: silently ignoring _status=999 would hand back a 200 to
// someone testing their retry path, and their test would pass for the wrong
// reason. A tool for testing failures must never fail quietly itself.

// An absent parameter and an empty one both mean "not asked for". Anything
// else has to parse cleanly.
function read(params, name) {
  if (!params.has(name)) return null;
  const raw = params.get(name).trim();
  return raw === "" ? null : { raw, value: Number(raw) };
}

const reject = (name, raw, expected) =>
  fail(400, `Invalid ${name}`, `${name}=${echo(raw)} is out of range. ${expected}`);

export async function applyChaos(params) {
  const delay = read(params, "_delay");
  const rate = read(params, "_fail_rate");
  const status = read(params, "_status");

  // Validate everything before acting on anything, so a request with a bad
  // _status does not first sit through a valid _delay.
  if (delay && !(Number.isFinite(delay.value) && delay.value >= 0 && delay.value <= MAX_INJECTED_DELAY_MS)) {
    return reject("_delay", delay.raw, `Expected milliseconds from 0 to ${MAX_INJECTED_DELAY_MS}.`);
  }

  if (rate && !(Number.isFinite(rate.value) && rate.value >= 0 && rate.value <= 1)) {
    return reject("_fail_rate", rate.raw, "Expected a probability from 0 to 1, e.g. 0.3 for a third of requests.");
  }

  if (status && !(Number.isInteger(status.value) && status.value >= 100 && status.value <= 599)) {
    return reject("_status", status.raw, "Expected an HTTP status code from 100 to 599.");
  }

  const malformed = read(params, "_malformed");
  if (malformed && !["1", "0", "true", "false"].includes(malformed.raw)) {
    return reject("_malformed", malformed.raw, "Expected 1 or 0.");
  }

  const retry = read(params, "_retry_after");
  if (retry && !(Number.isInteger(retry.value) && retry.value >= 0 && retry.value <= 3600)) {
    return reject("_retry_after", retry.raw, "Expected seconds from 0 to 3600. Only meaningful with _status=429 or 503.");
  }

  const cors = read(params, "_cors");
  if (cors && cors.raw !== "off") {
    return reject("_cors", cors.raw, "The only accepted value is off, which omits the CORS headers.");
  }

  if (delay && delay.value > 0) {
    await new Promise((r) => setTimeout(r, delay.value));
  }

  if (rate && rate.value > 0 && Math.random() < rate.value) {
    return fail(
      500,
      "Injected failure",
      `This request lost the dice roll for _fail_rate=${echo(rate.raw)}. Retry, or drop the parameter.`
    );
  }

  // _status=200 is valid and means "behave normally", so it falls through.
  if (status && status.value !== 200) {
    const response = fail(
      status.value,
      "Injected status",
      `This response was forced by _status=${status.value}. Remove the parameter for a normal response.`
    );

    // 429 and 503 mean "come back later", and a client that backs off correctly
    // reads Retry-After to know how long. Without it there is nothing to test
    // against — which is the state of every tool that returns these codes today.
    if (status.value === 429 || status.value === 503) {
      const after = params.has("_retry_after") ? Number(params.get("_retry_after")) : 5;
      return withHeaders(response, { "retry-after": String(Math.min(Math.max(after, 0), 3600)) });
    }
    return response;
  }

  return null;
}

// Truncates a real response mid-record. Not random bytes: the failure people
// actually hit is a connection dropped part-way through a body, which arrives as
// valid-looking JSON that stops. It is the .json() catch path nobody tests.
export async function truncate(response) {
  const body = await response.text();
  const cut = body.slice(0, Math.max(1, Math.floor(body.length * 0.6)));
  return new Response(cut, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers),
      "content-length": String(new TextEncoder().encode(cut).length),
      "x-truncated": "deliberately, by _malformed=1",
    },
  });
}
