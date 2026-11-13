CREATE TABLE content_revisions (
  content_id TEXT NOT NULL REFERENCES content_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  change_kind TEXT NOT NULL CHECK (
    change_kind IN (
      'baseline', 'create', 'update', 'relationships',
      'archive', 'restore_draft', 'restore_revision'
    )
  ),
  title TEXT NOT NULL CHECK (
    length(trim(title)) > 0 AND length(title) <= 200
  ),
  summary TEXT CHECK (
    summary IS NULL OR (length(trim(summary)) > 0 AND length(summary) <= 500)
  ),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 200000),
  status TEXT NOT NULL CHECK (status IN ('draft', 'archived')),
  county_fips_json TEXT NOT NULL CHECK (
    json_valid(county_fips_json) AND json_type(county_fips_json) = 'array'
    AND length(county_fips_json) <= 1024
  ),
  person_ids_json TEXT NOT NULL CHECK (
    json_valid(person_ids_json) AND json_type(person_ids_json) = 'array'
    AND length(person_ids_json) <= 8192
  ),
  organization_ids_json TEXT NOT NULL CHECK (
    json_valid(organization_ids_json) AND json_type(organization_ids_json) = 'array'
    AND length(organization_ids_json) <= 8192
  ),
  edited_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  restored_from_version INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (content_id, version),
  CHECK (
    (change_kind = 'restore_revision' AND restored_from_version IS NOT NULL
      AND restored_from_version > 0 AND restored_from_version < version)
    OR (change_kind <> 'restore_revision' AND restored_from_version IS NULL)
  )
) STRICT;

CREATE INDEX content_revisions_editor ON content_revisions(edited_by_account_id, recorded_at);

-- Existing items keep their current state as the earliest available snapshot.
-- Earlier versions that were never captured are not fabricated.
INSERT INTO content_revisions (
  content_id, version, change_kind, title, summary, body, status,
  county_fips_json, person_ids_json, organization_ids_json,
  edited_by_account_id, recorded_at
)
SELECT
  item.id, item.version, 'baseline', item.title, item.summary, item.body, item.status,
  COALESCE((SELECT json_group_array(county_fips) FROM (
    SELECT county_fips FROM content_item_counties
    WHERE content_id = item.id ORDER BY county_fips COLLATE BINARY
  )), '[]'),
  COALESCE((SELECT json_group_array(person_id) FROM (
    SELECT person_id FROM content_item_people
    WHERE content_id = item.id ORDER BY person_id COLLATE BINARY
  )), '[]'),
  COALESCE((SELECT json_group_array(organization_id) FROM (
    SELECT organization_id FROM content_item_organizations
    WHERE content_id = item.id ORDER BY organization_id COLLATE BINARY
  )), '[]'),
  item.last_edited_by_account_id, item.updated_at
FROM content_items AS item;

CREATE TRIGGER content_revisions_no_update
BEFORE UPDATE ON content_revisions
BEGIN
  SELECT RAISE(ABORT, 'content_revisions are append-only');
END;

CREATE TRIGGER content_revisions_no_delete
BEFORE DELETE ON content_revisions
BEGIN
  SELECT RAISE(ABORT, 'content_revisions are append-only');
END;

CREATE TRIGGER content_revisions_match_current
BEFORE INSERT ON content_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM content_items
  WHERE id = NEW.content_id AND version = NEW.version
)
BEGIN
  SELECT RAISE(ABORT, 'content revision must record the current content version');
END;
