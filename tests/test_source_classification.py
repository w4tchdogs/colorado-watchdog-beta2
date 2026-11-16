"""Synthetic source-classification audit tests."""

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from research.db import connect, migrate
from research.operator import classify_source


NOW = "2026-11-13T12:00:00+00:00"


class SourceClassificationCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "research.sqlite"
        self.db = connect(self.database)
        migrate(self.db)
        self.db.executemany(
            "INSERT INTO research_runs(id,kind,provenance,actor,recorded_at) VALUES (?,?,?,?,?)",
            [("run_synthetic_a", "mapping", "synthetic", "fixture", NOW),
             ("run_synthetic_b", "mapping", "synthetic", "fixture", NOW)],
        )
        self.db.executemany(
            "INSERT INTO sources(id,original_url,recorded_at) VALUES (?,?,?)",
            [("source_a", "https://example.invalid/source-a", NOW),
             ("source_b", "https://example.invalid/source-b", NOW)],
        )
        self.db.executemany(
            "INSERT INTO evidence_links(id,source_id,observed_title,observed_url,locator,run_id,recorded_at) "
            "VALUES (?,?,?,?,?,?,?)",
            [("evidence_a", "source_a", "Invented listing", "https://example.invalid/source-a",
              "synthetic section", "run_synthetic_a", NOW),
             ("evidence_b", "source_b", "Invented listing", "https://example.invalid/source-b",
              "synthetic section", "run_synthetic_b", NOW)],
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temporary.cleanup()

    def counts(self):
        return {table: self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                for table in ("research_runs", "research_events", "sources", "source_visits")}

    def test_evidence_attributed_change_is_atomic_and_audited(self):
        result = classify_source(self.db, source_id="source_a", status="official", actor="synthetic-operator",
                                 basis="Synthetic exercise of a reviewed official source record.",
                                 evidence_id="evidence_a")
        self.assertTrue(result["changed"])
        self.assertEqual(result["previous_status"], "unknown")
        self.assertEqual(self.db.execute("SELECT official_status FROM sources WHERE id='source_a'").fetchone()[0],
                         "official")
        run = self.db.execute("SELECT kind,provenance,actor FROM research_runs WHERE id=?",
                              (result["run_id"],)).fetchone()
        self.assertEqual(tuple(run), ("screening", "synthetic", "synthetic-operator"))
        event = self.db.execute("SELECT kind,entity_type,entity_id,detail_json FROM research_events").fetchone()
        detail = json.loads(event["detail_json"])
        self.assertEqual((event["kind"], event["entity_type"], event["entity_id"]),
                         ("source_classified", "sources", "source_a"))
        self.assertEqual(detail["before"], {"official_status": "unknown"})
        self.assertEqual(detail["after"], {"official_status": "official"})
        self.assertEqual(detail["supporting_evidence_id"], "evidence_a")
        self.assertEqual(detail["operator"], "synthetic-operator")
        self.assertEqual(detail["basis"], "Synthetic exercise of a reviewed official source record.")
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)

    def test_repeated_classification_is_idempotent_without_duplicate_audit(self):
        options = {"source_id": "source_a", "status": "official", "actor": "fixture",
                   "basis": "Reviewed synthetic evidence.", "evidence_id": "evidence_a"}
        first = classify_source(self.db, **options)
        counts = self.counts()
        second = classify_source(self.db, **options)
        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        self.assertEqual(second["run_id"], None)
        self.assertEqual(self.counts(), counts)

    def test_existing_status_gets_one_audited_confirmation(self):
        self.db.execute("UPDATE sources SET official_status='official',publisher_classification='official' WHERE id='source_a'")
        self.db.commit()
        options = {"source_id": "source_a", "status": "official", "actor": "fixture",
                   "basis": "Explicit synthetic review of supporting source evidence.",
                   "evidence_id": "evidence_a"}
        first = classify_source(self.db, **options)
        self.assertFalse(first["changed"])
        self.assertTrue(first["recorded"])
        event_count = self.db.execute("SELECT count(*) FROM research_events").fetchone()[0]
        second = classify_source(self.db, **options)
        self.assertFalse(second["recorded"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], event_count)
        event = self.db.execute("SELECT kind,detail_json FROM research_events").fetchone()
        self.assertEqual(event["kind"], "source_classification_confirmed")
        self.assertEqual(json.loads(event["detail_json"])["before"], {"official_status": "official"})

    def test_invalid_source_status_actor_basis_and_evidence_are_refused(self):
        for options in (
            {"source_id": "missing", "status": "official", "actor": "a", "basis": "b"},
            {"source_id": "source_a", "status": "unsupported", "actor": "a", "basis": "b"},
            {"source_id": "source_a", "status": "official", "actor": " ", "basis": "b"},
            {"source_id": "source_a", "status": "official", "actor": "a", "basis": " "},
            {"source_id": "source_a", "status": "official", "actor": "a", "basis": "b",
             "evidence_id": "evidence_b"},
        ):
            with self.subTest(options=options):
                before = self.counts()
                with self.assertRaises(ValueError):
                    classify_source(self.db, **options)
                self.assertEqual(self.counts(), before)
                self.assertEqual(self.db.execute("SELECT official_status FROM sources WHERE id='source_a'")
                                 .fetchone()[0], "unknown")

    def test_failed_audit_insert_rolls_back_source_and_run(self):
        self.db.execute("CREATE TRIGGER fail_source_classification BEFORE INSERT ON research_events "
                        "WHEN NEW.kind='source_classified' BEGIN SELECT RAISE(ABORT,'synthetic event failure'); END")
        self.db.commit()
        before = self.counts()
        with self.assertRaises(sqlite3.IntegrityError):
            classify_source(self.db, source_id="source_a", status="partner", actor="fixture",
                            basis="Synthetic rollback exercise.", evidence_id="evidence_a")
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.db.execute("SELECT official_status FROM sources WHERE id='source_a'").fetchone()[0],
                         "unknown")

    def test_caller_transaction_is_not_rolled_back(self):
        self.db.execute("INSERT INTO sources(id,original_url,recorded_at) VALUES (?,?,?)",
                        ("pending_source", "https://example.invalid/pending", NOW))
        with self.assertRaisesRegex(ValueError, "Finish the current transaction"):
            classify_source(self.db, source_id="source_a", status="official", actor="fixture", basis="synthetic")
        self.assertTrue(self.db.in_transaction)
        self.db.commit()
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM sources WHERE id='pending_source'").fetchone())

    def test_cli_classification_requires_explicit_basis_and_records_audit(self):
        command = [sys.executable, "-B", "-m", "research", "classify-source", str(self.database),
                   "--source-id", "source_a", "--status", "partner", "--actor", "synthetic-operator",
                   "--basis", "Synthetic partner classification fixture.", "--evidence-id", "evidence_a"]
        completed = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(json.loads(completed.stdout)["changed"])
        repeated = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(repeated.returncode, 0, repeated.stderr)
        self.assertFalse(json.loads(repeated.stdout)["changed"])
        missing_basis = subprocess.run(command[:-4], capture_output=True, text=True)
        self.assertNotEqual(missing_basis.returncode, 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
