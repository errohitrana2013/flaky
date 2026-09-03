import { json, fail, echo } from "../lib/response.js";
import { SCENARIO_TTL_MS, MAX_SCENARIO_THRESHOLD } from "../config/tiers.js";

// A failure that stops, or one that starts.
//
// Everything else here is stateless: _status always fails, _fail_rate fails at
// random. Neither can express "fail twice, then work", which is what retry logic
// and circuit breakers actually have to be tested against — a coin toss cannot
// be asserted on, and a permanent 503 never lets a breaker close again.
//
// So a scenario is a counter, and it runs in either direction:
//
//   {"fail": 2}     fail, fail, then succeed for good   — retries, breakers
//   {"succeed": 3}  work, work, work, then fail for good — rate limits, quotas,
//                                                          trials, token expiry
//
// Pass ?_scenario=<id> on any request. Reset it between tests and the sequence
// repeats exactly.

const ID = /^[0-9a-f]{16}$/;

// Reads either shape into one number. `fail_count` is the threshold in both
// directions — see 0016_scenario_invert.sql for why the column kept its name.
function policyFrom(body) {
  const hasFail = body.fail !== undefined && body.fail !== null;
  const hasSucceed = body.succeed !== undefined && body.succeed !== null;

  if (hasFail && hasSucceed) {
    return { error: ["Pick one direction", "Send fail (fail N, then recover) or succeed (work N, then fail) — not both."] };
  }

  const invert = hasSucceed ? 1 : 0;
  const word = invert ? "succeed" : "fail";
  const threshold = Math.trunc(Number(invert ? body.succeed : body.fail ?? 2));

  if (!Number.isFinite(threshold) || threshold < 0 || threshold > MAX_SCENARIO_THRESHOLD) {
    return {
      error: [
        `Invalid ${word} count`,
        `Expected a whole number from 0 to ${MAX_SCENARIO_THRESHOLD}. ` +
          (invert
            ? "0 means it fails from the very first request."
            : "0 means it never fails, which is occasionally useful as a control."),
      ],
    };
  }

  return { threshold, invert };
}

// POST /v1/scenario  { fail: 2, status: 503 }  or  { succeed: 3, status: 429 }
export async function createScenario(ctx) {
  const body = await ctx.request.json().catch(() => ({}));

  const policy = policyFrom(body);
  if (policy.error) return fail(400, policy.error[0], policy.error[1]);
  const { threshold, invert } = policy;

  // A rate limit is the obvious reason to invert one, so default to its status
  // rather than making everybody spell out 429.
  const status = Math.trunc(Number(body.status ?? (invert ? 429 : 503)));
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return fail(400, "Invalid status", "Expected a failure status from 400 to 599.");
  }

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const expiresAt = Date.now() + SCENARIO_TTL_MS;

  await ctx.env.DB.prepare(
    "INSERT INTO scenarios (id, fail_count, status, invert, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)"
  ).bind(id, threshold, status, invert, Date.now(), expiresAt).run();

  return json(
    {
      id,
      policy: invert
        ? { succeed: threshold, thenFailsWith: status, recovers: false }
        : { fail: threshold, status, thenSucceeds: true },
      usage: invert
        ? `Add ?_scenario=${id} to any request. The first ${threshold} succeed; every one after returns ${status}.`
        : `Add ?_scenario=${id} to any request. The first ${threshold} return ${status}; the rest succeed.`,
      reset: `POST /v1/scenario/${id}/reset — rewind between tests without spending an attempt.`,
      resetInline: `?_scenario=${id}&_scenario_reset=1 — rewinds first, so that request becomes attempt 1.`,
      inspect: `/v1/scenario/${id}`,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    { status: 201 }
  );
}

// True when this attempt should fail. The whole feature is this one comparison.
const failsOn = (attempts, threshold, invert) =>
  invert ? attempts > threshold : attempts <= threshold;

// What is left before the behaviour flips, named for the direction it flips in.
function remaining(row) {
  const left = Math.max(0, row.fail_count - row.attempts);
  return row.invert ? { successes: left } : { failures: left };
}

// GET /v1/scenario/:id — how far through the sequence you are, without advancing it.
export async function readScenario(ctx) {
  const { id } = ctx.params;
  if (!ID.test(id)) return fail(404, "No such scenario", "Ids are 16 hex characters.");

  const row = await ctx.env.DB.prepare(
    "SELECT fail_count, status, invert, attempts, expires_at FROM scenarios WHERE id = ?"
  ).bind(id).first();

  if (!row) return fail(404, "No such scenario", "Create one at POST /v1/scenario.");
  if (row.expires_at < Date.now()) return fail(410, "That scenario expired", "They last 24 hours.");

  const left = remaining(row);
  return json({
    id,
    policy: row.invert
      ? { succeed: row.fail_count, thenFailsWith: row.status }
      : { fail: row.fail_count, status: row.status },
    attempts: row.attempts,
    ...(row.invert ? { remainingSuccesses: left.successes } : { remainingFailures: left.failures }),
    // Deliberately the same key in both directions: a test asserting on the
    // sequence should not have to know which way round the scenario runs.
    nextWillFail: failsOn(row.attempts + 1, row.fail_count, row.invert),
  });
}

// POST /v1/scenario/:id/reset
//
// Separate from the query parameter because a test's beforeEach wants to rewind
// the counter without spending an attempt. Doing it inline means the resetting
// request is itself attempt 1, which is a confusing thing to discover halfway
// through debugging a retry test.
export async function resetScenario(ctx) {
  const { id } = ctx.params;
  if (!ID.test(id)) return fail(404, "No such scenario", "Ids are 16 hex characters.");

  const row = await ctx.env.DB.prepare(
    "UPDATE scenarios SET attempts = 0 WHERE id = ? AND expires_at > ? RETURNING fail_count, status, invert"
  ).bind(id, Date.now()).first();

  if (!row) return fail(404, "No such scenario", "It may have expired. Create another at POST /v1/scenario.");

  return json({
    id,
    attempts: 0,
    policy: row.invert
      ? { succeed: row.fail_count, thenFailsWith: row.status }
      : { fail: row.fail_count, status: row.status },
    note: "Rewound. The next request carrying this scenario is attempt 1.",
  });
}

// Applied to any request carrying ?_scenario=. Returns a Response to fail with,
// or null to let the request proceed normally.
//
// The counter advances on every request, including the ones that succeed, so
// "attempt 4" means the same thing to the caller as it does here.
export async function applyScenario(ctx) {
  const id = ctx.query.get("_scenario");
  if (!id) return null;

  if (!ID.test(id)) {
    return fail(400, `Invalid _scenario '${echo(id)}'`, "Create one at POST /v1/scenario and use the id it returns.");
  }

  if (ctx.query.get("_scenario_reset") === "1") {
    await ctx.env.DB.prepare("UPDATE scenarios SET attempts = 0 WHERE id = ?").bind(id).run();
  }

  // One statement, so two requests in flight cannot read the same attempt
  // number. Doing this as a read then a write would let a parallel test see
  // "attempt 1" twice and fail for reasons that have nothing to do with its code.
  const row = await ctx.env.DB.prepare(
    `UPDATE scenarios SET attempts = attempts + 1
     WHERE id = ? AND expires_at > ?
     RETURNING attempts, fail_count, status, invert`
  ).bind(id, Date.now()).first();

  if (!row) {
    return fail(404, "No such scenario", "It may have expired. Create another at POST /v1/scenario.");
  }

  const left = remaining(row);
  const headers = {
    "x-scenario-attempt": String(row.attempts),
    ...(row.invert
      ? { "x-scenario-remaining-successes": String(left.successes) }
      : { "x-scenario-remaining-failures": String(left.failures) }),
  };

  if (failsOn(row.attempts, row.fail_count, row.invert)) {
    const response = fail(
      row.status,
      "Scenario failure",
      row.invert
        ? `Attempt ${row.attempts}. The first ${row.fail_count} succeeded; this scenario fails from here on.`
        : `Attempt ${row.attempts} of ${row.fail_count} scheduled failures. Attempt ${row.fail_count + 1} will succeed.`
    );
    const merged = new Headers(response.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    if (row.status === 429 || row.status === 503) merged.set("retry-after", "1");
    return new Response(response.body, { status: response.status, headers: merged });
  }

  // Not failing yet: let the real handler run, but say which attempt this was.
  ctx.scenarioHeaders = headers;
  return null;
}
