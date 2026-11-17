-- Allow the read-only d1.inspect capability as an explicit agent grant. A
-- contributor agent holds no role capability, so an active d1.inspect grant
-- lets it call the fixed inspection tools and nothing else. SQLite cannot alter
-- a CHECK constraint, so the table is rebuilt with the same columns, index and
-- triggers. Existing rows, including retained revoked grants, are copied as is.
CREATE TABLE agent_capability_grants_next (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK (capability IN ('sync.read', 'sync.apply', 'sync.revert', 'd1.inspect')),
  granted_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  granted_at TEXT NOT NULL CHECK (length(granted_at) BETWEEN 20 AND 40),
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(revoked_at) BETWEEN 20 AND 40),
  revoked_by_account_id TEXT REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revoked_by_account_id IS NULL))
) STRICT;

INSERT INTO agent_capability_grants_next
  (id, account_id, capability, granted_by_account_id, granted_at, revoked_at, revoked_by_account_id)
SELECT id, account_id, capability, granted_by_account_id, granted_at, revoked_at, revoked_by_account_id
FROM agent_capability_grants;

DROP TABLE agent_capability_grants;
ALTER TABLE agent_capability_grants_next RENAME TO agent_capability_grants;

CREATE UNIQUE INDEX agent_capability_grants_active
ON agent_capability_grants (account_id, capability)
WHERE revoked_at IS NULL;

CREATE INDEX agent_capability_grants_account
ON agent_capability_grants (account_id);

CREATE TRIGGER agent_capability_grants_agent_only
BEFORE INSERT ON agent_capability_grants
WHEN (SELECT kind FROM accounts WHERE id = NEW.account_id) IS NOT 'agent'
BEGIN
  SELECT RAISE(ABORT, 'Capability grants are limited to agent accounts');
END;

CREATE TRIGGER agent_capability_grants_immutable
BEFORE UPDATE ON agent_capability_grants
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.id IS NOT OLD.id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.capability IS NOT OLD.capability
  OR NEW.granted_by_account_id IS NOT OLD.granted_by_account_id
  OR NEW.granted_at IS NOT OLD.granted_at
BEGIN
  SELECT RAISE(ABORT, 'A capability grant can only be revoked once');
END;

CREATE TRIGGER agent_capability_grants_no_delete
BEFORE DELETE ON agent_capability_grants
BEGIN
  SELECT RAISE(ABORT, 'Capability grants are retained');
END;

CREATE TRIGGER website_dependency_agent_capability_grants_insert
AFTER INSERT ON agent_capability_grants
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER website_dependency_agent_capability_grants_update
AFTER UPDATE ON agent_capability_grants
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER website_dependency_agent_capability_grants_delete
AFTER DELETE ON agent_capability_grants
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
