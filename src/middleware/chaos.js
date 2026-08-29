import { fail, echo } from "../lib/response.js";
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
    return fail(
      status.value,
      "Injected status",
      `This response was forced by _status=${status.value}. Remove the parameter for a normal response.`
    );
  }

  return null;
}
