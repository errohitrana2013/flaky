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
