CREATE TABLE website_dependency_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0)
 ) STRICT;

INSERT INTO website_dependency_generation (id, generation) VALUES (1, 0);

CREATE TABLE website_dependency_assertions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  valid INTEGER NOT NULL CHECK (valid = 1)
 ) STRICT;

CREATE TABLE website_write_assertions (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;

CREATE TRIGGER website_dependency_accounts_insert
AFTER INSERT ON accounts
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_accounts_update
AFTER UPDATE ON accounts
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_accounts_delete
AFTER DELETE ON accounts
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_identities_insert
AFTER INSERT ON identities
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_identities_update
AFTER UPDATE ON identities
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_identities_delete
AFTER DELETE ON identities
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_operations_insert
AFTER INSERT ON operations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_operations_update
AFTER UPDATE ON operations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_operations_delete
AFTER DELETE ON operations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_audit_events_insert
AFTER INSERT ON audit_events
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_audit_events_update
AFTER UPDATE ON audit_events
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_audit_events_delete
AFTER DELETE ON audit_events
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_checkpoints_insert
AFTER INSERT ON checkpoints
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_checkpoints_update
AFTER UPDATE ON checkpoints
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_checkpoints_delete
AFTER DELETE ON checkpoints
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_counties_insert
AFTER INSERT ON counties
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_counties_update
AFTER UPDATE ON counties
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_counties_delete
AFTER DELETE ON counties
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_organizations_insert
AFTER INSERT ON organizations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_organizations_update
AFTER UPDATE ON organizations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_organizations_delete
AFTER DELETE ON organizations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_organization_county_affiliations_insert
AFTER INSERT ON organization_county_affiliations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_organization_county_affiliations_update
AFTER UPDATE ON organization_county_affiliations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_organization_county_affiliations_delete
AFTER DELETE ON organization_county_affiliations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_people_insert
AFTER INSERT ON people
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_people_update
AFTER UPDATE ON people
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_people_delete
AFTER DELETE ON people
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_positions_insert
AFTER INSERT ON positions
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_positions_update
AFTER UPDATE ON positions
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_positions_delete
AFTER DELETE ON positions
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_role_sources_insert
AFTER INSERT ON role_sources
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_role_sources_update
AFTER UPDATE ON role_sources
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_role_sources_delete
AFTER DELETE ON role_sources
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
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

CREATE TRIGGER website_dependency_sync_batches_insert
AFTER INSERT ON sync_batches
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_sync_batches_update
AFTER UPDATE ON sync_batches
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_sync_batches_delete
AFTER DELETE ON sync_batches
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_sync_batch_items_insert
AFTER INSERT ON sync_batch_items
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_sync_batch_items_update
AFTER UPDATE ON sync_batch_items
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_sync_batch_items_delete
AFTER DELETE ON sync_batch_items
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_sync_batch_reversals_insert
AFTER INSERT ON sync_batch_reversals
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_sync_batch_reversals_update
AFTER UPDATE ON sync_batch_reversals
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_sync_batch_reversals_delete
AFTER DELETE ON sync_batch_reversals
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_person_duplicate_flags_insert
AFTER INSERT ON person_duplicate_flags
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_person_duplicate_flags_update
AFTER UPDATE ON person_duplicate_flags
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_person_duplicate_flags_delete
AFTER DELETE ON person_duplicate_flags
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_person_duplicate_flag_observations_insert
AFTER INSERT ON person_duplicate_flag_observations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_person_duplicate_flag_observations_update
AFTER UPDATE ON person_duplicate_flag_observations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_person_duplicate_flag_observations_delete
AFTER DELETE ON person_duplicate_flag_observations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_items_insert
AFTER INSERT ON content_items
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_items_update
AFTER UPDATE ON content_items
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_items_delete
AFTER DELETE ON content_items
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_counties_insert
AFTER INSERT ON content_item_counties
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_counties_update
AFTER UPDATE ON content_item_counties
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_counties_delete
AFTER DELETE ON content_item_counties
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_people_insert
AFTER INSERT ON content_item_people
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_people_update
AFTER UPDATE ON content_item_people
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_people_delete
AFTER DELETE ON content_item_people
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_organizations_insert
AFTER INSERT ON content_item_organizations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_organizations_update
AFTER UPDATE ON content_item_organizations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_item_organizations_delete
AFTER DELETE ON content_item_organizations
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_revisions_insert
AFTER INSERT ON content_revisions
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_revisions_update
AFTER UPDATE ON content_revisions
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_revisions_delete
AFTER DELETE ON content_revisions
BEGIN
  UPDATE website_dependency_generation
  SET generation = generation + 1
  WHERE id = 1;
END;
