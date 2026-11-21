CREATE TABLE auth_transactions (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  identity_id TEXT NOT NULL REFERENCES identities(id),
  issued_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE INDEX auth_sessions_expiry ON auth_sessions(idle_expires_at, absolute_expires_at);

INSERT INTO accounts(id,kind,role,status,display_name)
VALUES ('auth3-synthetic-contributor','human','contributor','active','Synthetic AUTH-3 Pilot Account');
INSERT INTO identities(id,account_id,provider,subject)
VALUES ('auth3-synthetic-identity','auth3-synthetic-contributor','auth0:https://tenant-placeholder.invalid/','synthetic-unlinked-sentinel');
