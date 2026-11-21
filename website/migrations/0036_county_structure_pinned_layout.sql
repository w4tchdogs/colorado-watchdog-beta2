-- County Structure public card placement. These owner-managed preferences are
-- separate from county.csv's organizational hierarchy and relationships.

CREATE TABLE county_structure_layout_state (
  county_fips TEXT PRIMARY KEY REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

INSERT INTO county_structure_layout_state (county_fips, version)
SELECT fips, 0 FROM counties;

CREATE TABLE county_structure_pinned_group (
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  group_id TEXT NOT NULL CHECK (length(group_id) BETWEEN 1 AND 256),
  pinned_column TEXT NOT NULL CHECK (pinned_column IN ('left', 'right')),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 100),
  PRIMARY KEY (county_fips, group_id),
  UNIQUE (county_fips, pinned_column, position)
) STRICT, WITHOUT ROWID;

CREATE TABLE county_structure_layout_history (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  layout_version INTEGER NOT NULL CHECK (layout_version >= 0),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (county_fips, idempotency_key)
) STRICT;

CREATE INDEX county_structure_layout_history_county
  ON county_structure_layout_history (county_fips, created_at DESC);

CREATE TRIGGER county_structure_layout_history_no_update
BEFORE UPDATE ON county_structure_layout_history
BEGIN
  SELECT RAISE(ABORT, 'county structure layout history is append-only');
END;

CREATE TRIGGER county_structure_layout_history_no_delete
BEFORE DELETE ON county_structure_layout_history
BEGIN
  SELECT RAISE(ABORT, 'county structure layout history is append-only');
END;

-- Keep every new mutable dependency in the same optimistic guard protocol as
-- the rest of Website D1. History is append-only; its update/delete triggers
-- are still registered so the dependency coverage stays complete.
CREATE TRIGGER website_dependency_county_structure_layout_state_insert
AFTER INSERT ON county_structure_layout_state
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER website_dependency_county_structure_layout_state_update
AFTER UPDATE ON county_structure_layout_state
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER website_dependency_county_structure_layout_state_delete
AFTER DELETE ON county_structure_layout_state
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER website_dependency_county_structure_pinned_group_insert
AFTER INSERT ON county_structure_pinned_group
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER website_dependency_county_structure_pinned_group_update
AFTER UPDATE ON county_structure_pinned_group
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER website_dependency_county_structure_pinned_group_delete
AFTER DELETE ON county_structure_pinned_group
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER website_dependency_county_structure_layout_history_insert
AFTER INSERT ON county_structure_layout_history
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER website_dependency_county_structure_layout_history_update
AFTER UPDATE ON county_structure_layout_history
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
CREATE TRIGGER website_dependency_county_structure_layout_history_delete
AFTER DELETE ON county_structure_layout_history
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
