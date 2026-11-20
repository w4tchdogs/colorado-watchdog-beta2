-- Existing name events retain their original IDs and snapshots after a
-- Profile is deleted. New name events still require live matching rows.
CREATE TABLE profile_name_events_0035 (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  person_id TEXT NOT NULL,
  profile_name_id TEXT,
  action TEXT NOT NULL CHECK (
    action IN (
      'primary_update', 'alternate_add', 'alternate_update',
      'alternate_remove', 'alternate_restore'
    )
  ),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  before_json TEXT CHECK (before_json IS NULL OR (json_valid(before_json) AND length(before_json) <= 16384)),
  after_json TEXT CHECK (after_json IS NULL OR (json_valid(after_json) AND length(after_json) <= 16384)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO profile_name_events_0035 (id, person_id, profile_name_id, action, actor_account_id, before_json, after_json, created_at)
SELECT id, person_id, profile_name_id, action, actor_account_id, before_json, after_json, created_at FROM profile_name_events;
DROP TABLE profile_name_events;
ALTER TABLE profile_name_events_0035 RENAME TO profile_name_events;

CREATE INDEX profile_name_events_person ON profile_name_events (person_id, created_at);

CREATE TRIGGER profile_name_events_no_update
BEFORE UPDATE ON profile_name_events
BEGIN
  SELECT RAISE(ABORT, 'profile_name_events are append-only');
END;

CREATE TRIGGER profile_name_events_no_delete
BEFORE DELETE ON profile_name_events
BEGIN
  SELECT RAISE(ABORT, 'profile_name_events are append-only');
END;

CREATE TRIGGER profile_name_events_live_target
BEFORE INSERT ON profile_name_events
WHEN NOT EXISTS (SELECT 1 FROM people p WHERE p.id = NEW.person_id)
  OR (NEW.profile_name_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profile_names n
    WHERE n.id = NEW.profile_name_id AND n.person_id = NEW.person_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'profile_name_events require a live matching target');
END;

-- Stable Website IDs retired by an owner deletion. Import receipts keep their
-- original mappings. The current mapping lookup can identify a retired target.
CREATE TABLE profile_deleted_targets (
  entity TEXT NOT NULL CHECK (entity IN ('people', 'person_roles', 'profile_names')),
  target_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  deletion_generation INTEGER NOT NULL CHECK (deletion_generation >= 0),
  PRIMARY KEY (entity, target_id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER profile_deleted_targets_no_update
BEFORE UPDATE ON profile_deleted_targets
BEGIN
  SELECT RAISE(ABORT, 'profile_deleted_targets are append-only');
END;

CREATE TRIGGER profile_deleted_targets_no_delete
BEFORE DELETE ON profile_deleted_targets
BEGIN
  SELECT RAISE(ABORT, 'profile_deleted_targets are append-only');
END;
