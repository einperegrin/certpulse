-- CertPulse v0.2: API tokens for bearer-token auth (closes C-1 prerequisite).
-- Tokens are stored as SHA-256 hashes; the raw token is shown only at creation time.

CREATE TABLE IF NOT EXISTS api_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- SHA-256 hex of the token (64 chars). Never store the raw token.
  token_hash  TEXT NOT NULL UNIQUE,
  -- Human-readable label for the operator.
  label       TEXT NOT NULL,
  -- When this token was created.
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Optional expiry; NULL = never expires.
  expires_at  TEXT,
  -- When the token was last used to authenticate a request.
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash);
