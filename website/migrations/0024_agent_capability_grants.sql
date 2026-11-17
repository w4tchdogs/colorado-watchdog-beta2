-- Explicit, revocable capability grants for agent accounts. No role holds a
-- synchronization capability, so sync.read, sync.apply and sync.revert reach an
-- agent only through an active row here. A grant is limited to agent accounts
-- and to the three sync capabilities. Every change bumps the dependency
-- generation, so a guarded sync commit that began before a grant change is
-- stale.
CREATE TABLE agent_capability_grants (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  capability TEXT NOT NULL CHECK (capability IN ('sync.read', 'sync.apply', 'sync.revert')),
  granted_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  granted_at TEXT NOT NULL CHECK (length(granted_at) BETWEEN 20 AND 40),
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(revoked_at) BETWEEN 20 AND 40),
  revoked_by_account_id TEXT REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revoked_by_account_id IS NULL))
) STRICT;

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
