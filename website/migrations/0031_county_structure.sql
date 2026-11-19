-- County Structure (COUNTY-DB-1).
--
-- A dedicated county hierarchy that is independent of `organizations`. It is
-- populated from one `county.csv` through the owner dashboard. The canonical 64
-- county registry in `counties` is reused and never altered. The tables start
-- empty, and no existing table is changed or dropped.
--
-- Naming: `county_unit` holds structural units, `county_unit_display` holds
-- navigation groupings such as "Elected Official", `county_role_display` ties an
-- existing Profile role to a unit or a reviewed listing, and the
-- `county_structure_*` tables hold the version counter, import batches and
-- append-only history.

-- One row. Every committed change advances `version`, which is the optimistic
-- check for prepared changesets.
CREATE TABLE county_structure_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO county_structure_state (id, version) VALUES (1, 0);

-- Navigation groupings. A grouping is never a reporting parent.
CREATE TABLE county_unit_display (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND id GLOB '[A-Za-z0-9]*'
  ),
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'former', 'historical', 'review_required', 'hidden')
  ),
  applies_from TEXT CHECK (
    applies_from IS NULL OR applies_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  applies_until TEXT CHECK (
    applies_until IS NULL OR applies_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  display_order INTEGER CHECK (display_order IS NULL OR display_order >= 0),
  evidence TEXT CHECK (evidence IS NULL OR length(evidence) <= 4000),
  source_references TEXT CHECK (source_references IS NULL OR length(source_references) <= 4000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (applies_from IS NULL OR applies_until IS NULL OR applies_until >= applies_from)
) STRICT;

CREATE INDEX county_unit_display_county ON county_unit_display (county_fips);

-- Structural units. `id` is the stable identifier from county.csv. It is the
-- primary key and the exported identifier, so no mapping table exists. A unit
-- has at most one parent: another unit (structural) or one display grouping
-- (top-level unit listed under a grouping). Both blank means a top-level unit.
CREATE TABLE county_unit (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND id GLOB '[A-Za-z0-9]*'
  ),
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  parent_unit_id TEXT REFERENCES county_unit(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  display_group_id TEXT REFERENCES county_unit_display(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  parent_relationship TEXT CHECK (
    parent_relationship IS NULL OR parent_relationship IN ('part_of', 'reports_to', 'display_group')
  ),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
  organization_type TEXT NOT NULL CHECK (
    organization_type IN (
      'office', 'department', 'board', 'commission', 'division', 'section',
      'authority', 'district', 'program', 'other'
    )
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'former', 'historical', 'review_required', 'hidden')
  ),
  applies_from TEXT CHECK (
    applies_from IS NULL OR applies_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  applies_until TEXT CHECK (
    applies_until IS NULL OR applies_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  display_order INTEGER CHECK (display_order IS NULL OR display_order >= 0),
  -- Private administrative provenance. Never read by a public service.
  evidence TEXT CHECK (evidence IS NULL OR length(evidence) <= 4000),
  source_references TEXT CHECK (source_references IS NULL OR length(source_references) <= 4000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (parent_unit_id IS NULL OR parent_unit_id <> id),
  CHECK (applies_from IS NULL OR applies_until IS NULL OR applies_until >= applies_from),
  CHECK (
    (parent_unit_id IS NULL AND display_group_id IS NULL AND parent_relationship IS NULL)
    OR (parent_unit_id IS NOT NULL AND display_group_id IS NULL
        AND parent_relationship IN ('part_of', 'reports_to'))
    OR (parent_unit_id IS NULL AND display_group_id IS NOT NULL
        AND parent_relationship = 'display_group')
  )
) STRICT;

CREATE INDEX county_unit_county ON county_unit (county_fips);
CREATE INDEX county_unit_parent ON county_unit (parent_unit_id) WHERE parent_unit_id IS NOT NULL;
CREATE INDEX county_unit_group ON county_unit (display_group_id) WHERE display_group_id IS NOT NULL;

-- A unit and a grouping share one identifier space, because county.csv parent
-- identifiers may point at either.
CREATE TRIGGER county_unit_id_unshared_insert
BEFORE INSERT ON county_unit
WHEN EXISTS (SELECT 1 FROM county_unit_display WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'county unit identifier is already used by a display grouping');
END;

CREATE TRIGGER county_unit_display_id_unshared_insert
BEFORE INSERT ON county_unit_display
WHEN EXISTS (SELECT 1 FROM county_unit WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'display grouping identifier is already used by a county unit');
END;

-- The county of a unit never changes, so a stable identifier cannot drift
-- between counties.
CREATE TRIGGER county_unit_county_immutable
BEFORE UPDATE OF county_fips ON county_unit
WHEN NEW.county_fips <> OLD.county_fips
BEGIN
  SELECT RAISE(ABORT, 'county unit county cannot change');
END;

CREATE TRIGGER county_unit_display_county_immutable
BEFORE UPDATE OF county_fips ON county_unit_display
WHEN NEW.county_fips <> OLD.county_fips
BEGIN
  SELECT RAISE(ABORT, 'display grouping county cannot change');
END;

CREATE TRIGGER county_unit_parent_county_insert
BEFORE INSERT ON county_unit
WHEN NEW.parent_unit_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM county_unit parent
  WHERE parent.id = NEW.parent_unit_id AND parent.county_fips = NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'county unit hierarchy must remain within one county');
END;

CREATE TRIGGER county_unit_parent_county_update
BEFORE UPDATE OF parent_unit_id ON county_unit
WHEN NEW.parent_unit_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM county_unit parent
  WHERE parent.id = NEW.parent_unit_id AND parent.county_fips = NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'county unit hierarchy must remain within one county');
END;

CREATE TRIGGER county_unit_group_county_insert
BEFORE INSERT ON county_unit
WHEN NEW.display_group_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM county_unit_display grouping
  WHERE grouping.id = NEW.display_group_id AND grouping.county_fips = NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'display grouping must belong to the same county');
END;

CREATE TRIGGER county_unit_group_county_update
BEFORE UPDATE OF display_group_id ON county_unit
WHEN NEW.display_group_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM county_unit_display grouping
  WHERE grouping.id = NEW.display_group_id AND grouping.county_fips = NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'display grouping must belong to the same county');
END;

CREATE TRIGGER county_unit_no_cycle
BEFORE UPDATE OF parent_unit_id ON county_unit
WHEN NEW.parent_unit_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.parent_unit_id
    UNION ALL
    SELECT parent.parent_unit_id
    FROM county_unit parent
    JOIN ancestors ON parent.id = ancestors.id
    WHERE parent.parent_unit_id IS NOT NULL
  )
  SELECT 1 FROM ancestors WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'county unit hierarchy must not contain a cycle');
END;

-- Versions only move forward. An import re-attaches a moved unit in a second
-- statement that leaves the version unchanged, so equal is allowed.
CREATE TRIGGER county_unit_version_forward
BEFORE UPDATE ON county_unit
WHEN NEW.version <> OLD.version AND NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'county_unit version must increment by one');
END;

CREATE TRIGGER county_unit_display_version_forward
BEFORE UPDATE ON county_unit_display
WHEN NEW.version <> OLD.version AND NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'county_unit_display version must increment by one');
END;

-- Alternate, historical and abbreviated names. `position` keeps the exported
-- order so a round trip is exact.
CREATE TABLE county_unit_alias (
  unit_id TEXT NOT NULL REFERENCES county_unit(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  alias TEXT NOT NULL CHECK (length(trim(alias)) BETWEEN 1 AND 300),
  alias_kind TEXT NOT NULL DEFAULT 'alternate' CHECK (
    alias_kind IN ('alternate', 'historical', 'abbreviation')
  ),
  PRIMARY KEY (unit_id, position),
  UNIQUE (unit_id, alias)
) STRICT, WITHOUT ROWID;

-- Reviewed role classifications. The Profile and its role stay canonical in
-- `people` and `person_roles`. A row only adds a view of an existing role:
-- its organizational home, an elected-official listing or a department-leader
-- listing. One role can have several rows and never needs a copy. Elected
-- status is explicit and reviewed. It is never inferred from a title and never
-- implies a reporting relationship.
CREATE TABLE county_role_display (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  person_role_id TEXT NOT NULL REFERENCES person_roles(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  unit_id TEXT REFERENCES county_unit(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  listing TEXT NOT NULL CHECK (listing IN ('home', 'elected_official', 'department_leader')),
  reviewed_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reviewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (listing <> 'home' OR unit_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX county_role_display_unique
  ON county_role_display (person_role_id, listing, COALESCE(unit_id, ''));
CREATE INDEX county_role_display_unit ON county_role_display (unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX county_role_display_county_listing ON county_role_display (county_fips, listing);

CREATE TRIGGER county_role_display_same_county_insert
BEFORE INSERT ON county_role_display
WHEN (NEW.unit_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM county_unit u WHERE u.id = NEW.unit_id AND u.county_fips = NEW.county_fips))
  OR EXISTS (
        SELECT 1 FROM person_roles r
        WHERE r.id = NEW.person_role_id AND r.county_fips IS NOT NULL
          AND r.county_fips <> NEW.county_fips)
BEGIN
  SELECT RAISE(ABORT, 'role display must stay within the role county');
END;

CREATE TRIGGER county_role_display_version_increment
BEFORE UPDATE ON county_role_display
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'county_role_display version must increment by one');
END;

-- Import batches. A prepared changeset stores the uploaded text, its checksum,
-- the structure version it was computed against and its deterministic items.
-- Nothing public changes until a prepared batch is committed.
CREATE TABLE county_structure_import (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  mode TEXT NOT NULL CHECK (mode IN ('merge', 'replace_county', 'replace_state', 'reversal')),
  county_fips TEXT REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64 AND file_sha256 NOT GLOB '*[^0-9a-f]*'),
  changeset_sha256 TEXT NOT NULL CHECK (
    length(changeset_sha256) = 64 AND changeset_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  csv_text TEXT NOT NULL CHECK (length(csv_text) <= 1048576),
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  after_version INTEGER CHECK (after_version IS NULL OR after_version >= base_version),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'blocked', 'reversed')),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json) AND length(summary_json) <= 1048576),
  reverses_import_id TEXT REFERENCES county_structure_import(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  reversed_by_import_id TEXT REFERENCES county_structure_import(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  commit_idempotency_key TEXT CHECK (
    commit_idempotency_key IS NULL OR length(commit_idempotency_key) BETWEEN 8 AND 128
  ),
  prepared_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  committed_by_account_id TEXT REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  committed_at TEXT,
  CHECK (
    (status = 'committed' AND after_version IS NOT NULL AND committed_at IS NOT NULL)
    OR status <> 'committed'
  )
) STRICT;

CREATE UNIQUE INDEX county_structure_import_commit_key
  ON county_structure_import (commit_idempotency_key) WHERE commit_idempotency_key IS NOT NULL;
CREATE INDEX county_structure_import_created ON county_structure_import (created_at DESC);

CREATE TABLE county_structure_import_item (
  import_id TEXT NOT NULL REFERENCES county_structure_import(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('unit', 'display_group')),
  entity_id TEXT NOT NULL,
  county_fips TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'update', 'move', 'retire', 'remove')),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  reason TEXT,
  profile_references INTEGER NOT NULL DEFAULT 0 CHECK (profile_references >= 0),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  PRIMARY KEY (import_id, seq)
) STRICT, WITHOUT ROWID;

-- Append-only record of every committed structural change, from imports, from
-- dashboard edits and from reversals. Before and after snapshots include the
-- unit's aliases and private provenance, so this table is private.
CREATE TABLE county_structure_history (
  id INTEGER PRIMARY KEY,
  import_id TEXT REFERENCES county_structure_import(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('import', 'dashboard', 'reversal')),
  structure_version INTEGER NOT NULL CHECK (structure_version > 0),
  county_fips TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('unit', 'display_group')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'update', 'move', 'retire', 'remove')),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX county_structure_history_entity ON county_structure_history (entity_id, id);
CREATE INDEX county_structure_history_county ON county_structure_history (county_fips, id);

CREATE TRIGGER county_structure_history_no_update
BEFORE UPDATE ON county_structure_history
BEGIN
  SELECT RAISE(ABORT, 'county structure history is append-only');
END;

CREATE TRIGGER county_structure_history_no_delete
BEFORE DELETE ON county_structure_history
BEGIN
  SELECT RAISE(ABORT, 'county structure history is append-only');
END;
