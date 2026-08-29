import { fail } from "../lib/response.js";
import { MAX_INJECTED_DELAY_MS } from "../config/tiers.js";

// The reason this API exists. Callers ask for the failure they want to test
// against, so a broken backend is one query parameter away instead of a
// local mock server.
//
// Returns a Response to short-circuit with, or null to continue normally.

export async function applyChaos(params) {
  const delay = Number(params.get("_delay"));
  if (delay > 0) {
    await new Promise((r) => setTimeout(r, Math.min(delay, MAX_INJECTED_DELAY_MS)));
  }

  const rate = Number(params.get("_fail_rate"));
  if (rate > 0 && Math.random() < rate) {
    return fail(
      500,
      "Injected failure",
      `This request lost the dice roll for _fail_rate=${rate}. Retry, or drop the parameter.`
    );
  }

  const status = Number(params.get("_status"));
  if (status >= 100 && status <= 599 && status !== 200) {
    return fail(
      status,
      "Injected status",
      `This response was forced by _status=${status}. Remove the parameter for a normal response.`
    );
  }

  return null;
}
