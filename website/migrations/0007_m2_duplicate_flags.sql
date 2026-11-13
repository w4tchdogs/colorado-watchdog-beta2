CREATE TABLE person_duplicate_flags (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  possible_duplicate_person_id TEXT NOT NULL REFERENCES people(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  pair_low_id TEXT NOT NULL CHECK (length(trim(pair_low_id)) > 0),
  pair_high_id TEXT NOT NULL CHECK (length(trim(pair_high_id)) > 0),
  category TEXT NOT NULL CHECK (category = 'possible_match'),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(CAST(reason AS BLOB)) <= 500),
  nonblocking INTEGER NOT NULL CHECK (nonblocking = 1),
  evidence_source_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(evidence_source_ids_json) AND length(evidence_source_ids_json) <= 8192
  ),
  origin_batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  origin_actor_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'resolved')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  status_changed_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (person_id <> possible_duplicate_person_id),
  CHECK (pair_low_id < pair_high_id),
  CHECK (
    (pair_low_id = person_id AND pair_high_id = possible_duplicate_person_id)
    OR (pair_low_id = possible_duplicate_person_id AND pair_high_id = person_id)
  ),
  UNIQUE (pair_low_id, pair_high_id)
) STRICT;

CREATE INDEX person_duplicate_flags_origin
  ON person_duplicate_flags(origin_actor_account_id, origin_batch_id);
CREATE INDEX person_duplicate_flags_person ON person_duplicate_flags(person_id);
CREATE INDEX person_duplicate_flags_other ON person_duplicate_flags(possible_duplicate_person_id);
CREATE INDEX person_duplicate_flags_status
  ON person_duplicate_flags(origin_actor_account_id, status, created_at);
