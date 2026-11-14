CREATE TABLE owner_bootstrap_audit (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'trusted_bootstrap_operator'),
  actor_reference TEXT NOT NULL CHECK (length(trim(actor_reference)) > 0),
  action TEXT NOT NULL CHECK (action = 'account.first_owner.bootstrap'),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  identity_id TEXT NOT NULL REFERENCES identities(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  site_project_id TEXT NOT NULL CHECK (length(trim(site_project_id)) > 0),
  summary TEXT NOT NULL CHECK (summary = 'First human owner established by trusted administrative bootstrap'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX owner_bootstrap_audit_single_event
  ON owner_bootstrap_audit (action);

CREATE TRIGGER owner_bootstrap_audit_no_update
BEFORE UPDATE ON owner_bootstrap_audit
BEGIN
  SELECT RAISE(ABORT, 'owner bootstrap audit is append-only');
END;

CREATE TRIGGER owner_bootstrap_audit_no_delete
BEFORE DELETE ON owner_bootstrap_audit
BEGIN
  SELECT RAISE(ABORT, 'owner bootstrap audit is append-only');
END;
