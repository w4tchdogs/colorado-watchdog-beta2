CREATE TABLE sync_submissions (
    id TEXT PRIMARY KEY,
    site_key TEXT NOT NULL CHECK(length(trim(site_key)) BETWEEN 1 AND 128),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
    contract_version TEXT NOT NULL CHECK(contract_version = 'm2-sync/v1'),
    request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64
        AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending', 'acknowledged', 'rejected')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_attempt_at TEXT,
    response_status INTEGER CHECK(response_status BETWEEN 100 AND 599),
    response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
    remote_batch_id TEXT,
    UNIQUE(site_key, idempotency_key),
    CHECK(
        (state = 'pending' AND response_status IS NULL AND response_json IS NULL
            AND remote_batch_id IS NULL)
        OR (state = 'acknowledged' AND response_status BETWEEN 200 AND 299
            AND response_json IS NOT NULL AND length(trim(remote_batch_id)) > 0)
        OR (state = 'rejected' AND response_status BETWEEN 400 AND 499
            AND response_json IS NOT NULL AND remote_batch_id IS NULL)
    )
) STRICT;

CREATE INDEX sync_submissions_pending ON sync_submissions(state, updated_at)
    WHERE state = 'pending';
