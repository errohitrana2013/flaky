import { TIERS } from "../config/tiers.js";
import { today } from "../lib/hash.js";

// A fixed daily window in KV, keyed by API key or IP. Deliberately not a
// sliding window: KV is eventually consistent, so a precise limiter would be a
// lie. This is a spend guard, not a fairness mechanism.
//
// KV writes are capped at one per second per key, so a caller hammering us
// undercounts. That is acceptable for the free tiers and is why the paid tier
// should move to a Durable Object before it matters.

export async function checkRateLimit(env, identity, tier) {
  const limit = TIERS[tier].requestsPerDay;
  const key = `rl:${today()}:${identity}`;

  const current = Number(await env.RATE_LIMITS.get(key)) || 0;
  if (current >= limit) return { ok: false, limit, remaining: 0 };

  // 48h TTL so a window is never evicted while still in use.
  await env.RATE_LIMITS.put(key, String(current + 1), { expirationTtl: 172800 });

  return { ok: true, limit, remaining: limit - current - 1 };
}

export const rateHeaders = (rate, tier) => ({
  "x-tier": tier,
  "x-ratelimit-limit": String(rate.limit),
  "x-ratelimit-remaining": String(rate.remaining),
});
