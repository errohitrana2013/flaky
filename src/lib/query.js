import { RESERVED_PARAMS, DEFAULT_PAGE_SIZE } from "../config/constants.js";

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
  const page = Math.max(Number(params.get("_page")) || 1, 1);
  const start = (page - 1) * limit;

  return { rows: result.slice(start, start + limit), total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

export const pageHeaders = (page) => ({
  "x-total-count": String(page.total),
  "x-page": String(page.page),
  "x-total-pages": String(page.pages),
});
