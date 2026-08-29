// RFC 4180 CSV, with the two things that bite people who roll their own.

// 1. Formula injection. A cell starting with = + - @ or a control character is
//    executed as a formula when the file is opened in Excel or Sheets, which
//    turns "export your data" into "run a stranger's code on your laptop".
//    Key ids and emails are the fields here that a stranger controls. Prefixing
//    with an apostrophe neutralises it and the cell still reads correctly.
const DANGEROUS = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (DANGEROUS.test(text)) text = "'" + text;
  // Quote if the value contains a delimiter, a quote, or a newline. Internal
  // quotes are doubled.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// `columns` is [[header, key], ...] so the file's column order and its headings
// are declared in one place rather than having to be kept in step.
export function toCsv(rows, columns) {
  const header = columns.map(([name]) => cell(name)).join(",");
  const body = rows.map((row) => columns.map(([, key]) => cell(row[key])).join(","));
  // CRLF, which is what RFC 4180 specifies and what Excel is happiest with.
  return [header, ...body].join("\r\n") + "\r\n";
}

// 2. Excel on Windows assumes the system codepage unless the file opens with a
//    UTF-8 byte order mark, so country names with accents arrive as mojibake.
//    Sheets and every sane parser skip it.
export function csvResponse(csv, filename) {
  // A BOM as an escape, never a literal — a raw BOM in source is invisible and
  // does not survive every editor and encoding round trip.
  return new Response("\uFEFF" + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "content-disposition",
    },
  });
}
