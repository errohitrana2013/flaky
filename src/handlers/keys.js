import { json, fail } from "../lib/response.js";
import { TIERS, KEYS_PER_IP_PER_DAY } from "../config/tiers.js";
import { today } from "../lib/hash.js";

// Deliberately no email verification. A key here buys a higher rate limit and
// a sandbox, not access to anything private, so a confirmation loop would cost
// signups and protect nothing. Email exists so there is a way to contact heavy
// users and a handle to revoke by.

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

// Idempotent re-issues do not count, so someone who keeps asking for the key
// they already have is never locked out — only minting *new* ones is capped.
//
// Fails open like the rate limiter: if KV is unavailable this returns false and
// the key is issued. Losing an abuse ceiling for the duration of an outage is a
// better trade than refusing every signup during one.
async function tooManyKeys(env, request) {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip || !env.RATE_LIMITS) return { over: false, bump: async () => {} };

  const bucket = `keys:${today()}:${ip}`;
  try {
    const issued = Number(await env.RATE_LIMITS.get(bucket)) || 0;
    if (issued >= KEYS_PER_IP_PER_DAY) return { over: true, bump: async () => {} };

    return {
      over: false,
      // Only called once the key is actually created.
      bump: async () => {
        try {
          await env.RATE_LIMITS.put(bucket, String(issued + 1), { expirationTtl: 172800 });
        } catch { /* accuracy, not availability */ }
      },
    };
  } catch {
    return { over: false, bump: async () => {} };
  }
}

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

  // Checked after the idempotent path above, so a repeat caller is never
  // blocked from retrieving the key they already hold.
  const quota = await tooManyKeys(ctx.env, ctx.request);
  if (quota.over) {
    return fail(
      429,
      "Too many keys from this address today",
      `Up to ${KEYS_PER_IP_PER_DAY} new keys per day. Asking again for a key you already have is always allowed.`
    );
  }

  const raw = crypto.getRandomValues(new Uint8Array(16));
  const key = "flk_" + [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
  const id = crypto.randomUUID();

  await ctx.env.DB.prepare(
    "INSERT INTO api_keys (id, key, email, tier, created_at, revoked) VALUES (?, ?, ?, 'free', ?, 0)"
  ).bind(id, key, email, Date.now()).run();

  await quota.bump();

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
