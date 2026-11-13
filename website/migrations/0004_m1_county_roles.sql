CREATE TABLE organizations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  organization_type TEXT NOT NULL CHECK (
    organization_type IN (
      'county_government',
      'office',
      'department',
      'division',
      'regional',
      'partner',
      'other'
    )
  ),
  county_fips TEXT REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  parent_organization_id TEXT REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  parent_relationship TEXT CHECK (
    parent_relationship IS NULL OR
    parent_relationship IN ('reports_to', 'grouped_under')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (parent_organization_id IS NULL OR parent_organization_id <> id),
  CHECK (organization_type <> 'county_government' OR county_fips IS NOT NULL),
  CHECK (
    (parent_organization_id IS NULL AND parent_relationship IS NULL)
    OR (parent_organization_id IS NOT NULL AND parent_relationship IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER organizations_parent_county_insert
BEFORE INSERT ON organizations
WHEN NEW.parent_organization_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM organizations AS parent
  WHERE parent.id = NEW.parent_organization_id
    AND parent.county_fips IS NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'organization hierarchy must remain within one county');
END;

CREATE TRIGGER organizations_parent_county_update
BEFORE UPDATE OF county_fips, parent_organization_id ON organizations
WHEN NEW.parent_organization_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM organizations AS parent
  WHERE parent.id = NEW.parent_organization_id
    AND parent.county_fips IS NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'organization hierarchy must remain within one county');
END;

CREATE TRIGGER organizations_parent_county_children_update
BEFORE UPDATE OF county_fips ON organizations
WHEN EXISTS (
  SELECT 1
  FROM organizations AS child
  WHERE child.parent_organization_id = OLD.id
    AND child.county_fips IS NOT NEW.county_fips
)
BEGIN
  SELECT RAISE(ABORT, 'organization update would split a county hierarchy');
END;

CREATE TRIGGER organizations_hierarchy_no_cycle
BEFORE UPDATE OF parent_organization_id ON organizations
WHEN NEW.parent_organization_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.parent_organization_id
    UNION ALL
    SELECT parent.parent_organization_id
    FROM organizations AS parent
    JOIN ancestors ON parent.id = ancestors.id
    WHERE parent.parent_organization_id IS NOT NULL
  )
  SELECT 1 FROM ancestors WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'organization hierarchy must not contain a cycle');
END;

CREATE TABLE organization_county_affiliations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL CHECK (
    relationship_type IN ('serves', 'partner_for', 'shared_service')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (organization_id, county_fips, relationship_type)
) STRICT;

CREATE TABLE people (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE positions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE role_sources (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  url TEXT NOT NULL UNIQUE CHECK (
    length(trim(url)) > 0 AND
    (
      substr(lower(url), 1, 7) = 'http://'
      OR substr(lower(url), 1, 8) = 'https://'
    )
  ),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('official_page', 'public_document', 'other_public')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE person_roles (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position_id TEXT NOT NULL REFERENCES positions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES role_sources(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  start_date TEXT,
  end_date TEXT,
  source_checked_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
) STRICT;

CREATE TRIGGER organizations_version_increment
BEFORE UPDATE ON organizations
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'organizations version must increment by one');
END;

CREATE TRIGGER organization_county_affiliations_version_increment
BEFORE UPDATE ON organization_county_affiliations
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'organization_county_affiliations version must increment by one');
END;

CREATE TRIGGER people_version_increment
BEFORE UPDATE ON people
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'people version must increment by one');
END;

CREATE TRIGGER positions_version_increment
BEFORE UPDATE ON positions
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'positions version must increment by one');
END;

CREATE TRIGGER role_sources_version_increment
BEFORE UPDATE ON role_sources
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'role_sources version must increment by one');
END;

CREATE TRIGGER person_roles_version_increment
BEFORE UPDATE ON person_roles
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'person_roles version must increment by one');
END;
