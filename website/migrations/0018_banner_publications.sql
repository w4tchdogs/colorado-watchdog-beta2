-- Banner publication history (BANNER-ADMIN-2).
-- Each row records the image version and the display metadata that went public
-- together, so a restore can bring back both. A version published more than
-- once keeps one row per publication. Rows are append-only. Image versions in
-- banner_asset_versions stay immutable.
CREATE TABLE banner_publications (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  banner_id TEXT NOT NULL REFERENCES banner_assets(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES banner_asset_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  origin TEXT NOT NULL CHECK (origin IN ('publish', 'restore_recorded', 'restore_explicit', 'metadata_edit')),
  restored_from_publication_id TEXT REFERENCES banner_publications(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  caption TEXT NOT NULL CHECK (length(caption) <= 500),
  alt_text TEXT NOT NULL CHECK (length(trim(alt_text)) > 0 AND length(alt_text) <= 1000),
  display_mode TEXT NOT NULL CHECK (display_mode IN ('cover', 'contain')),
  focal_x REAL NOT NULL CHECK (focal_x >= 0 AND focal_x <= 1),
  focal_y REAL NOT NULL CHECK (focal_y >= 0 AND focal_y <= 1),
  banner_row_version INTEGER NOT NULL CHECK (banner_row_version > 0),
  published_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (banner_id, sequence)
) STRICT;

CREATE INDEX banner_publications_version ON banner_publications(version_id, sequence);

-- Idempotency ledger for banner administration changes other than staging.
CREATE TABLE banner_admin_operations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK (action IN ('publish', 'withdraw', 'restore', 'update_metadata', 'reorder')),
  target_type TEXT NOT NULL CHECK (target_type IN ('banner', 'county')),
  target_id TEXT NOT NULL CHECK (length(trim(target_id)) > 0),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TRIGGER banner_publications_immutable BEFORE UPDATE ON banner_publications
BEGIN SELECT RAISE(ABORT, 'banner publication history is append-only'); END;
CREATE TRIGGER banner_publications_no_delete BEFORE DELETE ON banner_publications
BEGIN SELECT RAISE(ABORT, 'banner publication history is retained'); END;
CREATE TRIGGER banner_publications_belongs BEFORE INSERT ON banner_publications
WHEN NOT EXISTS (
  SELECT 1 FROM banner_asset_versions v
  WHERE v.id = NEW.version_id AND v.banner_id = NEW.banner_id AND v.state = 'verified'
)
BEGIN SELECT RAISE(ABORT, 'a publication needs a verified version of the same banner'); END;
CREATE TRIGGER banner_publications_sequence BEFORE INSERT ON banner_publications
WHEN NEW.sequence <> COALESCE((SELECT MAX(sequence) FROM banner_publications WHERE banner_id = NEW.banner_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'banner publication sequence must advance by one'); END;

CREATE TRIGGER banner_admin_operations_immutable BEFORE UPDATE ON banner_admin_operations
BEGIN SELECT RAISE(ABORT, 'banner administration history is append-only'); END;
CREATE TRIGGER banner_admin_operations_no_delete BEFORE DELETE ON banner_admin_operations
BEGIN SELECT RAISE(ABORT, 'banner administration history is retained'); END;

CREATE TRIGGER website_dependency_banner_publications_insert AFTER INSERT ON banner_publications BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_publications_update AFTER UPDATE ON banner_publications BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_publications_delete AFTER DELETE ON banner_publications BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_admin_operations_insert AFTER INSERT ON banner_admin_operations BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_admin_operations_update AFTER UPDATE ON banner_admin_operations BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_admin_operations_delete AFTER DELETE ON banner_admin_operations BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
