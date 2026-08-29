# flaky

A free mock REST API on Cloudflare Workers, with the differentiator built in:
callers control the response — status, latency, failure rate — and can take a
sandbox where writes actually persist.

```
GET /v1/posts?_delay=2000&_fail_rate=0.3
```

That is the whole pitch. Every other fake API gives you data; this one gives you
the failure you are trying to test against.

## Quick start

```bash
npm install
npm test          # 37 tests, ~0.4s, no network and no Cloudflare account
npm run dev       # http://localhost:8787
```

`npm run dev` needs a local D1 and KV — wrangler creates them on first run once
`wrangler.toml` has real ids. Everything except sandboxes and key issuance works
without them, because reads are served from the bundled dataset.

## Deploy

```bash
npx wrangler login
npx wrangler d1 create flaky                    # paste database_id into wrangler.toml
npx wrangler kv namespace create RATE_LIMITS    # paste id into wrangler.toml
npm run db:migrate                              # create tables

npx wrangler secret put VISITOR_SALT            # any long random string
npx wrangler secret put ADMIN_TOKEN             # guards /v1/admin/stats
npx wrangler secret put DIGEST_WEBHOOK          # optional: Slack/Discord URL

npm run deploy
```

> **Set a billing alert before you point a domain at this.** Workers has no spend
> cap, only alerts, and a public unauthenticated API is exactly the thing someone
> leaves in a retry loop. The rate limiter is the guard; see the caveat under
> [Rate limiting](#rate-limiting).

## Routes

| Route | Behaviour |
|---|---|
| `GET /v1/:resource` | List, with filtering, `_q` search, `_sort`, `_page`, `_limit` |
| `GET /v1/:resource/:id` | Single record |
| `GET /v1/:parent/:id/:child` | Nested, e.g. `/v1/posts/1/comments` |
| `POST/PUT/PATCH/DELETE /v1/:resource` | Echoed, **not stored** (`x-mock-write` header says so) |
| `POST /v1/keys` | Issue a free API key |
| `POST /v1/sandbox` | Create a 24h sandbox (needs a key) |
| `* /v1/sandbox/:id/:resource` | Full CRUD that persists |
| `GET /v1/meta` | Resource counts, tier limits, your tier |
| `GET /v1/admin/stats?days=14` | Traffic rollups (admin token required) |
| `GET /v1/admin/export?dataset=daily` | Same data as CSV (admin token required) |

Response controls, on any request: `?_delay=2000`, `?_status=503`, `?_fail_rate=0.3`

These are validated strictly and an out-of-range value is a `400`, never a
silent fallback. `_delay` takes 0–10000 ms, `_fail_rate` a probability of 0–1,
`_status` a code of 100–599. This matters more here than elsewhere: quietly
ignoring `_status=999` would return a `200` to someone testing their retry path
and their test would pass for the wrong reason. A tool for testing failures must
not fail quietly itself.

Resources: `users` (10), `posts` (100), `comments` (500), `albums` (100),
`photos` (1000), `todos` (200), `products` (100).

Tiers: anonymous 1k/day · free key 10k/day + 1 sandbox · pro 1M/day + 25 sandboxes.

## Folder structure

```
flaky/
├── src/
│   ├── index.js              entry point — wires middleware to the router, nothing else
│   ├── router.js             route table; add a path here, not in a giant if-chain
│   │
│   ├── config/               things you will want to change without reading code
│   │   ├── tiers.js          limits and prices per tier
│   │   └── constants.js      CORS headers, reserved query params, defaults
│   │
│   ├── middleware/           runs on the way in, on every request
│   │   ├── auth.js           API key → tier
│   │   ├── ratelimit.js      daily window in KV
│   │   ├── chaos.js          _delay / _status / _fail_rate
│   │   └── analytics.js      telemetry, rollups, digest, cleanup
│   │
│   ├── handlers/             one file per feature; this is where logic lives
│   │   ├── resources.js      reads and echoed writes
│   │   ├── sandbox.js        persistent CRUD overlay
│   │   ├── keys.js           key issuance
│   │   ├── meta.js           machine-readable API description
│   │   └── admin.js          traffic stats
│   │
│   ├── lib/                  pure helpers, no knowledge of routes or env
│   │   ├── response.js       json() / fail() / withHeaders()
│   │   ├── query.js          filter, search, sort, paginate
│   │   └── hash.js           salted visitor hashing, date helpers
│   │
│   └── data/
│       ├── db.js             generated — do not edit by hand
│       ├── index.js          loads and exposes collections
│       └── relations.js      parent → child links for nested routes
│
├── public/                   static site, served for anything outside /v1
│   ├── index.html            landing page with the live response inspector
│   ├── dashboard.html        traffic dashboard (admin token required)
│   └── docs/                 long-form docs go here
│
├── migrations/               applied in order by `npm run db:migrate`
│   ├── 0001_init.sql         keys, sandboxes, usage and visitor rollups
│   └── 0002_hourly_and_geo.sql  hour-of-day and per-country traffic
│
├── scripts/
│   └── generate-db.js        regenerates src/data/db.js deterministically
│
├── tests/
│   └── api.test.mjs          37 tests, no dependencies, runs offline
│
├── wrangler.toml             bindings and cron
├── .dev.vars.example         copy to .dev.vars for local secrets
└── package.json
```

### The rule that keeps this clean

Dependencies point one direction only:

```
index → router → handlers → lib
                    ↓
              middleware → lib
                    ↓
                 config
```

`lib/` never imports a handler. `config/` never imports anything. When you add
billing, it becomes `handlers/billing.js` plus a `middleware/subscription.js` —
no existing file grows.

### Where the next features go

| Feature | Where it lands |
|---|---|
| Razorpay checkout + webhooks | `handlers/billing.js`, `middleware/subscription.js` |
| Blog / SEO content | `public/docs/`, or a `handlers/content.js` if dynamic |
| A new mock resource | `scripts/generate-db.js` + `data/relations.js` only |
| A new nested route | `data/relations.js` only |
| A new tier | `config/tiers.js` only |

## The dataset

`src/data/db.js` is generated, committed, and bundled into the Worker — a list
request is an array slice, not a database read. The generator is seeded, so the
same input produces byte-identical output and regenerating never creates a noisy
diff.

```bash
npm run seed     # rewrites src/data/db.js
```

To add a resource: add a collection in `scripts/generate-db.js`, then register
any parent/child link in `src/data/relations.js`. Nothing else changes —
`/v1/meta`, the landing page table, and the 404 hints all read from those two
files.

## Tests

```bash
npm test     # 37 tests, no network, no Cloudflare account needed
```

Bindings (D1, KV, Analytics Engine, assets) are stubbed in memory at the top of
`tests/api.test.mjs`, so the suite runs anywhere. Add a test whenever you add a
route — the stub's `query()` function is where a new SQL statement needs a
matching branch.

## Rate limiting

A fixed daily window in KV, keyed by API key or IP, reset at 00:00 UTC.

**Known limitation:** KV is eventually consistent and caps writes at roughly one
per second per key, so a caller sending a burst is undercounted. This is a spend
guard, not a fairness mechanism. Before the paid tier means anything, move the
counter to a Durable Object — that is a change to `middleware/ratelimit.js` and
nothing else.

## Analytics

Every request is logged twice, for different reasons.

**Analytics Engine** (`flaky_requests`) gets one row per request. Column order is
load-bearing — the queries below index positionally, so append columns, never
reorder them.

```sql
-- Busiest endpoints last week, bots excluded
SELECT blob1 AS path, count() AS hits, avg(double1) AS avg_ms
FROM flaky_requests
WHERE timestamp > now() - INTERVAL '7' DAY AND double3 = 0
GROUP BY path ORDER BY hits DESC

-- Where visitors come from
SELECT blob7 AS referrer, count() AS hits FROM flaky_requests
WHERE blob7 != '' GROUP BY referrer ORDER BY hits DESC LIMIT 20

-- Unique visitors per day
SELECT toDate(timestamp) AS day, uniq(index1) AS visitors
FROM flaky_requests WHERE double3 = 0 GROUP BY day ORDER BY day
```

**D1 rollups** hold small per-day summaries so the dashboard and the digest stay
fast and free of API calls:

| Table | Grain | Answers |
|---|---|---|
| `usage_daily` | day × key | how much traffic, how many errors |
| `daily_visitors` | day × visitor (+ country) | how many unique people, from where |
| `usage_hourly` | day × hour (UTC) | what time of day people show up |
| `usage_geo` | day × country | which regions send the most requests |

That is four upserts per request, batched into one D1 call inside `waitUntil`.
Worth knowing before traffic grows: D1's free tier covers 100k writes a day, so
the rollups become the write ceiling at roughly 25k requests a day, well before
the Workers request limit does. When that gets close, drop `usage_geo` and read
regions from Analytics Engine instead — it already has the same data per request
with no write cost.

Country is as fine-grained as the rollups go. City or region would start to make
a low-traffic day identifying, which is exactly what the visitor hashing exists
to prevent.

Both run inside `ctx.waitUntil`, after the response is sent — telemetry can never
slow down or break a request.

### Dashboard

`/dashboard` — asks for the admin token, keeps it in sessionStorage only.
(Cloudflare's asset handler drops the `.html`, so `/dashboard.html` redirects
here.) It shows:

- **Totals** — requests, unique visitors, error rate, keys issued
- **Per day** — a row and a bar per day, error-heavy days in accent
- **When people use it** — a 24-bar hour-of-day histogram, converted from stored
  UTC into the *viewer's* timezone, half-hour offsets included, because "when
  should I ship" is a local-time question
- **Where they come from** — visitors and requests per country, with flags and
  names resolved by `Intl.DisplayNames` rather than a bundled country table
- **Busiest keys**

Each section has a **CSV** button beside its heading. Downloads cover 90 days
rather than the dashboard's 14, since someone opening a spreadsheet is looking
for a trend rather than today.

```bash
# same data without the browser, for a cron job or a notebook
curl -H "authorization: Bearer $ADMIN_TOKEN" \
  'https://your-worker/v1/admin/export?dataset=countries&days=90' -o countries.csv
```

Datasets: `daily`, `hourly`, `countries`, `visitors`, `keys`. Files open in
Excel and Sheets directly — UTF-8 BOM so accented country names survive, CRLF
line endings, and any cell starting with `=`, `+`, `-` or `@` is prefixed with
an apostrophe. That last one matters: without it a key id or email a stranger
chose is executed as a formula when the file is opened.

Hours stay UTC in the export even though the dashboard displays local. A
shifted number in a spreadsheet with no timezone recorded next to it is a trap,
so the column is named `hour_utc`.

To fill it with plausible numbers while developing, insert rows straight into
the local D1 — `.wrangler/` is gitignored, so it can never reach production.

### Daily digest

The 03:00 UTC cron posts a one-line summary to `DIGEST_WEBHOOK` (Slack or
Discord) and purges expired sandboxes.

## Privacy

Raw IPs are never stored. A visitor is a salted SHA-256 of IP + user-agent,
truncated to 8 bytes — countable, not identifiable. Hashes are purged after 90
days. Rotating `VISITOR_SALT` resets all visitor identity, which is the switch to
pull if a deletion request ever arrives. This keeps the API itself clear of the
DPDP Act and GDPR without a consent banner.

## Running costs

Workers is free to 100k requests/day, then $5/month with 10M included. Reads set
`cache-control: public, max-age=300`, so most repeat traffic is served at the
edge and never reaches the Worker. D1 and KV free tiers cover early usage.

## Before you launch

- Set the Cloudflare billing alert (see above — this is the one that can hurt)
- Point a domain at the Worker; endpoints are expected at `api.flaky.dev` with
  the site on `flaky.dev`
- Change the numbers in `config/tiers.js` if you want different limits
