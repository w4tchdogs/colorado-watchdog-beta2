-- Archived accounts are disabled historical records. Keep account, identity,
-- audit, grant and sync-batch foreign keys intact for owner inspection.
-- Account deletion is unavailable; durable history keeps its account FK.
-- SQLite cannot alter a CHECK constraint, so rebuild the account table while
-- preserving every column and row. Dependent FKs continue to reference it.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER IF EXISTS agent_capability_grants_agent_only;
CREATE TABLE accounts_next (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  role TEXT NOT NULL CHECK (role IN ('contributor', 'editor', 'administrator', 'owner')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  email TEXT CHECK (email IS NULL OR length(trim(email)) > 0),
  preferences TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(preferences)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO accounts_next SELECT * FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_next RENAME TO accounts;

CREATE TRIGGER accounts_version_increment
BEFORE UPDATE ON accounts
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'accounts version must increment by one'); END;

CREATE TRIGGER agent_capability_grants_agent_only
BEFORE INSERT ON agent_capability_grants
WHEN (SELECT kind FROM accounts WHERE id = NEW.account_id) IS NOT 'agent'
BEGIN SELECT RAISE(ABORT, 'Capability grants are limited to agent accounts'); END;

