-- The working draft and its public revision have independent versions.
CREATE TABLE content_publications (
  content_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL CHECK (content_type IN ('post', 'story')),
  slug TEXT NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 120 AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '-%' AND slug NOT LIKE '%-' AND slug NOT LIKE '%--%'
  ),
  revision_version INTEGER NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  published_at TEXT NOT NULL,
  published_by_account_id TEXT NOT NULL REFERENCES accounts(id),
  withdrawn_at TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 60000),
  FOREIGN KEY (content_id, revision_version) REFERENCES content_revisions(content_id, version),
  UNIQUE (content_type, slug)
) STRICT;

CREATE INDEX content_publications_live_type
  ON content_publications(content_type, published_at DESC, slug)
  WHERE withdrawn_at IS NULL;

CREATE TRIGGER content_items_withdraw_before_archive
BEFORE UPDATE OF status ON content_items
WHEN NEW.status = 'archived' AND EXISTS (
  SELECT 1 FROM content_publications WHERE content_id = NEW.id AND withdrawn_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'Withdraw published content before archiving');
END;

-- Publication writes participate in the Website mutation dependency fence.
CREATE TRIGGER website_dependency_content_publications_insert
AFTER INSERT ON content_publications
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_publications_update
AFTER UPDATE ON content_publications
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;

CREATE TRIGGER website_dependency_content_publications_delete
AFTER DELETE ON content_publications
BEGIN
  UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1;
END;
