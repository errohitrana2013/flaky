-- Run with: npm run db:init
--   (npx wrangler d1 execute flaky --file=migrations/0001_init.sql --remote)
--
-- Add a 0002_*.sql rather than editing this file.

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'free',
  created_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key   ON api_keys (key);
CREATE INDEX IF NOT EXISTS idx_api_keys_email ON api_keys (email);

CREATE TABLE IF NOT EXISTS sandboxes (
  id          TEXT PRIMARY KEY,
  key_id      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (key_id) REFERENCES api_keys (id)
);

CREATE INDEX IF NOT EXISTS idx_sandboxes_key     ON sandboxes (key_id);
CREATE INDEX IF NOT EXISTS idx_sandboxes_expires ON sandboxes (expires_at);

CREATE TABLE IF NOT EXISTS sandbox_records (
  sandbox_id  TEXT NOT NULL,
  resource    TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sandbox_id, resource, record_id)
);

-- Purge expired sandboxes on a cron trigger:
--   DELETE FROM sandbox_records WHERE sandbox_id IN (SELECT id FROM sandboxes WHERE expires_at < unixepoch() * 1000);
--   DELETE FROM sandboxes WHERE expires_at < unixepoch() * 1000;

-- ---------------------------------------------------------------------------
-- Analytics rollups
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_daily (
  day       TEXT NOT NULL,
  key_id    TEXT NOT NULL DEFAULT 'anon',
  tier      TEXT NOT NULL DEFAULT 'anonymous',
  requests  INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  visitors  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_daily (day);

-- Salted, truncated visitor hashes. Never a raw IP. Purged after 90 days.
CREATE TABLE IF NOT EXISTS daily_visitors (
  day     TEXT NOT NULL,
  visitor TEXT NOT NULL,
  PRIMARY KEY (day, visitor)
);
