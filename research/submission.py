"""Durable local submission records for explicitly prepared Website changesets.

This module has no default network transport. Callers must inject a transport;
it sends only a previously persisted payload and its persisted idempotency key.
"""

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4

COMMIT_PATH = "/internal/sync/changesets/commit"
MAX_REQUEST_BYTES = 8 * 1024 * 1024
_KEY = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_REQUEST_ID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class IdempotencyConflictError(ValueError):
    """The key already belongs to a different canonical request."""


class SubmissionError(ValueError):
    """The request cannot be safely prepared for submission."""


def prepare_submission(db, site_key, idempotency_key, original_payload, *, now=None, before_insert=None):
    """Persist an immutable request before any transport is invoked.

    Exact input JSON is retained for safe retries. The fingerprint is computed
    over canonical JSON so harmless object-key ordering does not change identity.
    `before_insert(db)`, when given, runs inside the same write transaction as the
    insert of a new submission, after the exact-key check, so a guard it applies
    cannot be raced by another connection.
    """
    _validate_key(site_key, "site key")
    _validate_key(idempotency_key, "idempotency key")
    if not isinstance(original_payload, str):
        raise SubmissionError("The original payload must be JSON text")
    if len(original_payload.encode("utf-8")) > MAX_REQUEST_BYTES:
        raise SubmissionError("The request exceeds the Website size limit")
    try:
        payload = json.loads(
            original_payload,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except (json.JSONDecodeError, UnicodeError, ValueError) as error:
        raise SubmissionError("The request must be valid unambiguous JSON") from error
    _validate_payload(payload)
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    timestamp = _timestamp(now)

    _require_idle(db)
    with db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute(
            "SELECT id, request_fingerprint FROM sync_submissions "
            "WHERE site_key=? AND idempotency_key=?",
            (site_key, idempotency_key),
        ).fetchone()
        if existing:
            if existing["request_fingerprint"] != fingerprint:
                raise IdempotencyConflictError(
                    "The idempotency key is already bound to a different request"
                )
            return {"submission_id": existing["id"], "created": False}
        if before_insert is not None:
            before_insert(db)
        submission_id = str(uuid4())
        db.execute(
            """INSERT INTO sync_submissions
               (id, site_key, idempotency_key, contract_version,
                request_fingerprint, request_json, created_at, updated_at)
               VALUES (?, ?, ?, 'm2-sync/v1', ?, ?, ?, ?)""",
            (
                submission_id,
                site_key,
                idempotency_key,
                fingerprint,
                original_payload,
                timestamp,
                timestamp,
            ),
        )
        return {"submission_id": submission_id, "created": True}


def submit_prepared(db, submission_id, transport, *, now=None):
    """Send a prepared request, retaining pending state on uncertain outcomes.

    `transport(site_key, path, headers, body_bytes)` must return
    `(status_code, response_body_bytes)`. Transport errors and 5xx responses are
    reported as uncertain, leaving the exact request available for retry.
    """
    if not callable(transport):
        raise SubmissionError("An explicit transport callback is required")
    _validate_key(submission_id, "submission ID")
    timestamp = _timestamp(now)
    _require_idle(db)
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM sync_submissions WHERE id=?", (submission_id,)
        ).fetchone()
        if row is None:
            raise SubmissionError("The prepared submission was not found")
        if row["state"] != "pending":
            return _stored_result(row)
        db.execute(
            """UPDATE sync_submissions
               SET attempt_count=attempt_count+1, last_attempt_at=?, updated_at=?
               WHERE id=? AND state='pending'""",
            (timestamp, timestamp, submission_id),
        )
        site_key = row["site_key"]
        idempotency_key = row["idempotency_key"]
        body = row["request_json"].encode("utf-8")

    try:
        status_code, response_body = transport(
            site_key,
            COMMIT_PATH,
            {
                "content-type": "application/json",
                "idempotency-key": idempotency_key,
            },
            body,
        )
        response_json = _decode_response(status_code, response_body)
    except Exception:
        return {"state": "uncertain", "submission_id": submission_id}

    if 200 <= status_code <= 299 and _is_commit_receipt(response_json):
        state = "acknowledged"
        remote_batch_id = response_json["batchId"]
    elif status_code not in (408, 429) and 400 <= status_code <= 499:
        state = "rejected"
        remote_batch_id = None
        if response_json is None:
            response_json = {"status": "rejected"}
    else:
        # A server error may have happened after a remote commit. Retain pending.
        return {"state": "uncertain", "submission_id": submission_id}

    encoded_response = json.dumps(
        response_json, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )
    _require_idle(db)
    with db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            """UPDATE sync_submissions
               SET state=?, response_status=?, response_json=?, remote_batch_id=?,
                   updated_at=?
               WHERE id=? AND state='pending'""",
            (
                state,
                status_code,
                encoded_response,
                remote_batch_id,
                _timestamp(now),
                submission_id,
            ),
        )
        saved = db.execute(
            "SELECT * FROM sync_submissions WHERE id=?", (submission_id,)
        ).fetchone()
    return _stored_result(saved)


def get_submission(db, submission_id):
    """Return bounded local state without exposing the stored request body."""
    row = db.execute(
        """SELECT id, site_key, idempotency_key, request_fingerprint, state,
                  attempt_count, created_at, updated_at, last_attempt_at,
                  response_status, remote_batch_id, response_json
           FROM sync_submissions WHERE id=?""",
        (submission_id,),
    ).fetchone()
    if row is None:
        return None
    result = dict(row)
    if result["response_json"] is not None:
        result["response"] = json.loads(result.pop("response_json"))
    else:
        result.pop("response_json")
    return result


def _validate_payload(value):
    if (
        not isinstance(value, dict)
        or value.get("contractVersion") != "m2-sync/v1"
        or value.get("intent") != "commit"
        or not isinstance(value.get("requestId"), str)
        or not _REQUEST_ID.fullmatch(value["requestId"])
        or not isinstance(value.get("changes"), list)
        or len(value["changes"]) < 1
    ):
        raise SubmissionError("The request must be a valid m2-sync/v1 commit")
    if set(value) - {
        "contractVersion",
        "requestId",
        "intent",
        "changes",
        "duplicateFlags",
    }:
        raise SubmissionError("The request contains unsupported fields")


def _validate_key(value, label):
    if not isinstance(value, str) or not _KEY.fullmatch(value):
        raise SubmissionError(f"The {label} is invalid")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON object key")
        value[key] = item
    return value


def _reject_constant(_value):
    raise ValueError("Non-finite JSON numbers are not supported")


def _decode_response(status_code, body):
    if not isinstance(status_code, int) or isinstance(status_code, bool):
        raise ValueError("Invalid response status")
    if not 100 <= status_code <= 599:
        raise ValueError("Invalid response status")
    if not isinstance(body, (bytes, bytearray)) or len(body) > MAX_REQUEST_BYTES:
        raise ValueError("Invalid response body")
    try:
        value = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
    except (json.JSONDecodeError, UnicodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _is_commit_receipt(value):
    return (
        isinstance(value, dict)
        and value.get("status") == "committed"
        and isinstance(value.get("batchId"), str)
        and bool(value["batchId"].strip())
    )


def _stored_result(row):
    return {
        "state": row["state"],
        "submission_id": row["id"],
        "remote_batch_id": row["remote_batch_id"],
        "response_status": row["response_status"],
        "response": json.loads(row["response_json"])
        if row["response_json"] is not None
        else None,
    }


def _timestamp(value):
    if value is None:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Timestamp must be nonempty ISO text")
    return value


def _require_idle(db):
    if db.in_transaction:
        raise SubmissionError("Finish the current transaction before submission")
