import { json, fail, echo } from "../lib/response.js";
import { SCENARIO_TTL_MS, MAX_SCENARIO_FAILURES } from "../config/tiers.js";

// A failure that stops.
//
// Everything else here is stateless: _status always fails, _fail_rate fails at
// random. Neither can express "fail twice, then work", which is what retry logic
// and circuit breakers actually have to be tested against — a coin toss cannot
// be asserted on, and a permanent 503 never lets a breaker close again.
//
// So a scenario is a counter. Create one, then pass ?_scenario=<id> on any
// request: the first N attempts return your chosen status, and everything after
// succeeds. Reset it between tests and the sequence repeats exactly.

const ID = /^[0-9a-f]{16}$/;

// POST /v1/scenario  { fail: 2, status: 503 }
export async function createScenario(ctx) {
  const body = await ctx.request.json().catch(() => ({}));

  const failCount = Math.trunc(Number(body.fail ?? 2));
  if (!Number.isFinite(failCount) || failCount < 0 || failCount > MAX_SCENARIO_FAILURES) {
    return fail(
      400,
      "Invalid fail count",
      `Expected a whole number from 0 to ${MAX_SCENARIO_FAILURES}. 0 means it never fails, which is occasionally useful as a control.`
    );
  }

  const status = Math.trunc(Number(body.status ?? 503));
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    return fail(400, "Invalid status", "Expected a failure status from 400 to 599.");
  }

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const expiresAt = Date.now() + SCENARIO_TTL_MS;

  await ctx.env.DB.prepare(
    "INSERT INTO scenarios (id, fail_count, status, attempts, created_at, expires_at) VALUES (?, ?, ?, 0, ?, ?)"
  ).bind(id, failCount, status, Date.now(), expiresAt).run();

  return json(
    {
      id,
      policy: { fail: failCount, status, thenSucceeds: true },
      usage: `Add ?_scenario=${id} to any request. The first ${failCount} return ${status}; the rest succeed.`,
        reset: `POST /v1/scenario/${id}/reset — rewind between tests without spending an attempt.`,
      resetInline: `?_scenario=${id}&_scenario_reset=1 — rewinds first, so that request becomes attempt 1.`,
      inspect: `/v1/scenario/${id}`,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    { status: 201 }
  );
}

// GET /v1/scenario/:id — how far through the sequence you are, without advancing it.
export async function readScenario(ctx) {
  const { id } = ctx.params;
  if (!ID.test(id)) return fail(404, "No such scenario", "Ids are 16 hex characters.");

  const row = await ctx.env.DB.prepare(
    "SELECT fail_count, status, attempts, expires_at FROM scenarios WHERE id = ?"
  ).bind(id).first();

  if (!row) return fail(404, "No such scenario", "Create one at POST /v1/scenario.");
  if (row.expires_at < Date.now()) return fail(410, "That scenario expired", "They last 24 hours.");

  return json({
    id,
    policy: { fail: row.fail_count, status: row.status },
    attempts: row.attempts,
    remainingFailures: Math.max(0, row.fail_count - row.attempts),
    nextWillFail: row.attempts < row.fail_count,
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
    "UPDATE scenarios SET attempts = 0 WHERE id = ? AND expires_at > ? RETURNING fail_count, status"
  ).bind(id, Date.now()).first();

  if (!row) return fail(404, "No such scenario", "It may have expired. Create another at POST /v1/scenario.");

  return json({
    id,
    attempts: 0,
    policy: { fail: row.fail_count, status: row.status },
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
     RETURNING attempts, fail_count, status`
  ).bind(id, Date.now()).first();

  if (!row) {
    return fail(404, "No such scenario", "It may have expired. Create another at POST /v1/scenario.");
  }

  const headers = {
    "x-scenario-attempt": String(row.attempts),
    "x-scenario-remaining-failures": String(Math.max(0, row.fail_count - row.attempts)),
  };

  if (row.attempts <= row.fail_count) {
    const response = fail(
      row.status,
      "Scenario failure",
      `Attempt ${row.attempts} of ${row.fail_count} scheduled failures. Attempt ${row.fail_count + 1} will succeed.`
    );
    const merged = new Headers(response.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    if (row.status === 429 || row.status === 503) merged.set("retry-after", "1");
    return new Response(response.body, { status: response.status, headers: merged });
  }

  // Past the failures: let the real handler run, but say which attempt this was.
  ctx.scenarioHeaders = headers;
  return null;
}
