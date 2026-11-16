-- A committed batch stores its full result so an exact replay returns the same
-- item list. The 64 KiB limit allowed only about 450 items per batch. This
-- widens it to 1,900,000 bytes, which holds batches of 10,000 changes and stays
-- inside the 2 MB row limit of D1. Reversal results hold no item list and keep
-- their existing limit.
--
-- sync_batches is referenced with ON DELETE RESTRICT by sync_batch_items,
-- sync_batch_reversals, person_duplicate_flags and
-- person_duplicate_flag_observations, so it cannot be dropped while they hold
-- rows. Their rows are staged in plain tables, the parent is rebuilt with the
-- wider check, and the rows are restored unchanged. The four child tables keep
-- their definitions, indexes and triggers. Rows, IDs, fingerprints and result
-- text are copied exactly.
CREATE TABLE sync_batches_wide (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  contract_version TEXT NOT NULL CHECK (contract_version = 'm2-sync/v1'),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status = 'committed'),
  committed_at TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 1900000),
  UNIQUE (actor_account_id, idempotency_key)
) STRICT;

INSERT INTO sync_batches_wide (
  id, actor_account_id, idempotency_key, request_fingerprint, contract_version,
  request_id, status, committed_at, result_json
)
SELECT
  id, actor_account_id, idempotency_key, request_fingerprint, contract_version,
  request_id, status, committed_at, result_json
FROM sync_batches;

CREATE TABLE sync_rebuild_items AS SELECT * FROM sync_batch_items;
CREATE TABLE sync_rebuild_reversals AS SELECT * FROM sync_batch_reversals;
CREATE TABLE sync_rebuild_flags AS SELECT * FROM person_duplicate_flags;
CREATE TABLE sync_rebuild_observations AS SELECT * FROM person_duplicate_flag_observations;

DELETE FROM person_duplicate_flag_observations;
DELETE FROM person_duplicate_flags;
DELETE FROM sync_batch_reversals;
DELETE FROM sync_batch_items;

DROP TABLE sync_batches;
ALTER TABLE sync_batches_wide RENAME TO sync_batches;

INSERT INTO sync_batch_items SELECT * FROM sync_rebuild_items;
INSERT INTO sync_batch_reversals SELECT * FROM sync_rebuild_reversals;
INSERT INTO person_duplicate_flags SELECT * FROM sync_rebuild_flags;
INSERT INTO person_duplicate_flag_observations SELECT * FROM sync_rebuild_observations;

DROP TABLE sync_rebuild_items;
DROP TABLE sync_rebuild_reversals;
DROP TABLE sync_rebuild_flags;
DROP TABLE sync_rebuild_observations;

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
