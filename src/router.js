import { readResource, echoWrite } from "./handlers/resources.js";
import { createSandbox, handleSandbox } from "./handlers/sandbox.js";
import { createKey } from "./handlers/keys.js";
import { getMeta } from "./handlers/meta.js";
import { getStats, exportCsv, getInsights } from "./handlers/admin.js";
import { recordBeacon } from "./handlers/beacon.js";

// Routes are matched top to bottom, first match wins. Static segments beat
// dynamic ones, so specific paths are listed before the generic catch-alls.
// `auth: "admin"` skips the tier and rate-limit pipeline.
const ROUTES = [
  { method: "GET",  path: "/v1/admin/stats",                          handler: getStats,      auth: "admin" },
  { method: "GET",  path: "/v1/admin/export",                         handler: exportCsv,     auth: "admin" },
  { method: "GET",  path: "/v1/admin/insights",                       handler: getInsights,   auth: "admin" },
  { method: "POST", path: "/v1/beacon",                               handler: recordBeacon },
  { method: "POST", path: "/v1/keys",                                 handler: createKey },
  { method: "GET",  path: "/v1/meta",                                 handler: getMeta },
  { method: "POST", path: "/v1/sandbox",                              handler: createSandbox },
  { method: "*",    path: "/v1/sandbox/:sandboxId/:resource",         handler: handleSandbox },
  { method: "*",    path: "/v1/sandbox/:sandboxId/:resource/:id",     handler: handleSandbox },
  { method: "GET",  path: "/v1/:resource",                            handler: readResource },
  { method: "GET",  path: "/v1/:resource/:id",                        handler: readResource },
  { method: "GET",  path: "/v1/:resource/:id/:child",                 handler: readResource },
  { method: "*",    path: "/v1/:resource",                            handler: echoWrite },
  { method: "*",    path: "/v1/:resource/:id",                        handler: echoWrite },
];

function matchPath(pattern, segments) {
  const parts = pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;

  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}

export function matchRoute(method, pathname) {
  const segments = pathname.split("/").filter(Boolean);

  for (const route of ROUTES) {
    if (route.method !== "*" && route.method !== method) continue;
    const params = matchPath(route.path, segments);
    if (params) return { ...route, params };
  }
  return null;
}
