-- A workbook can edit thousands of existing roles and display names. Keep the
-- publication rule while checking only the affected Profiles for each row.
DROP TRIGGER person_roles_publication_update;
DROP TRIGGER people_publication_display_name;

CREATE TRIGGER person_roles_publication_update
AFTER UPDATE OF person_id, position_id, county_fips, published_office,
  published_title, job_description ON person_roles
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE person_id IN (OLD.person_id, NEW.person_id) AND visible = 1
    AND NOT EXISTS (
      SELECT 1 FROM profile_publication_ready WHERE person_id = person_visibility.person_id
    );
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT p.id, 0, NULL, 'incomplete'
  FROM people p
  WHERE p.id IN (OLD.person_id, NEW.person_id)
    AND NOT EXISTS (SELECT 1 FROM person_visibility v WHERE v.person_id = p.id)
    AND NOT EXISTS (
      SELECT 1 FROM profile_publication_ready WHERE person_id = p.id
    );
END;

CREATE TRIGGER people_publication_display_name
AFTER UPDATE OF display_name ON people
BEGIN
  UPDATE person_visibility
  SET visible = 0, version = version + 1, hidden_reason = 'incomplete',
      changed_by_account_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE person_id = NEW.id AND visible = 1
    AND NOT EXISTS (
      SELECT 1 FROM profile_publication_ready WHERE person_id = NEW.id
    );
  INSERT INTO person_visibility (person_id, visible, changed_by_account_id, hidden_reason)
  SELECT NEW.id, 0, NULL, 'incomplete'
  WHERE NOT EXISTS (SELECT 1 FROM person_visibility WHERE person_id = NEW.id)
    AND NOT EXISTS (
      SELECT 1 FROM profile_publication_ready WHERE person_id = NEW.id
    );
END;
