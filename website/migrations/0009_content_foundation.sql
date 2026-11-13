CREATE TABLE content_items (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  content_type TEXT NOT NULL CHECK (content_type IN ('post', 'story')),
  title TEXT NOT NULL CHECK (
    length(trim(title)) > 0 AND length(title) <= 200
  ),
  summary TEXT CHECK (
    summary IS NULL OR (length(trim(summary)) > 0 AND length(summary) <= 500)
  ),
  body TEXT NOT NULL DEFAULT '' CHECK (length(CAST(body AS BLOB)) <= 200000),
  body_format TEXT NOT NULL DEFAULT 'markdown' CHECK (body_format = 'markdown'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'archived')),
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  last_edited_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (status = 'archived' AND archived_at IS NOT NULL)
    OR (status = 'draft' AND archived_at IS NULL)
  )
) STRICT;

CREATE INDEX content_items_status_id ON content_items(status, id);
CREATE INDEX content_items_type_id ON content_items(content_type, id);

CREATE TABLE content_item_counties (
  content_id TEXT NOT NULL REFERENCES content_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY (content_id, county_fips)
) STRICT;

CREATE INDEX content_item_counties_county ON content_item_counties(county_fips, content_id);

CREATE TABLE content_item_people (
  content_id TEXT NOT NULL REFERENCES content_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY (content_id, person_id)
) STRICT;

CREATE INDEX content_item_people_person ON content_item_people(person_id, content_id);

CREATE TABLE content_item_organizations (
  content_id TEXT NOT NULL REFERENCES content_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  PRIMARY KEY (content_id, organization_id)
) STRICT;

CREATE INDEX content_item_organizations_organization
  ON content_item_organizations(organization_id, content_id);

CREATE TRIGGER content_items_version_increment
BEFORE UPDATE ON content_items
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'content_items version must increment by one');
END;

CREATE TRIGGER content_items_immutable_origin
BEFORE UPDATE OF id, content_type, created_by_account_id, created_at ON content_items
WHEN NEW.id IS NOT OLD.id
  OR NEW.content_type IS NOT OLD.content_type
  OR NEW.created_by_account_id IS NOT OLD.created_by_account_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'content_items identity, type, author and creation time are immutable');
END;
