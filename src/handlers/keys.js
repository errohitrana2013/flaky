import { json, fail } from "../lib/response.js";
import { TIERS } from "../config/tiers.js";

// Deliberately no email verification. A key here buys a higher rate limit and
// a sandbox, not access to anything private, so a confirmation loop would cost
// signups and protect nothing. Email exists so there is a way to contact heavy
// users and a handle to revoke by.

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

// POST /v1/keys  { email }
export async function createKey(ctx) {
  const body = await ctx.request.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();

  if (!EMAIL.test(email)) {
    return fail(400, "A valid email is required", 'Send {"email":"you@example.com"} as JSON.');
  }

  // Idempotent: asking twice returns the same key rather than piling up rows.
  const existing = await ctx.env.DB.prepare(
    "SELECT key FROM api_keys WHERE email = ? AND revoked = 0"
  ).bind(email).first();

  if (existing) {
    return json({
      key: existing.key,
      tier: "free",
      note: "This email already had a key, so here it is again.",
    });
  }

  const raw = crypto.getRandomValues(new Uint8Array(16));
  const key = "flk_" + [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  const id = crypto.randomUUID();

  await ctx.env.DB.prepare(
    "INSERT INTO api_keys (id, key, email, tier, created_at, revoked) VALUES (?, ?, ?, 'free', ?, 0)"
  ).bind(id, key, email, Date.now()).run();

  return json(
    {
      key,
      tier: "free",
      limits: TIERS.free,
      usage: "Send it as: Authorization: Bearer " + key,
      warning: "This is shown once. Store it now.",
    },
    { status: 201 }
  );
}
