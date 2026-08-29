import { CORS_HEADERS } from "../config/constants.js";

// Every response leaves through here, so CORS and content-type are applied in
// exactly one place.

export function json(data, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "content-length": String(new TextEncoder().encode(body).length),
      ...headers,
    },
  });
}

// Errors carry a hint, not just a message. A caller who gets this back should
// know what to do next without opening the docs.
export const fail = (status, message, hint = "") =>
  json({ error: { status, message, hint } }, { status });

export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

// Add headers to an already-built response without rebuilding the body.
export function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(headers)) merged.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
