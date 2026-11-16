-- AUTH-3-WEB: server-side state for external OIDC human sign-in.
-- Additive. It stores no provider token, no authorization code and no
-- credential in clear text. Only SHA-256 hashes of opaque browser handles are
-- kept, and a session only points at an existing human identity and account.

-- One row per started sign-in. It is single use (consumed_at), bound to one
-- browser by browser_hash, and expires after five minutes. The sign-in route
-- purges stale rows and caps live rows, so unauthenticated requests cannot
-- grow this table without bound.
CREATE TABLE auth_login_transactions (
  state_hash TEXT PRIMARY KEY CHECK (
    length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'
  ),
  browser_hash TEXT NOT NULL CHECK (
    length(browser_hash) = 64 AND browser_hash NOT GLOB '*[^0-9a-f]*'
  ),
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 16 AND 128),
  code_verifier TEXT NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  return_path TEXT NOT NULL CHECK (
    length(return_path) BETWEEN 1 AND 200 AND substr(return_path, 1, 1) = '/'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX auth_login_transactions_expiry
  ON auth_login_transactions (expires_at);

-- One row per browser session. The cookie value is never stored, only its
-- hash. provider and subject repeat the link the session was issued for, so a
-- session cannot follow an identity that was re-pointed to another subject.
CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  account_id TEXT NOT NULL
    REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  identity_id TEXT NOT NULL
    REFERENCES identities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
  created_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE INDEX auth_sessions_account ON auth_sessions (account_id);
CREATE INDEX auth_sessions_identity ON auth_sessions (identity_id);
CREATE INDEX auth_sessions_absolute_expiry
  ON auth_sessions (absolute_expires_at);
