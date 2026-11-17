-- The migration runner holds a write lock throughout the check and renames.
CREATE TEMP TABLE profiles_rename_guard (
    empty_legacy_tables INTEGER CONSTRAINT profiles_legacy_tables_empty CHECK (empty_legacy_tables = 1),
    valid_foreign_keys INTEGER CONSTRAINT profiles_rename_foreign_keys CHECK (valid_foreign_keys = 1)
);
INSERT INTO profiles_rename_guard (empty_legacy_tables)
SELECT NOT EXISTS (SELECT 1 FROM site_links)
   AND NOT EXISTS (SELECT 1 FROM sync_batches)
   AND NOT EXISTS (SELECT 1 FROM sync_items);

DROP TABLE sync_items;
DROP TABLE sync_batches;
DROP TABLE site_links;

ALTER TABLE research_people RENAME TO profile_research;
ALTER TABLE role_claims RENAME TO profile_research_role;
ALTER TABLE name_variants RENAME TO profile_research_name;
ALTER TABLE possible_matches RENAME TO profile_research_duplicates;

ALTER TABLE org_units RENAME TO county_research_unit_structure;
ALTER TABLE org_names RENAME TO county_research_unit_names;
ALTER TABLE role_targets RENAME TO county_research_positions;
ALTER TABLE unit_coverage RENAME TO county_research_coverage;
ALTER TABLE source_unit_links RENAME TO county_research_unit_sources;

ALTER TABLE sources RENAME TO research_sources;
ALTER TABLE evidence_links RENAME TO research_evidence;
ALTER TABLE source_visits RENAME TO research_source_visits;
ALTER TABLE scrape_batches RENAME TO research_scrapes;
ALTER TABLE research_events RENAME TO research_history;
ALTER TABLE counties RENAME TO county;

ALTER TABLE site_entity_links RENAME TO website_ids;
ALTER TABLE site_entity_lineage RENAME TO website_id_evidence;
ALTER TABLE site_sync_update_approvals RENAME TO website_update_approvals;
ALTER TABLE sync_submissions RENAME TO website_requests;
ALTER TABLE sync_submission_items RENAME TO website_request_changes;
ALTER TABLE sync_submission_receipts RENAME TO website_request_receipts;
ALTER TABLE sync_item_receipts RENAME TO website_change_receipts;
ALTER TABLE sync_reversal_receipts RENAME TO website_reversal_receipts;

DROP VIEW selected_role_claims;
CREATE VIEW profile_research_role_selected AS
    SELECT c.* FROM profile_research_role c
    JOIN research_evidence e ON e."Evidence record ID" = c."Evidence record ID"
    JOIN research_scrapes b ON b.id = e."Import batch ID" WHERE b.selected = 1;

INSERT INTO profiles_rename_guard (valid_foreign_keys)
SELECT NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check);
DROP TABLE profiles_rename_guard;
