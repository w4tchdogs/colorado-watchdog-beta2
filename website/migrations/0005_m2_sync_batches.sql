CREATE TABLE sync_batches (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  contract_version TEXT NOT NULL CHECK (contract_version = 'm2-sync/v1'),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status = 'committed'),
  committed_at TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 65536),
  UNIQUE (actor_account_id, idempotency_key)
) STRICT;

CREATE TABLE sync_batch_items (
  batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  client_ref TEXT NOT NULL CHECK (length(client_ref) BETWEEN 1 AND 128),
  entity TEXT NOT NULL CHECK (entity IN (
    'organizations', 'organization_county_affiliations', 'people',
    'positions', 'role_sources', 'person_roles'
  )),
  operation TEXT NOT NULL CHECK (operation IN (
    'create_organization', 'add_county_affiliation', 'create_person',
    'create_position', 'register_source', 'create_person_role', 'update_record'
  )),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'updated', 'reused')),
  previous_version INTEGER,
  committed_version INTEGER NOT NULL CHECK (committed_version > 0),
  inverse_json TEXT NOT NULL CHECK (json_valid(inverse_json) AND length(inverse_json) <= 32768),
  PRIMARY KEY (batch_id, item_index)
) STRICT;

CREATE INDEX sync_batch_items_target ON sync_batch_items(entity, target_id);
