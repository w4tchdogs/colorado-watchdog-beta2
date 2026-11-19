-- Profile names (PROFILES-NAMES-1).
--
-- Separates a Profile's primary name into components and adds unlimited,
-- typed alternate names. It extends the canonical `people`
-- table and creates no second people database. Nothing is dropped or
-- rewritten: `people.display_name` stays the approved public name, every
-- existing row keeps working with display-name-only data, and the person ID,
-- `person_visibility`, role rows and write receipts are untouched.
--
-- Migration number: 0032, the next number after 0031_county_structure.sql.
-- The two files share no table.
--
-- Private research evidence stays in the private Profiles store. This
-- migration holds no evidence file, claim ID, research evidence-link ID or
-- review note, and no original research name snapshot. Alternate names carry
-- only the public-facing name data and the owner's review and visibility state.

-- Primary name components. All are optional and stay blank when unknown. The
-- Website never splits `display_name` to fill them.
ALTER TABLE people ADD COLUMN first_name TEXT CHECK (
  first_name IS NULL OR length(trim(first_name)) BETWEEN 1 AND 200
);
ALTER TABLE people ADD COLUMN middle_name TEXT CHECK (
  middle_name IS NULL OR length(trim(middle_name)) BETWEEN 1 AND 200
);
ALTER TABLE people ADD COLUMN last_name TEXT CHECK (
  last_name IS NULL OR length(trim(last_name)) BETWEEN 1 AND 200
);
ALTER TABLE people ADD COLUMN name_prefix TEXT CHECK (
  name_prefix IS NULL OR length(trim(name_prefix)) BETWEEN 1 AND 50
);
ALTER TABLE people ADD COLUMN name_suffix TEXT CHECK (
  name_suffix IS NULL OR length(trim(name_suffix)) BETWEEN 1 AND 50
);
ALTER TABLE people ADD COLUMN preferred_first_name TEXT CHECK (
  preferred_first_name IS NULL OR length(trim(preferred_first_name)) BETWEEN 1 AND 200
);

-- Raw legacy full-name text, kept privately for compatibility and historical
-- traceability. It lives beside `people` rather than on it because every
-- UPDATE of `people` must advance `people.version`, and recording legacy text
-- must not advance a version a reviewed sync expects. No public query reads
-- this table. Every existing Profile gets one row holding its current
-- display name as the legacy full name, and `people` itself is not touched.
CREATE TABLE profile_legacy_names (
  person_id TEXT PRIMARY KEY REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  legacy_full_name TEXT NOT NULL CHECK (length(trim(legacy_full_name)) BETWEEN 1 AND 1000),
  origin TEXT NOT NULL CHECK (origin IN ('website_display_name')),
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO profile_legacy_names (person_id, legacy_full_name, origin)
SELECT id, display_name, 'website_display_name' FROM people;

-- One row per alternate name. Unlimited per Profile (a one-to-many
-- relationship, never numbered columns). The Website generates `id`. A name
-- is private and unreviewed until an owner action changes it. A removal is a
-- reversible soft removal (`removed_at`), so no row is ever deleted.
CREATE TABLE profile_names (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND id GLOB '[A-Za-z0-9]*'
  ),
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  name_type TEXT NOT NULL CHECK (
    name_type IN (
      'nickname', 'preferred', 'middle_name_used', 'birth_surname',
      'married_surname', 'former_surname', 'legal_name_change',
      'professional_name', 'initials', 'historical_published',
      'spelling_variant', 'transliteration', 'other'
    )
  ),
  first_name TEXT CHECK (first_name IS NULL OR length(trim(first_name)) BETWEEN 1 AND 200),
  middle_name TEXT CHECK (middle_name IS NULL OR length(trim(middle_name)) BETWEEN 1 AND 200),
  last_name TEXT CHECK (last_name IS NULL OR length(trim(last_name)) BETWEEN 1 AND 200),
  name_prefix TEXT CHECK (name_prefix IS NULL OR length(trim(name_prefix)) BETWEEN 1 AND 50),
  name_suffix TEXT CHECK (name_suffix IS NULL OR length(trim(name_suffix)) BETWEEN 1 AND 50),
  published_name TEXT NOT NULL CHECK (length(trim(published_name)) BETWEEN 1 AND 500),
  applies_from TEXT CHECK (
    applies_from IS NULL OR applies_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  applies_until TEXT CHECK (
    applies_until IS NULL OR applies_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  verification_status TEXT NOT NULL DEFAULT 'requires_review' CHECK (
    verification_status IN ('requires_review', 'confirmed')
  ),
  public_display INTEGER NOT NULL DEFAULT 0 CHECK (public_display IN (0, 1)),
  removed_at TEXT,
  removed_by_account_id TEXT REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_account_id TEXT REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (applies_from IS NULL OR applies_until IS NULL OR applies_until >= applies_from),
  -- A name can be public only when it is confirmed and not removed. This
  -- holds for every writer, so no import or tool can publish an unreviewed
  -- or removed name.
  CHECK (public_display = 0 OR (verification_status = 'confirmed' AND removed_at IS NULL)),
  CHECK ((removed_at IS NULL) = (removed_by_account_id IS NULL))
) STRICT;

CREATE INDEX profile_names_person ON profile_names (person_id);
CREATE INDEX profile_names_public ON profile_names (person_id)
  WHERE public_display = 1 AND verification_status = 'confirmed' AND removed_at IS NULL;

-- Duplicate prevention: the same published name, type and dates cannot be
-- recorded twice for one active Profile association.
CREATE UNIQUE INDEX profile_names_unique_active ON profile_names (
  person_id, name_type, lower(published_name),
  COALESCE(applies_from, ''), COALESCE(applies_until, '')
) WHERE removed_at IS NULL;

CREATE TRIGGER profile_names_version_increment
BEFORE UPDATE ON profile_names
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'profile_names version must increment by one');
END;

CREATE TRIGGER profile_names_person_immutable
BEFORE UPDATE OF person_id ON profile_names
WHEN NEW.person_id <> OLD.person_id
BEGIN
  SELECT RAISE(ABORT, 'profile_names person_id cannot change');
END;

-- Append-only change receipts for primary and alternate names. Each row keeps
-- the before and after values, so any edit or removal can be inspected and
-- reversed by an owner action. Rows are written in the same atomic batch as
-- the change they describe.
CREATE TABLE profile_name_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  profile_name_id TEXT REFERENCES profile_names(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
