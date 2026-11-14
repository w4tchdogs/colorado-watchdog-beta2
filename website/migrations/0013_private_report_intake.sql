CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  county_fips TEXT NOT NULL REFERENCES counties(fips) ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_kind TEXT CHECK (subject_kind IS NULL OR subject_kind IN ('person', 'organization')),
  subject_id TEXT,
  private_json TEXT NOT NULL CHECK (json_valid(private_json)),
  status TEXT NOT NULL CHECK (status IN ('submitted', 'triage', 'under-review', 'needs-information', 'accepted', 'declined', 'closed')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  CHECK ((subject_kind IS NULL) = (subject_id IS NULL))
) STRICT;

CREATE TABLE report_receipts (
  report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE RESTRICT,
  reference TEXT NOT NULL UNIQUE,
  credential_digest TEXT NOT NULL CHECK (length(credential_digest) = 64 AND credential_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE report_idempotency (
  actor_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  PRIMARY KEY (actor_scope, idempotency_key)
) STRICT;

CREATE TABLE report_evidence (
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  evidence_id TEXT NOT NULL,
  private_json TEXT NOT NULL CHECK (json_valid(private_json)),
  PRIMARY KEY (report_id, evidence_id)
) STRICT;

CREATE TABLE report_status_history (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  occurred_at TEXT NOT NULL,
  private_note TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (report_id, version)
) STRICT;

CREATE TABLE report_audit (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('submitted', 'status-changed')),
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  occurred_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  UNIQUE (report_id, version)
) STRICT;

CREATE INDEX reports_staff_queue ON reports(status, created_at);
CREATE INDEX reports_county_created ON reports(county_fips, created_at);
CREATE INDEX reports_subject_created ON reports(subject_kind, subject_id, created_at);
CREATE INDEX reports_reporter_created ON reports(json_extract(private_json, '$.reporter.accountId'), created_at);

CREATE TRIGGER reports_subject_exists_insert
BEFORE INSERT ON reports
WHEN NEW.subject_kind IS NOT NULL AND NOT (
  (NEW.subject_kind = 'person' AND EXISTS (SELECT 1 FROM people WHERE id = NEW.subject_id))
  OR
  (NEW.subject_kind = 'organization' AND EXISTS (SELECT 1 FROM organizations WHERE id = NEW.subject_id))
)
BEGIN
  SELECT RAISE(ABORT, 'report subject does not exist');
END;
