// An OpenAPI document in, the { resource: [records] } shape of a custom API out.
//
// The point is the second half of "test your app against your own API": the
// paste-JSON page needs data someone already has, and most teams have a spec
// long before they have a fixture file. So this reads the spec's GET routes,
// works out which of them are lists, and writes believable records for each —
// then the existing custom-API machinery serves them, fails them on request,
// and exports them to the four runners without knowing where they came from.
//
// Pure: no I/O, no clock, no Math.random. The same spec always produces the
// same records, so a test written against the mock does not change under
// someone between one import and the next.
//
// Never fails quietly. Every route that could not be mocked is reported with the
// reason, and every place the mock differs from the spec is a warning — a mock
// that silently drops half an API is worse than an error, because the app's
// failures then look like the app's fault.

const PER_RESOURCE = 10;
const MAX_DEPTH = 6;

// Words that are paths on the custom API itself, so a resource with this name
// could never be reached.
const RESERVED_NAMES = new Set(["export"]);

// Where a list endpoint that returns an object usually keeps its rows.
const WRAPPER_KEYS = ["data", "items", "results", "content", "records", "rows", "list", "entries", "values"];

export function specToMock(spec, { perResource = PER_RESOURCE, maxBytes = Infinity } = {}) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return { error: { message: "That is not an OpenAPI document", hint: "Expected a JSON object with an openapi or swagger field at the top." } };
  }

  const v2 = spec.swagger === "2.0";
  const v3 = typeof spec.openapi === "string" && /^3\./.test(spec.openapi);
  if (!v2 && !v3) {
    return {
      error: {
        message: "That is not an OpenAPI document",
        hint: "Expected openapi: 3.x or swagger: 2.0 at the top level. Pasting data rather than a spec? That is what /createMockServer is for.",
      },
    };
  }
  if (!spec.paths || typeof spec.paths !== "object" || !Object.keys(spec.paths).length) {
    return { error: { message: "The spec has no paths", hint: "There are no routes in it to mock." } };
  }

  const refs = resolver(spec);
  const skipped = [];
  const warnings = [];

  // Writes are counted rather than listed one by one: a big spec has dozens,
  // and one line saying none of them are served says it as well as forty.
  const writes = [];

  const reads = [];
  for (const [path, rawItem] of Object.entries(spec.paths)) {
    const item = refs.resolve(rawItem);
    if (!item || typeof item !== "object") continue;
    for (const method of ["post", "put", "patch", "delete"]) {
      if (item[method]) writes.push(`${method.toUpperCase()} ${path}`);
    }
    if (!item.get) continue;
    const segments = path.split("/").filter(Boolean);
    const isParam = (s) => /^\{.+\}$/.test(s);
    const itemRoute = segments.length > 0 && isParam(segments.at(-1));
    reads.push({
      path,
      op: item.get,
      itemRoute,
      param: itemRoute ? segments.at(-1).slice(1, -1) : null,
      collection: itemRoute ? segments.slice(0, -1) : segments,
    });
  }

  if (writes.length) {
    skipped.push({
      path: `${writes.length} write operation${writes.length === 1 ? "" : "s"}`,
      reason: "POST, PUT, PATCH and DELETE are not mocked — the mock serves reads. Every chaos control works on the reads.",
    });
  }

  // A prefix every route shares — /api/v1 on /api/v1/users and /api/v1/orders —
  // is part of the base URL, not of any resource. Stripped, and reported, so the
  // person knows what to swap for the mock's address. Never all of the shortest
  // route: /users and /users/{id} share "users", and that is the resource.
  const prefix = commonPrefix(reads.map((r) => r.collection));

  const found = new Map();
  for (const read of reads) {
    const rest = read.collection.slice(prefix.length);
    const label = `GET ${read.path}`;

    if (!rest.length) {
      skipped.push({ path: label, reason: "The root of the API, not a resource." });
      continue;
    }
    if (rest.some((s) => /^\{.+\}$/.test(s))) {
      skipped.push({ path: label, reason: "Nested under another resource. Only /name and /name/{id} can be served." });
      continue;
    }
    if (rest.length > 1) {
      skipped.push({ path: label, reason: "More than one segment deep. Only /name and /name/{id} can be served." });
      continue;
    }

    const name = rest[0];
    if (RESERVED_NAMES.has(name)) {
      skipped.push({ path: label, reason: `/${name} is where the mock's downloads live, so a resource cannot use the name.` });
      continue;
    }

    const schema = refs.resolve(responseSchema(read.op, v2, refs));
    if (!schema) {
      skipped.push({ path: label, reason: "No JSON response schema to generate records from." });
      continue;
    }

    const entry = found.get(name) || { name, paths: [] };
    entry.paths.push(read.path);

    if (read.itemRoute) {
      entry.itemSchema = schema;
      entry.param = read.param;
    } else {
      const list = listItems(schema, refs);
      if (!list) {
        skipped.push({ path: label, reason: "Returns a single object, not a list. Only list endpoints and their /{id} routes can be served." });
        continue;
      }
      // An array of anything says it is a list and nothing about what is in
      // it. Ten empty objects would look like a mock and test nothing.
      const shape = flatten(list.items, refs);
      if (!shape || (!typeOf(shape) && shape.example === undefined && !shape.enum)) {
        skipped.push({ path: label, reason: "Says it returns a list, but not what is in it — the items have no schema." });
        continue;
      }
      entry.listSchema = list.items;
      if (list.wrapper) {
        warnings.push(`GET ${read.path} returns its rows inside {"${list.wrapper}": [...]}. The mock serves the bare array, so unwrap it on your side or point the parser at the array.`);
      }
    }
    found.set(name, entry);
  }

  const resources = [...found.values()].filter((e) => e.listSchema || e.itemSchema);

  const build = (per) => {
    // Known before anything is generated, so a userId can point at a user that
    // will exist whichever order the resources are written in.
    const counts = Object.fromEntries(resources.map((e) => [e.name, per]));
    const data = {};
    for (const entry of resources) {
      const schema = entry.listSchema || entry.itemSchema;
      data[entry.name] = Array.from({ length: per }, (_, i) =>
        generate(schema, { refs, rng: seeded(`${entry.name}#${i}`), index: i, depth: 0, key: "", owner: entry.name, top: true, counts }));
    }
    return data;
  };

  // Halved until it fits, because a spec with wide records would otherwise be
  // refused outright for a size nobody chose. One record per resource is still
  // enough to test against; below that there is nothing to serve.
  let per = perResource;
  let data = build(per);
  while (JSON.stringify(data).length > maxBytes && per > 1) {
    per = Math.max(1, Math.floor(per / 2));
    data = build(per);
  }
  if (JSON.stringify(data).length > maxBytes) {
    return { error: { message: "The records this spec describes are too large", hint: `Even one record per resource is over ${Math.round(maxBytes / 1024)} KB.` } };
  }
  if (per < perResource) {
    warnings.push(`The records are large, so each resource has ${per} instead of ${perResource} to stay under the size limit.`);
  }

  for (const entry of resources) {
    const first = data[entry.name][0];
    if (!entry.itemSchema) continue;
    if (!first || typeof first !== "object" || !("id" in first)) {
      warnings.push(`/${entry.name}/{${entry.param}} finds records by their "id" field, and these have none, so it will answer 404.`);
    } else if (!/^(id|[a-z]*_?id|[a-z]*Id|uuid|guid)$/i.test(entry.param)) {
      warnings.push(`/${entry.name}/{${entry.param}} is looked up by "id" on the mock, not by ${entry.param}. Ask for /${entry.name}/${first.id}, not a ${entry.param}.`);
    }
  }

  for (const ref of refs.external) {
    warnings.push(`${ref} points outside this document and was not followed. Fields that use it are null.`);
  }

  const server = v2
    ? (spec.host ? `https://${spec.host}` : "") + (spec.basePath && spec.basePath !== "/" ? spec.basePath : "")
    : String(spec.servers?.[0]?.url || "").replace(/\/$/, "");
  const replaces = server + (prefix.length ? `/${prefix.join("/")}` : "");

  return {
    data,
    info: {
      title: typeof spec.info?.title === "string" ? spec.info.title.slice(0, 120) : "",
      version: typeof spec.info?.version === "string" ? spec.info.version.slice(0, 40) : "",
    },
    // What the app's base URL should stop being. Empty when the spec never said.
    replaces: replaces.slice(0, 300),
    skipped,
    warnings: [...new Set(warnings)],
  };
}

// --- Reading the spec ----------------------------------------------------------

function resolver(spec) {
  const external = new Set();
  const resolve = (node, seen = new Set()) => {
    while (node && typeof node === "object" && typeof node.$ref === "string") {
      const ref = node.$ref;
      if (!ref.startsWith("#/")) {
        external.add(ref.slice(0, 200));
        return null;
      }
      // A ref that leads back to itself would spin forever.
      if (seen.has(ref)) return null;
      seen.add(ref);
      node = ref
        .slice(2)
        .split("/")
        .map((p) => decodeURIComponent(p).replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce((at, key) => (at && typeof at === "object" ? at[key] : undefined), spec);
    }
    return node ?? null;
  };
  return { resolve, external };
}

// 200 first, then any other 2xx, then default: the success answer is the one the
// app parses, and default is usually the error shape.
function responseSchema(op, v2, refs) {
  const responses = op?.responses || {};
  const codes = Object.keys(responses);
  const code =
    ["200", "201"].find((c) => c in responses) ??
    codes.find((c) => /^2(\d\d|XX|xx)$/.test(c)) ??
    ("default" in responses ? "default" : undefined);
  if (code === undefined) return null;

  const response = refs.resolve(responses[code]);
  if (!response) return null;
  if (v2) return response.schema || null;

  const content = response.content || {};
  const type =
    Object.keys(content).find((t) => /\bjson\b|\+json/i.test(t)) ??
    ("*/*" in content ? "*/*" : undefined);
  return type ? content[type]?.schema || null : null;
}

// A list is an array, or an object carrying one — the { data: [...], total }
// that paginated APIs wrap their rows in.
function listItems(schema, refs) {
  const s = flatten(schema, refs);
  if (typeOf(s) === "array") return { items: refs.resolve(s.items) || {} };
  if (typeOf(s) !== "object" || !s.properties) return null;

  const arrays = Object.entries(s.properties).filter(([, p]) => typeOf(flatten(p, refs)) === "array");
  if (!arrays.length) return null;
  const [key, prop] = arrays.find(([k]) => WRAPPER_KEYS.includes(k.toLowerCase())) || arrays[0];
  return { items: refs.resolve(flatten(prop, refs).items) || {}, wrapper: key };
}

function commonPrefix(lists) {
  if (!lists.length) return [];
  const limit = Math.min(...lists.map((l) => l.length)) - 1;
  const prefix = [];
  for (let i = 0; i < limit; i++) {
    const seg = lists[0][i];
    if (/^\{.+\}$/.test(seg) || !lists.every((l) => l[i] === seg)) break;
    prefix.push(seg);
  }
  return prefix;
}

function typeOf(s) {
  if (!s || typeof s !== "object") return null;
  // 3.1 allows ["string", "null"]; the non-null one is the answer.
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (t) return t;
  if (s.properties || s.additionalProperties) return "object";
  if (s.items) return "array";
  return null;
}

// allOf merged into one object; oneOf/anyOf reduced to their first real option.
// Enough to write a record the app will accept, which is all a mock needs.
function flatten(schema, refs, seen = 0) {
  let s = refs.resolve(schema);
  if (!s || typeof s !== "object" || seen > MAX_DEPTH) return s;

  if (Array.isArray(s.allOf)) {
    const merged = { ...s, allOf: undefined, properties: { ...(s.properties || {}) } };
    for (const part of s.allOf) {
      const p = flatten(part, refs, seen + 1);
      if (!p) continue;
      Object.assign(merged.properties, p.properties || {});
      for (const k of ["type", "format", "items", "enum", "example"]) {
        if (merged[k] === undefined && p[k] !== undefined) merged[k] = p[k];
      }
    }
    if (!Object.keys(merged.properties).length) delete merged.properties;
    s = merged;
  }

  const options = s.oneOf || s.anyOf;
  if (Array.isArray(options)) {
    const pick = options.map((o) => flatten(o, refs, seen + 1)).find((o) => o && typeOf(o) !== "null");
    const { oneOf, anyOf, discriminator, ...rest } = s;
    if (pick) s = { ...rest, ...pick };
  }
  return s;
}

// --- Writing records -------------------------------------------------------------

function generate(schema, ctx) {
  const s = flatten(schema, ctx.refs);
  if (!s || typeof s !== "object") return null;
  if ("const" in s) return s.const;

  const type = typeOf(s);

  // Past the depth limit a recursive schema — a category with child categories
  // — stops with an empty list rather than an ever-deeper record.
  if (ctx.depth > MAX_DEPTH) return type === "array" ? [] : null;

  if (type === "object") {
    // One person per record, so firstName, lastName, email and username agree
    // with each other — and a fresh one for a nested author or owner, who is
    // somebody else.
    const person = !ctx.person || PERSON.test(ctx.key) ? { first: pick(FIRST, ctx.rng), last: pick(LAST, ctx.rng) } : ctx.person;
    const out = {};
    for (const [key, prop] of Object.entries(s.properties || {})) {
      out[key] = generate(prop, { ...ctx, key, person, owner: ctx.key || ctx.owner, depth: ctx.depth + 1, top: false, parentTop: ctx.top });
    }
    return out;
  }

  if (type === "array") {
    const min = Math.max(0, Number(s.minItems) || 0);
    const max = Math.max(min, Math.min(Number(s.maxItems) || 3, 3));
    const n = Math.min(max, Math.max(min, 1 + (ctx.rng() * 3 | 0)));
    return Array.from({ length: n }, (_, i) =>
      generate(s.items, { ...ctx, key: singular(ctx.key), depth: ctx.depth + 1, top: false, parentTop: false, index: ctx.index * 7 + i }));
  }

  // The record's own id is its position, so /users/3 is the third user and a
  // userId of 3 elsewhere points at them.
  const key = ctx.key.toLowerCase();
  if (ctx.parentTop && key === "id") return idValue(s, type, ctx.index + 1, ctx.rng);

  // A foreign key to another resource in the same mock is kept in range, so
  // following it finds something.
  const target = foreignKey(ctx.key, ctx.counts);
  if (target && (type === "integer" || type === "number" || type === "string")) {
    return idValue(s, type, 1 + (ctx.rng() * ctx.counts[target] | 0), ctx.rng);
  }

  // The spec's example is the first record's value. After that a string is
  // generated where a believable one can be — ten users all called theUser with
  // the same email break anything keyed on them — and the example is kept where
  // nothing better than "status 3" is on offer.
  const example = s.example !== undefined ? s.example
    : Array.isArray(s.examples) && s.examples.length ? s.examples[ctx.index % s.examples.length] : undefined;
  if (example !== undefined) {
    if (ctx.index === 0 || typeof example !== "string" || (type !== "string" && type !== null)) return example;
    const made = string(s, ctx);
    return made === fallback(ctx) ? example : made;
  }
  if (Array.isArray(s.enum)) {
    const values = s.enum.filter((v) => v !== null);
    if (values.length) return values[ctx.index % values.length];
  }

  if (type === "boolean") return ctx.rng() < 0.5;
  if (type === "integer" || type === "number") return number(s, type, key, ctx.rng);
  if (type === "string" || type === null) {
    if (type === null && s.default === undefined && !s.format) return null;
    return string(s, ctx);
  }
  return s.default ?? null;
}

const fallback = (ctx) => `${ctx.key || "value"} ${ctx.index + 1}`;

// Whose record this is decides what a bare "name" means: a person's on a user,
// a word or two on a tag, a category or a product.
const PERSON = /user|author|owner|customer|member|person|people|employee|contact|profile|account|staff|driver|patient|student|teacher|client|seller|buyer|creator|assignee|reviewer|admin/i;

function idValue(s, type, n, rng) {
  if (type === "integer" || type === "number") return n;
  if (s.format === "uuid") return uuid(rng);
  return String(n);
}

// userId, user_id, authorId → users, if there is a users resource to point at.
function foreignKey(key, counts) {
  const m = /^(.+?)[_-]?(id|Id|ID)$/.exec(key || "");
  if (!m) return null;
  const stem = m[1].toLowerCase();
  const candidates = [stem, `${stem}s`, `${stem}es`, stem.replace(/y$/, "ies")];
  return candidates.find((c) => c in counts) || null;
}

function number(s, type, key, rng) {
  let lo, hi, decimals = type === "integer" ? 0 : 2;
  const k = key.replace(/[_-]/g, "");
  if (/price|amount|cost|total|balance|salary|fee/.test(k)) [lo, hi] = [5, 500];
  else if (k === "age") [lo, hi] = [18, 80];
  else if (/rating|score|stars/.test(k)) [lo, hi, decimals] = [1, 5, type === "integer" ? 0 : 1];
  else if (/^lat(itude)?$/.test(k)) [lo, hi, decimals] = [-60, 70, 6];
  else if (/^(lng|lon|long|longitude)$/.test(k)) [lo, hi, decimals] = [-180, 180, 6];
  else if (/year/.test(k)) [lo, hi] = [1990, 2026];
  else if (/percent|pct/.test(k)) [lo, hi] = [0, 100];
  else [lo, hi] = [0, 1000];

  if (typeof s.minimum === "number") lo = s.exclusiveMinimum === true ? s.minimum + 1 : s.minimum;
  if (typeof s.maximum === "number") hi = s.exclusiveMaximum === true ? s.maximum - 1 : s.maximum;
  if (typeof s.exclusiveMinimum === "number") lo = s.exclusiveMinimum + (decimals ? 0.01 : 1);
  if (typeof s.exclusiveMaximum === "number") hi = s.exclusiveMaximum - (decimals ? 0.01 : 1);
  if (hi < lo) hi = lo;

  const v = lo + rng() * (hi - lo);
  return decimals ? Number(v.toFixed(decimals)) : Math.round(v);
}

function string(s, ctx) {
  const { rng, index } = ctx;
  const k = ctx.key.toLowerCase().replace(/[_-]/g, "");
  const first = ctx.person?.first || pick(FIRST, rng);
  const last = ctx.person?.last || pick(LAST, rng);
  // García is a name; garcía@ is not an address most validators accept.
  const mailbox = `${first}.${last}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const base = Date.UTC(2026, 0, 1) + index * 86400000 + Math.floor(rng() * 86400) * 1000;

  let v;
  switch (s.format) {
    case "date-time": v = new Date(base).toISOString(); break;
    case "date": v = new Date(base).toISOString().slice(0, 10); break;
    case "time": v = new Date(base).toISOString().slice(11, 19); break;
    case "email": v = `${mailbox}@example.com`; break;
    case "uri": case "url": case "uri-reference": v = `https://example.com/${k || "item"}/${index + 1}`; break;
    case "uuid": v = uuid(rng); break;
    case "hostname": v = `host${index + 1}.example.com`; break;
    case "ipv4": v = `192.0.2.${1 + (index % 254)}`; break;
    case "ipv6": v = `2001:db8::${(index + 1).toString(16)}`; break;
    case "byte": v = "Zmxha3k="; break;
    case "password": v = "********"; break;
  }

  if (v === undefined) {
    if (/email/.test(k)) v = `${mailbox}@example.com`;
    else if (/^(first|given)name$/.test(k)) v = first;
    else if (/^(last|family|sur)name$|^surname$/.test(k)) v = last;
    else if (/^(user|login|screen)name$|^handle$/.test(k)) v = `${mailbox.split(".")[0]}${10 + (rng() * 90 | 0)}`;
    else if (/^(full|display)?name$/.test(k)) v = PERSON.test(ctx.owner || "") ? `${first} ${last}` : sentence(rng, 1, 2, false).replace(/\b\w/g, (c) => c.toUpperCase());
    else if (/password|passwd|pwd/.test(k)) v = "********";
    else if (/avatar|image|photo|picture|thumbnail|logo|icon/.test(k)) v = `https://picsum.photos/seed/${k}${index + 1}/200/200`;
    else if (/url|link|website|homepage|href/.test(k)) v = `https://example.com/${k.replace(/url$/, "") || "item"}/${index + 1}`;
    else if (/phone|mobile|tel/.test(k)) v = `+1-555-01${String(index % 100).padStart(2, "0")}`;
    else if (/(_at|At)$/.test(ctx.key) || /date|timestamp|^(created|updated|deleted|modified|published)/.test(k)) v = new Date(base).toISOString();
    else if (/^(title|subject|headline|label|heading)$/.test(k)) v = sentence(rng, 3, 6, false);
    else if (/description|summary|body|content|text|bio|message|comment|note|details/.test(k)) v = sentence(rng, 8, 16, true);
    else if (/city|town/.test(k)) v = pick(CITIES, rng);
    else if (/country/.test(k)) v = pick(COUNTRIES, rng);
    else if (/street|address/.test(k)) v = `${1 + (rng() * 400 | 0)} ${pick(LAST, rng)} Street`;
    else if (/zip|postcode|postalcode/.test(k)) v = String(10000 + (rng() * 89999 | 0));
    else if (/company|organi[sz]ation|org$|employer/.test(k)) v = `${pick(LAST, rng)} ${pick(COMPANY, rng)}`;
    else if (/colou?r/.test(k)) v = `#${(rng() * 0xffffff | 0).toString(16).padStart(6, "0")}`;
    else if (/currency/.test(k)) v = pick(["USD", "EUR", "INR", "GBP", "JPY"], rng);
    else if (/status/.test(k)) v = pick(["active", "pending", "inactive"], rng);
    else if (/slug/.test(k)) v = sentence(rng, 2, 4, false).toLowerCase().replace(/\s+/g, "-");
    else if (/sku|code/.test(k)) v = `${(k.slice(0, 3) || "sku").toUpperCase()}-${1000 + index + 1}`;
    else if (/locale|lang/.test(k)) v = pick(["en-US", "en-IN", "de-DE", "ja-JP", "pt-BR"], rng);
    else if (/token|hash|secret|key/.test(k)) v = Array.from({ length: 32 }, () => (rng() * 16 | 0).toString(16)).join("");
    else if (/^(id|uuid|guid)$|id$/.test(k)) v = String(index + 1);
    else if (s.default !== undefined) v = String(s.default);
    else v = fallback(ctx);
  }

  const min = Number(s.minLength) || 0;
  const max = Number(s.maxLength) || Infinity;
  if (v.length > max) v = v.slice(0, max);
  while (v.length < min) v += "x";
  return v;
}

// --- Determinism -------------------------------------------------------------------

// Seeded from the resource and the row, so adding a resource to the spec does
// not reshuffle every other resource's records.
function seeded(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    // mulberry32
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuid(rng) {
  const hex = Array.from({ length: 32 }, () => (rng() * 16 | 0).toString(16));
  hex[12] = "4";
  hex[16] = "89ab"[rng() * 4 | 0];
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const pick = (list, rng) => list[rng() * list.length | 0];

function singular(key) {
  if (!key) return "";
  if (/ies$/.test(key)) return key.replace(/ies$/, "y");
  if (/s$/.test(key) && !/ss$/.test(key)) return key.slice(0, -1);
  return key;
}

function sentence(rng, lo, hi, period) {
  const n = lo + (rng() * (hi - lo + 1) | 0);
  const words = Array.from({ length: n }, () => pick(WORDS, rng));
  const text = words.join(" ");
  return text[0].toUpperCase() + text.slice(1) + (period ? "." : "");
}

const FIRST = ["Asha", "Wei", "Mateo", "Amara", "Lena", "Kofi", "Priya", "Jonas", "Yuki", "Sofia", "Omar", "Ines", "Ravi", "Maya", "Tomás", "Hana", "Arjun", "Elif", "Noah", "Zara"];
const LAST = ["Menon", "Chen", "García", "Okafor", "Schmidt", "Mensah", "Iyer", "Berg", "Tanaka", "Rossi", "Haddad", "Silva", "Kapoor", "Novak", "Moreau", "Kim", "Sato", "Yilmaz", "Walsh", "Ahmed"];
const CITIES = ["Bengaluru", "Lisbon", "Nairobi", "Osaka", "Toronto", "Berlin", "São Paulo", "Melbourne", "Seoul", "Dublin"];
const COUNTRIES = ["India", "Portugal", "Kenya", "Japan", "Canada", "Germany", "Brazil", "Australia", "South Korea", "Ireland"];
const COMPANY = ["Labs", "Systems", "& Co", "Studio", "Works", "Group"];
const WORDS = ["quick", "retry", "cache", "signal", "harbor", "orbit", "paper", "river", "stable", "window", "garden", "vector", "silent", "copper", "north", "bright", "echo", "lantern", "meadow", "pixel", "timber", "velvet", "summit", "anchor"];
