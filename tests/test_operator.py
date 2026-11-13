import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from research.db import connect, migrate
from research.mapping import COUNTIES
from research.operator import (
    associate_claim, inspect_claims, inspect_coverage, inspect_events, inspect_sources,
    record_visit, update_coverage,
)
from research.store import ingest_csv
from tests.research_fixtures import observation, csv_bytes

NOW = "2026-11-12T12:00:00+00:00"


class OperatorCase(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.executemany("INSERT INTO counties VALUES (?,?)",
                            [(fips, COUNTIES[fips]) for fips in ("08107", "08031")])
        self.db.commit()
        self.batch = ingest_csv(self.db, csv_bytes([observation()]), file_name="synthetic.csv",
                                version_label="fixture-v1", selected=True)
        self.claim = self.db.execute("SELECT * FROM role_claims").fetchone()
        self.source_id = self.db.execute("SELECT source_id FROM evidence_links WHERE id=?",
                                         (self.claim["evidence_id"],)).fetchone()[0]
        self.db.execute("UPDATE sources SET official_status='official' WHERE id=?", (self.source_id,))
        self.db.execute("INSERT INTO org_units(id,county_fips,source_label,kind) VALUES ('unit-1','08107','Fixture unit','department')")
        self.run_id = self.db.execute("SELECT id FROM research_runs ORDER BY recorded_at DESC LIMIT 1").fetchone()[0]
        self.db.commit()
        self.event_count = self.db.execute("SELECT count(*) FROM research_events").fetchone()[0]

    def tearDown(self):
        self.db.close()

    def person(self, person_id="person-1", county="08107", name="Synthetic Rowan Example"):
        self.db.execute("INSERT INTO research_people(id,county_fips,display_name) VALUES (?,?,?)",
                        (person_id, county, name))
        self.db.commit()

    def supporting_variant(self, person_id="person-1", evidence_id=None):
        self.db.execute("INSERT INTO name_variants(id,person_id,published_name,kind,evidence_id) VALUES (?,?,?,?,?)",
                        ("variant-" + person_id, person_id, self.claim["published_name"], "published",
                         evidence_id or self.claim["evidence_id"]))
        self.db.commit()

    def test_evidence_supported_association_preserves_observation_and_audits_actor(self):
        self.person()
        self.supporting_variant()
        raw_before = self.db.execute("SELECT raw_record_json FROM evidence_links WHERE id=?",
                                     (self.claim["evidence_id"],)).fetchone()[0]
        result = associate_claim(self.db, claim_id=self.claim["id"], person_id="person-1",
                                 evidence_id=self.claim["evidence_id"], rationale="Fixture source supports this published-name link",
                                 actor="synthetic-operator")
        self.assertEqual(tuple(self.db.execute("SELECT person_id,published_name FROM role_claims WHERE id=?",
                                               (self.claim["id"],)).fetchone()),
                         ("person-1", "Synthetic Rowan Example"))
        self.assertEqual(self.db.execute("SELECT raw_record_json FROM evidence_links WHERE id=?",
                                         (self.claim["evidence_id"],)).fetchone()[0], raw_before)
        run = self.db.execute("SELECT actor,kind FROM research_runs WHERE id=?", (result["run_id"],)).fetchone()
        self.assertEqual(tuple(run), ("synthetic-operator", "screening"))
        event = self.db.execute("SELECT detail_json FROM research_events WHERE run_id=?", (result["run_id"],)).fetchone()
        detail = json.loads(event[0])
        self.assertEqual(detail["operator"], "synthetic-operator")
        self.assertEqual(detail["supporting_evidence_id"], self.claim["evidence_id"])

    def test_unsupported_or_cross_county_association_rolls_back_and_stays_unassigned(self):
        self.person()
        before_runs = self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0]
        for person_id, evidence_id in (("person-1", self.claim["evidence_id"]),):
            with self.assertRaisesRegex(ValueError, "Supporting evidence"):
                associate_claim(self.db, claim_id=self.claim["id"], person_id=person_id,
                                evidence_id=evidence_id, rationale="not supported", actor="operator")
        self.person("person-other-county", "08031")
        with self.assertRaisesRegex(ValueError, "same county"):
            associate_claim(self.db, claim_id=self.claim["id"], person_id="person-other-county",
                            evidence_id=self.claim["evidence_id"], rationale="cross county", actor="operator")
        self.assertIsNone(self.db.execute("SELECT person_id FROM role_claims WHERE id=?", (self.claim["id"],)).fetchone()[0])
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], self.event_count)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0], before_runs)
        self.assertEqual(len(inspect_claims(self.db, unassigned=True)), 1)

    def test_read_only_inspection_and_cli_do_not_change_disk_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "synthetic.sqlite")
            disk = connect(path)
            migrate(disk)
            disk.executemany("INSERT INTO counties VALUES (?,?)",
                             [(fips, COUNTIES[fips]) for fips in ("08107", "08031")])
            disk.commit()
            ingest_csv(disk, csv_bytes([observation()]), file_name="synthetic.csv", version_label="fixture-v1")
            disk.close()
            before = path.read_bytes()
            command = [sys.executable, "-B", "-m", "research", "unassigned", str(path)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)[0]["published_name"], "Synthetic Rowan Example")
            self.assertEqual(path.read_bytes(), before)

    def test_visit_keeps_reported_outcome_and_unknown_telemetry_null(self):
        result = record_visit(self.db, source_id=self.source_id, run_id=self.run_id, provenance="observed",
                              outcome="blocked", actor="synthetic-operator")
        visit = self.db.execute("SELECT outcome,attempted_at,http_status,duration_ms,content_sha256,etag,last_modified,result_count "
                                "FROM source_visits WHERE id=?", (result["visit_id"],)).fetchone()
        self.assertEqual(tuple(visit), ("blocked", None, None, None, None, None, None, None))
        event = inspect_events(self.db, entity_id=result["visit_id"])[0]
        self.assertEqual(event["details"]["operator"], "synthetic-operator")
        self.assertEqual(inspect_sources(self.db, source_id=self.source_id)[0]["visits"][0]["outcome"], "blocked")

    def test_reconstructed_visit_requires_same_source_evidence(self):
        with self.assertRaisesRegex(ValueError, "require supporting evidence"):
            record_visit(self.db, source_id=self.source_id, run_id=self.run_id, provenance="reconstructed",
                         outcome="blocked", actor="operator")
        with self.assertRaisesRegex(ValueError, "belong to the selected source"):
            record_visit(self.db, source_id=self.source_id, run_id=self.run_id, provenance="reconstructed",
                         outcome="blocked", actor="operator", evidence_id="missing")
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], self.event_count)

    def test_zero_yield_success_is_allowed(self):
        result = record_visit(self.db, source_id=self.source_id, run_id=self.run_id, provenance="synthetic",
                              outcome="success", actor="synthetic-operator", result_count=0)
        self.assertEqual(tuple(self.db.execute("SELECT outcome,result_count FROM source_visits WHERE id=?",
                                               (result["visit_id"],)).fetchone()), ("success", 0))

    def test_one_axis_coverage_update_preserves_the_other_axes(self):
        evidence_id = self.claim["evidence_id"]
        update_coverage(self.db, unit_id="unit-1", axis="structure", status="partial",
                        evidence_id=evidence_id, run_id=self.run_id, actor="operator", rationale="Synthetic scope")
        rows = {row["axis"]: row["status"] for row in inspect_coverage(self.db, unit_id="unit-1")}
        self.assertEqual(rows, {"structure": "partial", "leadership": "not_started",
                                "named_staff": "not_started", "positions": "not_started"})
        event = inspect_events(self.db, kind="coverage_axis_updated")[0]
        self.assertEqual(event["details"]["axis"], "structure")
        self.assertEqual(event["details"]["operator"], "operator")

    def test_non_not_started_coverage_requires_evidence_and_run(self):
        with self.assertRaisesRegex(ValueError, "requires evidence"):
            update_coverage(self.db, unit_id="unit-1", axis="leadership", status="reviewed",
                            evidence_id=None, run_id=self.run_id, actor="operator", rationale="missing")
        with self.assertRaisesRegex(ValueError, "research run"):
            update_coverage(self.db, unit_id="unit-1", axis="leadership", status="reviewed",
                            evidence_id=self.claim["evidence_id"], run_id="missing", actor="operator", rationale="missing")
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], self.event_count)

    def test_event_failure_rolls_back_coverage_and_visit_changes(self):
        self.db.execute("CREATE TRIGGER block_operator_events BEFORE INSERT ON research_events "
                        "BEGIN SELECT RAISE(ABORT,'synthetic event rejection'); END")
        self.db.commit()
        before_status = self.db.execute("SELECT status FROM unit_coverage WHERE unit_id='unit-1' AND axis='structure'").fetchone()[0]
        with self.assertRaises(sqlite3.IntegrityError):
            update_coverage(self.db, unit_id="unit-1", axis="structure", status="partial",
                            evidence_id=self.claim["evidence_id"], run_id=self.run_id,
                            actor="operator", rationale="must roll back")
        with self.assertRaises(sqlite3.IntegrityError):
            record_visit(self.db, source_id=self.source_id, run_id=self.run_id, provenance="observed",
                         outcome="failed", actor="operator")
        self.assertEqual(self.db.execute("SELECT status FROM unit_coverage WHERE unit_id='unit-1' AND axis='structure'").fetchone()[0], before_status)
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], self.event_count)

    def test_nested_visit_and_coverage_updates_refuse_without_caller_rollback(self):
        self.db.execute("BEGIN IMMEDIATE")
        self.db.execute("INSERT INTO counties VALUES ('08001','Adams')")
        with self.assertRaisesRegex(ValueError, "Finish the current transaction"):
            record_visit(self.db, source_id=self.source_id, run_id=self.run_id, provenance="observed",
                         outcome="blocked", actor="operator")
        with self.assertRaisesRegex(ValueError, "Finish the current transaction"):
            update_coverage(self.db, unit_id="unit-1", axis="structure", status="partial",
                            evidence_id=self.claim["evidence_id"], run_id=self.run_id,
                            actor="operator", rationale="nested fixture")
        self.assertTrue(self.db.in_transaction)
        self.assertEqual(self.db.execute("SELECT count(*) FROM counties WHERE fips='08001'").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], self.event_count)
        self.db.commit()
        self.assertEqual(self.db.execute("SELECT count(*) FROM counties WHERE fips='08001'").fetchone()[0], 1)
        visit = record_visit(self.db, source_id=self.source_id, run_id=self.run_id, provenance="observed",
                             outcome="blocked", actor="synthetic-operator")
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits WHERE id=?",
                                         (visit["visit_id"],)).fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
