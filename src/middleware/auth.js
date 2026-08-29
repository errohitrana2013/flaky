import { TIERS } from "../config/tiers.js";

const ANONYMOUS = { tier: "anonymous", key: null, keyId: null, invalid: false };

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : request.headers.get("x-api-key");
}

// No key is a valid state — it means the anonymous tier. A key that is present
// but unknown or revoked is an error, because the caller clearly expected it to
// work and silently downgrading them would hide the problem.
export async function resolveTier(request, env) {
  const key = bearer(request);
  if (!key) return ANONYMOUS;

  const row = await env.DB.prepare(
    "SELECT id, tier, revoked FROM api_keys WHERE key = ?"
  ).bind(key).first();

  if (!row || row.revoked) return { ...ANONYMOUS, invalid: true };

  const tier = TIERS[row.tier] ? row.tier : "free";
  return { tier, key, keyId: row.id, invalid: false };
}
