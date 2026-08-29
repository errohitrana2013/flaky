import { TIERS, IP_DAILY_CEILING } from "../config/tiers.js";
import { today } from "../lib/hash.js";

// A fixed daily window in KV, keyed by API key or IP. Deliberately not a
// sliding window: KV is eventually consistent, so a precise limiter would be a
// lie. This is a spend guard, not a fairness mechanism.
//
// KV writes are capped at one per second per key, so a caller hammering us
// undercounts. That is acceptable for the free tiers and is why the paid tier
// should move to a Durable Object before it matters.

// This function must never throw. It is on the path of every request, and a
// limiter that takes down the API it protects is worse than no limiter at all.
//
// It fails OPEN, and the reason is arithmetic rather than taste: KV's free tier
// allows 1,000 writes a day and this does one write per request, so exhausting
// the quota is what *success* looks like. Failing closed would mean the first
// popular day is the day the service dies.

// Read and write are handled separately on purpose. If the read works we can
// still enforce the limit even when writes are gone, so a caller already over
// quota stays blocked instead of being let through by the outage.
async function bump(env, bucket, limit) {
  let current = 0;
  try {
    current = Number(await env.RATE_LIMITS.get(bucket)) || 0;
  } catch {
    return { ok: true, limit, remaining: limit, degraded: true };
  }

  if (current >= limit) return { ok: false, limit, remaining: 0 };

  // A failed write costs accuracy, not availability: the counter stops rising,
  // so the limiter undercounts rather than the API going down.
  let degraded = false;
  try {
    // 48h TTL so a window is never evicted while still in use.
    await env.RATE_LIMITS.put(bucket, String(current + 1), { expirationTtl: 172800 });
  } catch {
    degraded = true;
  }

  return { ok: true, limit, remaining: limit - current - 1, degraded };
}

export async function checkRateLimit(env, { key, ip }, tier) {
  const day = today();
  const limit = TIERS[tier].requestsPerDay;

  const primary = await bump(env, `rl:${day}:${key || ip}`, limit);
  if (!primary.ok) return primary;

  // Anonymous callers are already counted by IP above, so their primary counter
  // *is* the IP counter and one check is enough.
  if (!key) return primary;

  // Keyed callers get their own budget, which is the point of a key. But keys
  // are free and unverified, so without a second ceiling one address could mint
  // several and multiply its allowance — the anonymous limit would be bypassable
  // by scripting signups. This bounds the total from one address regardless of
  // how many keys are held. It costs a second KV write, but only on keyed
  // traffic, which is the small fraction.
  const perIp = await bump(env, `ip:${day}:${ip}`, IP_DAILY_CEILING);
  if (!perIp.ok) return { ok: false, limit: IP_DAILY_CEILING, remaining: 0, scope: "ip" };

  return { ...primary, degraded: primary.degraded || perIp.degraded };
}

export const rateHeaders = (rate, tier) => ({
  "x-tier": tier,
  "x-ratelimit-limit": String(rate.limit),
  "x-ratelimit-remaining": String(Math.max(rate.remaining, 0)),
  // Surfaced so a degraded limiter is visible in `curl -I` and in the logs,
  // rather than being an invisible loss of protection.
  ...(rate.degraded ? { "x-ratelimit-degraded": "1" } : {}),
});
