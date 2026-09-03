// One place to change what each tier may do. Handlers read from here rather
// than hardcoding numbers, so a pricing change is a one-file edit.
export const TIERS = {
  anonymous: { requestsPerDay: 1000,    maxLimit: 100,  sandboxes: 0,  chaos: true },
  free:      { requestsPerDay: 10000,   maxLimit: 250,  sandboxes: 1,  chaos: true },
  pro:       { requestsPerDay: 1000000, maxLimit: 1000, sandboxes: 25, chaos: true },
};

export const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;
// Visitor hashes are personal-ish data, so they go early. The aggregates hold
// no identity and are small — a year keeps a like-for-like comparison possible
// without letting the tables grow forever.
export const VISITOR_RETENTION_DAYS = 90;
export const ROLLUP_RETENTION_DAYS = 400;
export const MAX_INJECTED_DELAY_MS = 10000;

// --- abuse ceilings --------------------------------------------------------
//
// Keys are free and unverified on purpose: a key buys a higher rate limit and
// a sandbox, not access to anything private, so a confirmation loop would cost
// signups and protect nothing. But "unverified" must not mean "unlimited" —
// without a ceiling, one script with a wordlist of addresses can mint keys
// forever, and every key carries a sandbox allowance.
export const KEYS_PER_IP_PER_DAY = 5;

// Keys are free, so without this one address could mint several and multiply
// its allowance — the anonymous limit would be bypassable by scripting signups.
// Set above a single free key's 10k so a normal keyed user never sees it, and
// far below 5 x 10k so stacking keys buys little. A shared office IP hits this
// collectively, which is the accepted cost of not verifying emails.
export const IP_DAILY_CEILING = 20000;

// A sandbox record is stored in D1, so an unbounded body is unbounded storage
// on a free tier with no spend cap. 64 KB is far more than any plausible mock
// record and small enough that filling 5 GB needs ~80,000 deliberate writes.
export const MAX_SANDBOX_RECORD_BYTES = 64 * 1024;
export const MAX_SANDBOX_RECORDS = 500;

// A custom API is the caller's own JSON, served back as endpoints for a day.
// 256 KB is generous for mock data and small enough that abuse is bounded:
// filling D1's 5 GB free tier would take 20,000 deliberate uploads.
export const MAX_CUSTOM_BYTES = 256 * 1024;
export const CUSTOM_TTL_MS = 24 * 60 * 60 * 1000;
export const CUSTOM_PER_IP_PER_DAY = 10;

// A scenario is a counter, so it needs a life and a ceiling like everything
// else. 50 failures is far more than any retry policy or breaker threshold.
export const SCENARIO_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SCENARIO_FAILURES = 50;
