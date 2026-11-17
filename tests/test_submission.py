"""Synthetic checks for durable, retry-safe local Website submissions."""

import hashlib
import json
import shutil
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from research.db import MIGRATIONS, connect, migrate
from research.submission import (
    COMMIT_PATH,
    IdempotencyConflictError,
    SubmissionError,
    get_submission,
    prepare_submission,
    submit_prepared,
)
from research.sync import reconcile_reversal, reconcile_submission

NOW = "2026-11-13T12:00:00+00:00"
SITE = "synthetic-site"
KEY = "synthetic-idempotency-key-01"
REQUEST = {
    "contractVersion": "m2-sync/v1",
    "requestId": "6b5f57a2-84b7-4a4d-b300-33aea9feeb19",
    "intent": "commit",
    "changes": [
        {
            "op": "create_person",
            "entity": "people",
            "clientRef": "fictional-person",
            "fields": {"display_name": "Synthetic Example Person"},
        }
    ],
}


def request_text(**changes):
    return json.dumps({**REQUEST, **changes}, separators=(",", ":"))


def committed_response(batch_id="website-batch-synthetic-1"):
    return json.dumps(
        {
            "status": "committed",
            "batchId": batch_id,
            "requestId": REQUEST["requestId"],
            "committedAt": NOW,
            "replayed": False,
            "items": [],
            "errors": [],
        },
        separators=(",", ":"),
    ).encode()


class SubmissionCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name, "synthetic-research.sqlite")
        self.db = connect(self.path)
        migrate(self.db)
        self.db.execute("INSERT INTO county VALUES ('08031', 'Denver')")
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temporary.cleanup()

    def reopen(self):
        self.db.close()
        self.db = connect(self.path)

    def prepare(self, payload=None, key=KEY):
        return prepare_submission(
            self.db,
            SITE,
            key,
            payload if payload is not None else request_text(),
            now=NOW,
        )


class SubmissionMigrationTests(unittest.TestCase):
    def test_v5_rename_preserves_pending_bytes_and_reconciled_receipts(self):
        original = json.dumps(REQUEST, indent=2) + "\n"
        canonical = json.dumps(REQUEST, sort_keys=True, separators=(",", ":"))
        fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
        committed = json.dumps(json.loads(committed_response()), sort_keys=True, separators=(",", ":"))
        reversal = {"status": "reverted", "batchId": "website-batch-synthetic-1",
                    "reversalId": "synthetic-reversal", "reversedAt": NOW}
        reversal_json = json.dumps(reversal, sort_keys=True, separators=(",", ":"))

        with closing(connect()) as db:
            migrate(db, through_version=5)
            db.executemany(
                "INSERT INTO sync_submissions "
                "(id,site_key,idempotency_key,contract_version,request_fingerprint,request_json,created_at,updated_at) "
                "VALUES (?,?,?,'m2-sync/v1',?,?,?,?)",
                [("pending", SITE, KEY, fingerprint, original, NOW, NOW),
                 ("finished", SITE, "synthetic-finished", fingerprint, original, NOW, NOW)],
            )
            batch_id = reversal["batchId"]
            db.execute(
                "UPDATE sync_submissions SET state='acknowledged',response_status=200,response_json=?,remote_batch_id=? "
                "WHERE id='finished'", (committed, batch_id),
            )
            db.execute(
                "INSERT INTO sync_submission_receipts VALUES ('finished','committed',?,?,?)",
                (batch_id, committed, NOW),
            )
            db.execute(
                "INSERT INTO sync_reversal_receipts VALUES ('reversal',?,?,?,'reverted',?,?)",
                (SITE, batch_id, hashlib.sha256(reversal_json.encode()).hexdigest(), reversal_json, NOW),
            )
            db.commit()

            migrate(db)
            self.assertEqual(get_submission(db, "pending")["request_fingerprint"], fingerprint)
            sent = []

            def transport(site_key, path, headers, body):
                sent.append((site_key, path, headers["idempotency-key"], body))
                return 200, committed_response("still-pending-now-committed")

            self.assertEqual(submit_prepared(db, "pending", transport, now=NOW)["state"], "acknowledged")
            self.assertEqual(sent, [(SITE, COMMIT_PATH, KEY, original.encode())])
            self.assertEqual(
                reconcile_submission(db, "finished", now=NOW),
                {"state": "committed", "replayed": True, "batch_id": batch_id},
            )
            self.assertEqual(
                reconcile_reversal(db, SITE, batch_id, reversal, now=NOW),
                {"state": "reverted", "replayed": True},
            )

    def test_additive_migration_preserves_populated_synthetic_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            migration_dir = Path(directory, "migrations")
            migration_dir.mkdir()
            shutil.copyfile(MIGRATIONS / "001_foundation.sql", migration_dir / "001_foundation.sql")
            db = connect(Path(directory, "before-upgrade.sqlite"))
            try:
                migrate(db, migration_dir)
                db.execute("INSERT INTO counties VALUES ('08031', 'Denver')")
                db.commit()
                now = "2026-11-13T12:00:00+00:00"
                url = "https://example.invalid/pre-upgrade"
                db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) "
                           "VALUES ('run','screening','synthetic',?)", (now,))
                db.execute("INSERT INTO sources(id,original_url,recorded_at) VALUES ('source',?,?)", (url, now))
                db.execute("INSERT INTO evidence_links(id,source_id,observed_url,locator,run_id,recorded_at) "
                           "VALUES ('evidence','source',?,'synthetic section','run',?)", (url, now))
                db.execute("INSERT INTO role_claims(id,county_fips,evidence_id,published_name,source_listing_status) "
                           "VALUES ('claim','08031','evidence','Synthetic Example','Listed')")
                db.commit()

                queries = {
                    "county": "SELECT fips,name FROM counties",
                    "claim": "SELECT id,published_name,source_listing_status FROM role_claims",
                    "evidence": "SELECT id,raw_record_sha256,batch_id FROM evidence_links",
                }
                before = {key: tuple(db.execute(sql).fetchone()) for key, sql in queries.items()}

                shutil.copyfile(
                    MIGRATIONS / "002_durable_site_submissions.sql",
                    migration_dir / "002_durable_site_submissions.sql",
                )
                migrate(db, migration_dir)

                after = {key: tuple(db.execute(sql).fetchone()) for key, sql in queries.items()}
                self.assertEqual(after, before)
                self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
                self.assertEqual(
                    db.execute("SELECT COUNT(*) FROM sync_submissions").fetchone()[0], 0
                )
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            finally:
                db.close()


class DurableSubmissionTests(SubmissionCase):
    def test_request_is_persisted_before_transport_and_ack_is_durable(self):
        original = request_text()
        staged = self.prepare(original)
        row = self.db.execute(
            "SELECT request_json, request_fingerprint, attempt_count, state "
            "FROM website_requests WHERE id=?",
            (staged["submission_id"],),
        ).fetchone()
        self.assertEqual(row["request_json"], original)
        canonical = json.dumps(REQUEST, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.assertEqual(row["request_fingerprint"], hashlib.sha256(canonical.encode()).hexdigest())
        self.assertEqual((row["attempt_count"], row["state"]), (0, "pending"))

        calls = []

        def transport(site_key, path, headers, body):
            calls.append((site_key, path, headers, body))
            return 200, committed_response()

        result = submit_prepared(self.db, staged["submission_id"], transport, now=NOW)
        self.assertEqual(result["state"], "acknowledged")
        self.assertEqual(result["remote_batch_id"], "website-batch-synthetic-1")
        self.assertEqual(calls, [(SITE, COMMIT_PATH, {
            "content-type": "application/json",
            "idempotency-key": KEY,
        }, original.encode())])
        self.assertEqual(get_submission(self.db, staged["submission_id"])["state"], "acknowledged")

        replay = submit_prepared(
            self.db,
            staged["submission_id"],
            lambda *_: self.fail("terminal receipt must not be resubmitted"),
            now=NOW,
        )
        self.assertEqual(replay, result)

    def test_uncertain_outcome_reopens_and_retries_exact_payload_and_key(self):
        original = request_text()
        staged = self.prepare(original)
        sent = []

        def uncertain(site_key, path, headers, body):
            sent.append((site_key, path, headers, body))
            raise TimeoutError("synthetic lost response")

        first = submit_prepared(self.db, staged["submission_id"], uncertain, now=NOW)
        self.assertEqual(first["state"], "uncertain")
        self.assertEqual(get_submission(self.db, staged["submission_id"])["state"], "pending")
        self.assertEqual(get_submission(self.db, staged["submission_id"])["attempt_count"], 1)

        self.reopen()
        second = submit_prepared(
            self.db,
            staged["submission_id"],
            lambda site, path, headers, body: (
                sent.append((site, path, headers, body)) or (200, committed_response())
            ),
            now=NOW,
        )
        self.assertEqual(second["state"], "acknowledged")
        self.assertEqual(sent[0], sent[1])
        self.assertEqual(sent[1][3], original.encode())
        self.assertEqual(sent[1][2]["idempotency-key"], KEY)
        self.assertEqual(get_submission(self.db, staged["submission_id"])["attempt_count"], 2)

    def test_server_error_is_uncertain_but_definite_client_rejection_is_terminal(self):
        staged = self.prepare()
        uncertain = submit_prepared(
            self.db,
            staged["submission_id"],
            lambda *_: (503, b'{"error":"temporarily_unavailable"}'),
            now=NOW,
        )
        self.assertEqual(uncertain["state"], "uncertain")
        self.assertEqual(get_submission(self.db, staged["submission_id"])["state"], "pending")

        for status_code in (408, 429):
            with self.subTest(status_code=status_code):
                retryable_id = self.prepare(key=f"retryable-key-{status_code}")["submission_id"]
                retryable = submit_prepared(
                    self.db,
                    retryable_id,
                    lambda *_: (status_code, b'{"error":"retry_later"}'),
                    now=NOW,
                )
                self.assertEqual(retryable["state"], "uncertain")
                self.assertEqual(get_submission(self.db, retryable_id)["state"], "pending")

        rejected_id = self.prepare(key="rejected-key-1")["submission_id"]
        rejected = submit_prepared(
            self.db,
            rejected_id,
            lambda *_: (422, b'{"status":"rejected","errors":[{"code":"commit_conflict"}]}'),
            now=NOW,
        )
        self.assertEqual(rejected["state"], "rejected")
        self.assertEqual(rejected["response_status"], 422)
        replay = submit_prepared(
            self.db,
            rejected_id,
            lambda *_: self.fail("rejected request must not be silently retried"),
            now=NOW,
        )
        self.assertEqual(replay, rejected)

    def test_key_is_site_scoped_immutable_and_uses_canonical_fingerprint(self):
        first_text = request_text()
        first = self.prepare(first_text)
        reordered = json.dumps(REQUEST, sort_keys=True, ensure_ascii=False)
        same_key = self.prepare(reordered)
        self.assertFalse(same_key["created"])
        self.assertEqual(same_key["submission_id"], first["submission_id"])
        self.assertEqual(
            self.db.execute(
                "SELECT request_json FROM website_requests WHERE id=?",
                (first["submission_id"],),
            ).fetchone()[0],
            first_text,
        )

        changed = request_text(changes=[{
            **REQUEST["changes"][0],
            "fields": {"display_name": "Different Synthetic Example"},
        }])
        with self.assertRaises(IdempotencyConflictError):
            self.prepare(changed)
        other_site = prepare_submission(
            self.db, "another-synthetic-site", KEY, first_text, now=NOW
        )
        self.assertTrue(other_site["created"])

    def test_invalid_and_ambiguous_requests_fail_before_persistence(self):
        invalid = [
            "not json",
            '{"contractVersion":"m2-sync/v1","contractVersion":"m2-sync/v1"}',
            request_text(intent="dry_run"),
            request_text(extra="unsupported"),
            request_text(requestId="not-a-uuid"),
        ]
        for text in invalid:
            with self.subTest(text=text), self.assertRaises(SubmissionError):
                self.prepare(text)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM website_requests").fetchone()[0], 0)

    def test_local_transactions_are_not_taken_over(self):
        self.db.execute("BEGIN")
        with self.assertRaisesRegex(SubmissionError, "current transaction"):
            self.prepare()
        self.db.rollback()
