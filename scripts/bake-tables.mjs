// Writes the landing page's two resource tables into public/index.html.
//
// They used to be rendered in the browser from /v1/meta, so the HTML shipped
// "Loading…" and anything that does not run JavaScript — most AI crawlers, and
// some search ones — never saw the list of endpoints. A static asset cannot be
// rendered by the Worker (the asset server answers first), so the rows are
// written into the file instead, from the same getMeta() that answers /v1/meta.
//
//   node scripts/bake-tables.mjs           rewrite the tables
//   node scripts/bake-tables.mjs --check   fail if they are out of date (npm test)
//
// The --check run is what keeps the old guarantee: adding a resource, a nested
// route or a method fails the tests until this has been re-run.

import { readFileSync, writeFileSync } from "node:fs";
import { getMeta } from "../src/handlers/meta.js";

const FILE = "public/index.html";

// What each method does at each kind of URL. The methods themselves come from
// meta, so this can only describe ones the API accepts.
const DOES = {
  collection: { GET: "List them, with filters, search, sorting and paging", POST: "Create one" },
  record: { GET: "Get it", PUT: "Replace it with the body you send", PATCH: "Change only the fields you send", DELETE: "Delete it" },
  nested: { GET: "List its {child}", POST: "Create one of its {child}" },
};

const I1 = "\n        ";
const I2 = "\n          ";

// Shown once, not repeated on every resource row: the methods are the same for
// all of them, and a column saying so seven times read as if each one differed.
// Real URLs rather than :id placeholders, from a resource that has nested routes
// so all three kinds can be shown.
function methodRows(meta) {
  const example = meta.resources.find((r) => r.nested.length) || meta.resources[0];
  const nested = example.nested[0]?.replace(":id", "1");
  const child = nested?.split("/").pop();
  const urls = [["collection", example.url], ["record", `${example.url}/1`], ...(nested ? [["nested", nested]] : [])];

  return urls.flatMap(([shape, url]) => meta.methods[shape].map((method, i) => {
    const does = DOES[shape][method];
    if (!does) throw new Error(`no description for ${method} on a ${shape} URL — add it to DOES`);
    const first = i === 0 ? `<td class="mono" rowspan="${meta.methods[shape].length}"><a href="${url}">${url}</a></td>` : "";
    return `<tr>${first}<td><span class="verb">${method}</span></td><td>${does.replace("{child}", child)}</td></tr>`;
  }));
}

// en-US explicitly, so the output does not depend on the machine running this.
function resourceRows(meta) {
  return meta.resources.map((r) =>
    `<tr><td class="mono"><a href="/v1/${r.name}">/v1/${r.name}</a></td>` +
    `<td class="num">${r.count.toLocaleString("en-US")}</td>` +
    `<td class="mono muted">${r.nested.join("<br>") || "—"}</td></tr>`);
}

// Replaces the tbody of one table, found by its id. Located with indexOf from
// that table's own opening tag rather than a regex across the document — a
// non-greedy match from the first <table> has already nested wrappers here.
function replaceBody(html, id, rows) {
  const start = html.indexOf(`<table id="${id}">`);
  if (start < 0) throw new Error(`<table id="${id}"> not found in ${FILE}`);
  const open = html.indexOf("<tbody>", start);
  const close = html.indexOf("</tbody>", open);
  const end = html.indexOf("</table>", start);
  if (open < 0 || close < 0 || close > end) throw new Error(`no <tbody> inside <table id="${id}">`);
  return html.slice(0, open + 7) + I2 + rows.join(I2) + I1 + html.slice(close);
}

const meta = await getMeta({ auth: { tier: "anonymous" } }).json();
const before = readFileSync(FILE, "utf8");
const after = replaceBody(replaceBody(before, "methods", methodRows(meta)), "resources", resourceRows(meta));

if (process.argv.includes("--check")) {
  if (after !== before) {
    console.error(`✗ the tables in ${FILE} are out of date with /v1/meta — run: node scripts/bake-tables.mjs`);
    process.exit(1);
  }
  console.log(`resource tables match /v1/meta (${meta.resources.length} resources)`);
} else {
  writeFileSync(FILE, after);
  console.log(after === before ? "tables already up to date" : `wrote ${meta.resources.length} resources into ${FILE}`);
}
