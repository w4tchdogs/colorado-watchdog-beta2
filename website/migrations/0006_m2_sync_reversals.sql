CREATE TABLE sync_batch_reversals (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  reversed_at TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(result_json) <= 16384),
  UNIQUE (actor_account_id, idempotency_key),
  UNIQUE (batch_id)
) STRICT;

CREATE INDEX sync_batch_reversals_actor_batch
  ON sync_batch_reversals(actor_account_id, batch_id);
