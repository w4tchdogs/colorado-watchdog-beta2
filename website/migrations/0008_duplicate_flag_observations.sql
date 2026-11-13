CREATE TABLE person_duplicate_flag_observations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  -- These identifier snapshots outlive reversible lifecycle rows and source records.
  duplicate_flag_id TEXT NOT NULL CHECK (length(trim(duplicate_flag_id)) > 0),
  pair_low_id TEXT NOT NULL CHECK (length(trim(pair_low_id)) > 0),
  pair_high_id TEXT NOT NULL CHECK (length(trim(pair_high_id)) > 0),
  batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  report_position INTEGER NOT NULL CHECK (report_position BETWEEN 0 AND 19),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(CAST(reason AS BLOB)) <= 500),
  evidence_source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(evidence_source_ids_json) AND length(evidence_source_ids_json) <= 8192
  ),
  observed_at TEXT NOT NULL,
  CHECK (pair_low_id < pair_high_id),
  UNIQUE (batch_id, report_position)
) STRICT;

CREATE INDEX person_duplicate_flag_observations_actor
  ON person_duplicate_flag_observations(actor_account_id, observed_at, id);
CREATE INDEX person_duplicate_flag_observations_flag
  ON person_duplicate_flag_observations(duplicate_flag_id, batch_id);

INSERT INTO person_duplicate_flag_observations
  (id, duplicate_flag_id, pair_low_id, pair_high_id, batch_id, actor_account_id,
   report_position, reason, evidence_source_ids_json, observed_at)
SELECT 'legacy-observation:' || id, id, pair_low_id, pair_high_id,
       origin_batch_id, origin_actor_account_id,
       ROW_NUMBER() OVER (PARTITION BY origin_batch_id ORDER BY id) - 1,
       reason, evidence_source_ids_json, created_at
FROM person_duplicate_flags;
