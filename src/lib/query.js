import { RESERVED_PARAMS, DEFAULT_PAGE_SIZE } from "../config/constants.js";
import { fail, echo } from "./response.js";

// Paging parameters are validated as strictly as the chaos ones. They were not,
// and the inconsistency was the bug: `_page=abc` silently became page 1, so a
// caller with a typo in their pagination loop reads page 1 forever and never
// finds out.
//
// Note what is *not* an error: a `_limit` above the tier maximum is capped, not
// rejected, because capping is the documented contract ("capped at your tier's
// maxLimit") rather than a silent fallback.
export function validatePaging(params, maxLimit) {
  // An unknown underscore param is a mistake, not a field name.
  for (const [name] of params) {
    if (name.startsWith("_") && !RESERVED_PARAMS.has(name)) {
      return fail(
        400,
        `Unknown parameter ${echo(name)}`,
        `Parameters starting with _ are reserved. Known: ${[...RESERVED_PARAMS].join(", ")}.`
      );
    }
  }

  for (const [name, floor] of [["_limit", 1], ["_page", 1], ["_start", 0]]) {
    const raw = params.get(name);
    if (raw === null || raw.trim() === "") continue;

    const value = Number(raw);
    if (!Number.isInteger(value) || value < floor) {
      return fail(
        400,
        `Invalid ${name}`,
        name === "_limit"
          ? `${name}=${echo(raw)} is not valid. Expected a whole number of 1 or more; anything above your tier's ${maxLimit} is capped.`
          : `${name}=${echo(raw)} is not valid. Expected a whole number of ${floor} or more.`
      );
    }
  }
  return null;
}

// Filter, search, sort and paginate an in-memory collection.
export function queryCollection(rows, params, maxLimit) {
  let result = rows;

  for (const [field, value] of params) {
    if (RESERVED_PARAMS.has(field)) continue;
    result = result.filter((row) => String(row[field]) === value);
  }

  const search = params.get("_q");
  if (search) {
    const needle = search.toLowerCase();
    result = result.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
  }

  const sortField = params.get("_sort");
  if (sortField) {
    const dir = params.get("_order") === "desc" ? -1 : 1;
    result = [...result].sort((a, b) =>
      a[sortField] > b[sortField] ? dir : a[sortField] < b[sortField] ? -dir : 0);
  }

  const total = result.length;
  const limit = Math.min(Number(params.get("_limit")) || DEFAULT_PAGE_SIZE, maxLimit);

  // Two paging styles, because JSONPlaceholder speaks json-server's offset form
  // and people migrating arrive with _start already in their code. When both
  // appear, the explicit offset wins.
  const page = Math.max(Number(params.get("_page")) || 1, 1);
  const start = params.has("_start")
    ? Math.max(Number(params.get("_start")) || 0, 0)
    : (page - 1) * limit;

  return { rows: result.slice(start, start + limit), total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

export const pageHeaders = (page) => ({
  "x-total-count": String(page.total),
  "x-page": String(page.page),
  "x-total-pages": String(page.pages),
});
