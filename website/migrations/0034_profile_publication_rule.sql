-- Profile publication rule (PROFILES-PUBLISH-1).
--
-- A Profile may be public only when it has a nonblank display name and at
-- least one role with a county, a source and an office, position or duties.
-- The county is the role's own county, its office's county, or a county the
-- office is affiliated with, as the public county pages already read it.
-- Text-only roles qualify. A County Structure attachment and an alternate name
-- are optional. `profile_publication_ready` is the one definition of the rule:
-- the public visibility predicate, the owner Profiles sheet and the triggers
-- below all read it.
--
-- person_visibility gains `hidden_reason`. `incomplete` marks a Profile the
-- Website hid because it stopped meeting the rule. NULL is an owner or import
-- decision. An automatic hide has no human actor, so `changed_by_account_id`
-- becomes nullable. No table references person_visibility, so it is rebuilt
-- in place with every row, version and timestamp preserved.
--
-- Existing Profiles that do not meet the rule and were treated as visible are
-- hidden with reason `incomplete`. Restoring the missing information never
-- republishes a Profile: the owner publishes it explicitly.

CREATE VIEW profile_publication_ready AS
SELECT p.id AS person_id
FROM people p
WHERE length(trim(p.display_name)) > 0
  AND EXISTS (
    SELECT 1 FROM person_roles r
    LEFT JOIN positions ps ON ps.id = r.position_id
    LEFT JOIN organizations o ON o.id = ps.organization_id
    WHERE r.person_id = p.id
      AND r.source_id IS NOT NULL
      AND (COALESCE(r.county_fips, o.county_fips) IS NOT NULL
           OR EXISTS (SELECT 1 FROM organization_county_affiliations a
                      WHERE a.organization_id = o.id))
      AND (r.position_id IS NOT NULL OR r.published_office IS NOT NULL
           OR r.published_title IS NOT NULL OR r.job_description IS NOT NULL)
  );

CREATE TABLE person_visibility_0034 (
  person_id TEXT PRIMARY KEY REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  changed_by_account_id TEXT REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  hidden_reason TEXT CHECK (hidden_reason IS NULL OR hidden_reason = 'incomplete'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (hidden_reason IS NULL OR visible = 0),
  CHECK (changed_by_account_id IS NOT NULL OR hidden_reason IS NOT NULL)
) STRICT;

INSERT INTO person_visibility_0034
  (person_id, visible, version, changed_by_account_id, hidden_reason, created_at, updated_at)
SELECT person_id, visible, version, changed_by_account_id, NULL, created_at, updated_at
FROM person_visibility;

DROP TABLE person_visibility;
ALTER TABLE person_visibility_0034 RENAME TO person_visibility;

CREATE INDEX person_visibility_hidden ON person_visibility (person_id)
  WHERE visible = 0;

CREATE TRIGGER person_visibility_version_increment
BEFORE UPDATE ON person_visibility
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'person_visibility version must increment by one');
END;

-- Backfill: hide every incomplete Profile that was public.
UPDATE person_visibility
SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
    changed_by_account_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE visible = 1
  AND person_id NOT IN (SELECT person_id FROM profile_publication_ready);

INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
SELECT p.id, 0, NULL, 'incomplete'
FROM people p
WHERE NOT EXISTS (SELECT 1 FROM person_visibility v WHERE v.person_id = p.id)
  AND p.id NOT IN (SELECT person_id FROM profile_publication_ready);

-- Automatic hiding. Each trigger hides the affected Profile when it is public
-- (a visible row, or no row) and no longer meets the rule. A Profile that is
-- already hidden keeps its row and reason unchanged.

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
AFTER UPDATE OF person_id, position_id, source_id, county_fips, published_office,
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
