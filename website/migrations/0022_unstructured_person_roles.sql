-- Allow a county role to rest on documented text alone (office, position title
-- or job description) while keeping structured position links optional.
-- Existing role rows, IDs, versions, timestamps and citations are preserved.
-- Existing county values are backfilled only from the linked organization's own county.
CREATE TABLE person_roles_new (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position_id TEXT REFERENCES positions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES role_sources(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  start_date TEXT,
  end_date TEXT,
  source_checked_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  county_fips TEXT REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  published_office TEXT CHECK (
    published_office IS NULL OR length(trim(published_office)) BETWEEN 1 AND 500
  ),
  published_title TEXT CHECK (
    published_title IS NULL OR length(trim(published_title)) BETWEEN 1 AND 500
  ),
  job_description TEXT CHECK (
    job_description IS NULL OR length(trim(job_description)) BETWEEN 1 AND 2000
  ),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date),
  CHECK (
    position_id IS NOT NULL OR published_office IS NOT NULL
    OR published_title IS NOT NULL OR job_description IS NOT NULL
  ),
  CHECK (position_id IS NOT NULL OR county_fips IS NOT NULL)
) STRICT;

INSERT INTO person_roles_new (
  id, person_id, position_id, source_id, start_date, end_date,
  source_checked_at, version, created_at, updated_at, county_fips
)
SELECT
  r.id, r.person_id, r.position_id, r.source_id, r.start_date, r.end_date,
  r.source_checked_at, r.version, r.created_at, r.updated_at,
  (SELECT o.county_fips FROM positions p
     JOIN organizations o ON o.id = p.organization_id
    WHERE p.id = r.position_id)
FROM person_roles r;

DROP TABLE person_roles;
ALTER TABLE person_roles_new RENAME TO person_roles;

CREATE INDEX person_roles_county_fips ON person_roles (county_fips)
  WHERE county_fips IS NOT NULL;

CREATE TRIGGER person_roles_version_increment
BEFORE UPDATE ON person_roles
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'person_roles version must increment by one');
END;

CREATE TRIGGER website_dependency_person_roles_insert
AFTER INSERT ON person_roles
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_person_roles_update
AFTER UPDATE ON person_roles
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_person_roles_delete
AFTER DELETE ON person_roles
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;
