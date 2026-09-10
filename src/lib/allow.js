import { METHODS } from "../config/methods.js";
import { fail, withHeaders, echo } from "./response.js";

// A write aimed at the wrong shape of path — PUT on a collection, POST on one
// record — used to answer 404 "No posts with id (empty)", or 200 for a DELETE
// that removed nothing. Both send someone looking for the wrong mistake. This
// answers 405 with the Allow header and the URL that would have worked.
//
// `at` is where the resource lives, /v1 or /v1/sandbox/<id>, so the suggestion
// works for whoever is asking. Returns null when the method is fine.
export function wrongMethod(method, { at, resource, id, child }) {
  const shape = child ? "nested" : id ? "record" : "collection";
  const allowed = METHODS[shape];
  if (allowed.includes(method)) return null;

  const changesOne = ["PUT", "PATCH", "DELETE"].includes(method);
  const instead =
    shape === "collection" && changesOne ? `${method} changes one record, so it needs an id: ${method} ${at}/${resource}/1. ` :
    shape === "record" && method === "POST" ? `POST creates a record, so it goes to the collection: POST ${at}/${resource}. ` :
    shape === "nested" && changesOne ? `To change one of these, ${method} ${at}/${child}/1. ` :
    "";

  return withHeaders(
    fail(405, `${echo(method)} is not allowed here`, `${instead}This path accepts ${allowed.join(", ")}.`),
    { allow: allowed.join(", ") }
  );
}
