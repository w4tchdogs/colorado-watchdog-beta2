CREATE TABLE accounts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  role TEXT NOT NULL CHECK (
    role IN ('contributor', 'editor', 'administrator', 'owner')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  email TEXT CHECK (email IS NULL OR length(trim(email)) > 0),
  preferences TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(preferences)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE identities (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
  credential_hash TEXT CHECK (
    credential_hash IS NULL OR (
      length(credential_hash) = 64 AND credential_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  expires_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, subject)
) STRICT;

CREATE UNIQUE INDEX identities_credential_hash_unique
  ON identities (credential_hash)
  WHERE credential_hash IS NOT NULL;

CREATE TABLE operations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  created_by_account_id TEXT REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  progress_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(progress_json)),
  error_code TEXT,
  started_at TEXT,
  finished_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (status IN ('succeeded', 'failed', 'cancelled') AND finished_at IS NOT NULL)
    OR (status IN ('pending', 'running') AND finished_at IS NULL)
  )
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  operation_id TEXT REFERENCES operations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  target_type TEXT NOT NULL CHECK (length(trim(target_type)) > 0),
  target_id TEXT,
  summary TEXT NOT NULL CHECK (length(summary) <= 500),
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END;

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  operation_id TEXT REFERENCES operations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  application_commit TEXT NOT NULL CHECK (length(trim(application_commit)) > 0),
  migration_version INTEGER NOT NULL CHECK (migration_version >= 0),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    verification_status IN ('pending', 'verified', 'failed')
  ),
  verification_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(verification_json)),
  verified_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (verification_status = 'verified' AND verified_at IS NOT NULL)
    OR (verification_status IN ('pending', 'failed') AND verified_at IS NULL)
  )
) STRICT;

CREATE TRIGGER accounts_version_increment
BEFORE UPDATE ON accounts
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'accounts version must increment by one');
END;

CREATE TRIGGER identities_version_increment
BEFORE UPDATE ON identities
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'identities version must increment by one');
END;

CREATE TRIGGER operations_version_increment
BEFORE UPDATE ON operations
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'operations version must increment by one');
END;

CREATE TRIGGER checkpoints_version_increment
BEFORE UPDATE ON checkpoints
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'checkpoints version must increment by one');
END;
