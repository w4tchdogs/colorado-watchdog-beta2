CREATE TABLE banner_assets (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_filename TEXT NOT NULL CHECK (length(trim(source_filename)) > 0),
  caption TEXT NOT NULL DEFAULT '',
  alt_text TEXT NOT NULL DEFAULT '',
  source_history_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_history_json) AND json_type(source_history_json) = 'array'),
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  display_mode TEXT NOT NULL DEFAULT 'cover' CHECK (display_mode IN ('cover', 'contain')),
  focal_x REAL NOT NULL DEFAULT 0.5 CHECK (focal_x >= 0 AND focal_x <= 1),
  focal_y REAL NOT NULL DEFAULT 0.5 CHECK (focal_y >= 0 AND focal_y <= 1),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'withdrawn')),
  selected_version_id TEXT REFERENCES banner_asset_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (county_fips, display_order),
  CHECK (status <> 'active' OR selected_version_id IS NOT NULL)
) STRICT;

CREATE TABLE banner_asset_versions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  banner_id TEXT NOT NULL REFERENCES banner_assets(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  previous_version_id TEXT REFERENCES banner_asset_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  source_filename TEXT NOT NULL CHECK (length(trim(source_filename)) > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  source_version_number INTEGER CHECK (source_version_number IS NULL OR source_version_number > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  aspect_ratio REAL NOT NULL CHECK (aspect_ratio > 0),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png')),
  object_key TEXT NOT NULL UNIQUE CHECK (length(trim(object_key)) > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'staging', 'staged', 'verified', 'failed', 'superseded')),
  verification_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(verification_json)),
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (banner_id, sha256),
  CHECK ((state = 'verified' AND verified_at IS NOT NULL) OR state <> 'verified')
) STRICT;

CREATE TABLE banner_stage_operations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  banner_id TEXT NOT NULL REFERENCES banner_assets(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version_id TEXT NOT NULL REFERENCES banner_asset_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'staging', 'staged', 'verified', 'failed', 'interrupted', 'superseded', 'activated')),
  error_code TEXT,
  created_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX banner_assets_county_order ON banner_assets(county_fips, display_order, id);
CREATE UNIQUE INDEX banner_assets_one_primary_per_county
  ON banner_assets(county_fips) WHERE is_primary = 1;
CREATE INDEX banner_versions_banner ON banner_asset_versions(banner_id, created_at, id);
CREATE INDEX banner_stage_state ON banner_stage_operations(state, updated_at);

CREATE TRIGGER banner_assets_version_increment
BEFORE UPDATE ON banner_assets WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'banner asset version must increment by one'); END;

CREATE TRIGGER banner_assets_selected_version_valid
BEFORE UPDATE OF selected_version_id, status ON banner_assets
WHEN NEW.selected_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM banner_asset_versions v
  WHERE v.id = NEW.selected_version_id AND v.banner_id = NEW.id AND v.state = 'verified'
)
BEGIN SELECT RAISE(ABORT, 'selected banner version must be verified and belong to the banner'); END;

CREATE TRIGGER banner_versions_immutable
BEFORE UPDATE ON banner_asset_versions
WHEN NEW.id <> OLD.id OR NEW.banner_id <> OLD.banner_id OR NEW.previous_version_id IS NOT OLD.previous_version_id
 OR NEW.source_filename <> OLD.source_filename OR NEW.sha256 <> OLD.sha256 OR NEW.width <> OLD.width
 OR NEW.height <> OLD.height OR NEW.aspect_ratio <> OLD.aspect_ratio OR NEW.byte_size <> OLD.byte_size
 OR NEW.media_type <> OLD.media_type OR NEW.object_key <> OLD.object_key OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'banner image version identity is immutable'); END;

CREATE TRIGGER banner_versions_no_delete BEFORE DELETE ON banner_asset_versions
BEGIN SELECT RAISE(ABORT, 'banner image versions are retained'); END;

CREATE TRIGGER banner_assets_no_delete BEFORE DELETE ON banner_assets
BEGIN SELECT RAISE(ABORT, 'banner identities are retained; withdraw instead'); END;

CREATE TRIGGER banner_versions_state_transition
BEFORE UPDATE OF state ON banner_asset_versions
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'pending' AND NEW.state IN ('staging', 'failed')) OR
  (OLD.state = 'staging' AND NEW.state IN ('staged', 'verified', 'failed')) OR
  (OLD.state = 'staged' AND NEW.state IN ('verified', 'failed')) OR
  (OLD.state = 'failed' AND NEW.state IN ('staging', 'pending')) OR
  (OLD.state = 'verified' AND NEW.state = 'superseded') OR
  (OLD.state = 'superseded' AND NEW.state = 'verified')
)
BEGIN SELECT RAISE(ABORT, 'invalid banner version state transition'); END;

CREATE TRIGGER banner_stage_no_delete BEFORE DELETE ON banner_stage_operations
BEGIN SELECT RAISE(ABORT, 'banner stage history is retained'); END;

CREATE TRIGGER banner_stage_state_transition
BEFORE UPDATE OF state ON banner_stage_operations
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'pending' AND NEW.state IN ('staging', 'failed', 'interrupted')) OR
  (OLD.state = 'staging' AND NEW.state IN ('staged', 'verified', 'failed', 'interrupted')) OR
  (OLD.state = 'staged' AND NEW.state IN ('verified', 'failed', 'interrupted', 'superseded')) OR
  (OLD.state = 'verified' AND NEW.state IN ('activated', 'superseded')) OR
  (OLD.state = 'failed' AND NEW.state IN ('staging', 'ready_for_retry')) OR
  (OLD.state = 'interrupted' AND NEW.state IN ('staging', 'ready_for_retry')) OR
  (OLD.state = 'ready_for_retry' AND NEW.state IN ('staging', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'invalid banner stage state transition'); END;

CREATE TRIGGER banner_stage_version_increment
BEFORE UPDATE ON banner_stage_operations WHEN NEW.state = OLD.state AND NEW.updated_at = OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'stage operation updates must advance updated_at'); END;

CREATE TRIGGER website_dependency_banner_assets_insert AFTER INSERT ON banner_assets BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_assets_update AFTER UPDATE ON banner_assets BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_assets_delete AFTER DELETE ON banner_assets BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_asset_versions_insert AFTER INSERT ON banner_asset_versions BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_asset_versions_update AFTER UPDATE ON banner_asset_versions BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_asset_versions_delete AFTER DELETE ON banner_asset_versions BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_stage_operations_insert AFTER INSERT ON banner_stage_operations BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_stage_operations_update AFTER UPDATE ON banner_stage_operations BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
CREATE TRIGGER website_dependency_banner_stage_operations_delete AFTER DELETE ON banner_stage_operations BEGIN UPDATE website_dependency_generation SET generation = generation + 1 WHERE id = 1; END;
