-- A visibility write checks the affected Profile by ID. The prior uncorrelated
-- NOT IN query scanned all publication-ready Profiles for each row written.
DROP TRIGGER person_visibility_publish_requires_ready_insert;
DROP TRIGGER person_visibility_publish_requires_ready_update;

CREATE TRIGGER person_visibility_publish_requires_ready_insert
BEFORE INSERT ON person_visibility
WHEN NEW.visible = 1
  AND NOT EXISTS (
    SELECT 1 FROM profile_publication_ready WHERE person_id = NEW.person_id
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_not_publishable');
END;

CREATE TRIGGER person_visibility_publish_requires_ready_update
BEFORE UPDATE OF visible ON person_visibility
WHEN NEW.visible = 1
  AND NOT EXISTS (
    SELECT 1 FROM profile_publication_ready WHERE person_id = NEW.person_id
  )
BEGIN
  SELECT RAISE(ABORT, 'profile_not_publishable');
END;
