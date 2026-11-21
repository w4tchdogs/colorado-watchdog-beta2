-- Keep Profiles evidence in the private store. New Website roles can omit a source.
-- Preserve existing role IDs, versions, source links, and reviewed county display links.
-- Temporarily drop dependent objects so the table rebuild also works with D1 foreign keys enabled.

DROP TRIGGER person_roles_publication_delete;
DROP TRIGGER person_roles_publication_update;
DROP TRIGGER people_publication_display_name;
DROP TRIGGER positions_publication_update;
DROP TRIGGER organizations_publication_county;
DROP TRIGGER organization_affiliations_publication_delete;
DROP TRIGGER organization_affiliations_publication_update;
DROP TRIGGER person_visibility_publish_requires_ready_insert;
DROP TRIGGER person_visibility_publish_requires_ready_update;
DROP VIEW profile_publication_ready;

CREATE TABLE county_role_display_saved_0037 AS SELECT * FROM county_role_display;
DROP TABLE county_role_display;

CREATE TABLE person_roles_new (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position_id TEXT REFERENCES positions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_id TEXT REFERENCES role_sources(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  start_date TEXT,
  end_date TEXT,
  source_checked_at TEXT,
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
  source_checked_at, version, created_at, updated_at, county_fips,
  published_office, published_title, job_description
)
SELECT id, person_id, position_id, source_id, start_date, end_date,
       source_checked_at, version, created_at, updated_at, county_fips,
       published_office, published_title, job_description
FROM person_roles;

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

CREATE INDEX person_roles_person_id ON person_roles (person_id);

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

INSERT INTO county_role_display SELECT * FROM county_role_display_saved_0037;
DROP TABLE county_role_display_saved_0037;

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

CREATE VIEW profile_publication_ready AS
SELECT p.id AS person_id
FROM people p
WHERE length(trim(p.display_name)) > 0
  AND EXISTS (
    SELECT 1 FROM person_roles r
    LEFT JOIN positions ps ON ps.id = r.position_id
    LEFT JOIN organizations o ON o.id = ps.organization_id
    WHERE r.person_id = p.id
      AND (COALESCE(r.county_fips, o.county_fips) IS NOT NULL
           OR EXISTS (SELECT 1 FROM organization_county_affiliations a
                      WHERE a.organization_id = o.id))
      AND (r.position_id IS NOT NULL OR r.published_office IS NOT NULL
           OR r.published_title IS NOT NULL OR r.job_description IS NOT NULL)
  );

CREATE TRIGGER person_roles_publication_delete
AFTER DELETE ON person_roles
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE person_id = OLD.person_id AND visible = 1
    AND OLD.person_id NOT IN (SELECT person_id FROM profile_publication_ready);
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT OLD.person_id, 0, NULL, 'incomplete'
  WHERE EXISTS (SELECT 1 FROM people WHERE id = OLD.person_id)
    AND NOT EXISTS (SELECT 1 FROM person_visibility WHERE person_id = OLD.person_id)
    AND OLD.person_id NOT IN (SELECT person_id FROM profile_publication_ready);
END;

CREATE TRIGGER person_roles_publication_update
AFTER UPDATE OF person_id, position_id, county_fips, published_office,
  published_title, job_description ON person_roles
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE person_id IN (OLD.person_id, NEW.person_id) AND visible = 1
    AND person_id NOT IN (SELECT person_id FROM profile_publication_ready);
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT p.id, 0, NULL, 'incomplete'
  FROM people p
  WHERE p.id IN (OLD.person_id, NEW.person_id)
    AND NOT EXISTS (SELECT 1 FROM person_visibility v WHERE v.person_id = p.id)
    AND p.id NOT IN (SELECT person_id FROM profile_publication_ready);
END;

CREATE TRIGGER people_publication_display_name
AFTER UPDATE OF display_name ON people
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE person_id = NEW.id AND visible = 1
    AND NEW.id NOT IN (SELECT person_id FROM profile_publication_ready);
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT NEW.id, 0, NULL, 'incomplete'
  WHERE NOT EXISTS (SELECT 1 FROM person_visibility WHERE person_id = NEW.id)
    AND NEW.id NOT IN (SELECT person_id FROM profile_publication_ready);
END;

-- A role without its own county takes the county of its position's office.
CREATE TRIGGER positions_publication_update
AFTER UPDATE OF organization_id ON positions
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE visible = 1
    AND person_id IN (SELECT person_id FROM person_roles WHERE position_id = NEW.id)
    AND person_id NOT IN (SELECT person_id FROM profile_publication_ready);
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT DISTINCT r.person_id, 0, NULL, 'incomplete'
  FROM person_roles r
  WHERE r.position_id = NEW.id
    AND NOT EXISTS (SELECT 1 FROM person_visibility v WHERE v.person_id = r.person_id)
    AND r.person_id NOT IN (SELECT person_id FROM profile_publication_ready);
END;

CREATE TRIGGER organizations_publication_county
AFTER UPDATE OF county_fips ON organizations
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE visible = 1
    AND person_id IN (
      SELECT r.person_id FROM person_roles r JOIN positions ps ON ps.id = r.position_id
      WHERE ps.organization_id = NEW.id)
    AND person_id NOT IN (SELECT person_id FROM profile_publication_ready);
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT DISTINCT r.person_id, 0, NULL, 'incomplete'
  FROM person_roles r JOIN positions ps ON ps.id = r.position_id
  WHERE ps.organization_id = NEW.id
    AND NOT EXISTS (SELECT 1 FROM person_visibility v WHERE v.person_id = r.person_id)
    AND r.person_id NOT IN (SELECT person_id FROM profile_publication_ready);
END;

CREATE TRIGGER organization_affiliations_publication_delete
AFTER DELETE ON organization_county_affiliations
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE visible = 1
    AND person_id IN (
      SELECT r.person_id FROM person_roles r JOIN positions ps ON ps.id = r.position_id
      WHERE ps.organization_id = OLD.organization_id)
    AND person_id NOT IN (SELECT person_id FROM profile_publication_ready);
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT DISTINCT r.person_id, 0, NULL, 'incomplete'
  FROM person_roles r JOIN positions ps ON ps.id = r.position_id
  WHERE ps.organization_id = OLD.organization_id
    AND NOT EXISTS (SELECT 1 FROM person_visibility v WHERE v.person_id = r.person_id)
    AND r.person_id NOT IN (SELECT person_id FROM profile_publication_ready);
END;

CREATE TRIGGER organization_affiliations_publication_update
AFTER UPDATE OF organization_id ON organization_county_affiliations
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE visible = 1
    AND person_id IN (
      SELECT r.person_id FROM person_roles r JOIN positions ps ON ps.id = r.position_id
      WHERE ps.organization_id = OLD.organization_id)
    AND person_id NOT IN (SELECT person_id FROM profile_publication_ready);
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT DISTINCT r.person_id, 0, NULL, 'incomplete'
  FROM person_roles r JOIN positions ps ON ps.id = r.position_id
  WHERE ps.organization_id = OLD.organization_id
    AND NOT EXISTS (SELECT 1 FROM person_visibility v WHERE v.person_id = r.person_id)
    AND r.person_id NOT IN (SELECT person_id FROM profile_publication_ready);
END;

-- An owner or import write may not leave a visible row on an incomplete
-- Profile. This checks the final state of the row as written, so a combined
-- edit cannot publish an incomplete Profile.
CREATE TRIGGER person_visibility_publish_requires_ready_insert
BEFORE INSERT ON person_visibility
WHEN NEW.visible = 1
  AND NEW.person_id NOT IN (SELECT person_id FROM profile_publication_ready)
BEGIN
  SELECT RAISE(ABORT, 'profile_not_publishable');
END;

CREATE TRIGGER person_visibility_publish_requires_ready_update
BEFORE UPDATE OF visible ON person_visibility
WHEN NEW.visible = 1
  AND NEW.person_id NOT IN (SELECT person_id FROM profile_publication_ready)
BEGIN
  SELECT RAISE(ABORT, 'profile_not_publishable');
END;
