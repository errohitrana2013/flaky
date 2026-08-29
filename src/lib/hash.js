// Visitor identity without storing anything identifying.
//
// A visitor is SHA-256(salt + ip + user-agent), truncated to 8 bytes. That is
// enough to count uniques and far too little to reverse into an IP. Rotating
// VISITOR_SALT invalidates every existing hash, which is the reset switch if a
// deletion request ever arrives.

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function visitorId(request, salt) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const agent = request.headers.get("user-agent") || "";
  const full = await sha256Hex(`${salt}:${ip}:${agent}`);
  return full.slice(0, 16); // 8 bytes
}

export const today = () => new Date().toISOString().slice(0, 10);

// UTC, deliberately. Storing a local hour would bake in whichever timezone the
// edge happened to pick; the dashboard converts to the viewer's own.
export const utcHour = () => new Date().getUTCHours();

export const daysAgo = (n) =>
  new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
