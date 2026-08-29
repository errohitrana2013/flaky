// One place to change what each tier may do. Handlers read from here rather
// than hardcoding numbers, so a pricing change is a one-file edit.
export const TIERS = {
  anonymous: { requestsPerDay: 1000,    maxLimit: 100,  sandboxes: 0,  chaos: true },
  free:      { requestsPerDay: 10000,   maxLimit: 250,  sandboxes: 1,  chaos: true },
  pro:       { requestsPerDay: 1000000, maxLimit: 1000, sandboxes: 25, chaos: true },
};

export const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const VISITOR_RETENTION_DAYS = 90;
export const MAX_INJECTED_DELAY_MS = 10000;

// --- abuse ceilings --------------------------------------------------------
//
// Keys are free and unverified on purpose: a key buys a higher rate limit and
// a sandbox, not access to anything private, so a confirmation loop would cost
// signups and protect nothing. But "unverified" must not mean "unlimited" —
// without a ceiling, one script with a wordlist of addresses can mint keys
// forever, and every key carries a sandbox allowance.
export const KEYS_PER_IP_PER_DAY = 5;

// A sandbox record is stored in D1, so an unbounded body is unbounded storage
// on a free tier with no spend cap. 64 KB is far more than any plausible mock
// record and small enough that filling 5 GB needs ~80,000 deliberate writes.
export const MAX_SANDBOX_RECORD_BYTES = 64 * 1024;
export const MAX_SANDBOX_RECORDS = 500;
