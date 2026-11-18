-- Profile visibility and owner Profiles sheet receipts (PROFILES-1).
--
-- Visibility is a Profile-level publication control kept apart from the
-- people row, so changing it never advances people.version and never
-- interferes with a reviewed Profiles sync that expects that version.
-- A Profile with no row here keeps its current public visibility, so every
-- existing Website record stays visible through this migration. A row with
-- visible = 0 hides the Profile everywhere the public Website reads people.
CREATE TABLE person_visibility (
  person_id TEXT PRIMARY KEY REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  changed_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX person_visibility_hidden ON person_visibility (person_id)
  WHERE visible = 0;

CREATE TRIGGER person_visibility_version_increment
BEFORE UPDATE ON person_visibility
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'person_visibility version must increment by one');
END;

-- One stored answer per human actor and idempotency key. The receipt is
-- written in the same atomic batch as the changes it describes, so a retried
-- save returns the recorded result and never applies twice.
CREATE TABLE profile_write_receipts (
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json) AND length(response_json) <= 262144),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (actor_account_id, idempotency_key)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER profile_write_receipts_no_update
BEFORE UPDATE ON profile_write_receipts
BEGIN
  SELECT RAISE(ABORT, 'profile_write_receipts are append-only');
END;

CREATE INDEX IF NOT EXISTS person_roles_person_id ON person_roles (person_id);
