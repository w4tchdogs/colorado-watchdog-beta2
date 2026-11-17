"""Synthetic classification, evidence, and replay tests for statewide identity triage."""

import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from research import identity, identity_triage
from research.__main__ import main
from research.db import connect, migrate
from research.mapping import COUNTIES
from research.store import ingest_csv
from tests.research_fixtures import csv_bytes, observation


class IdentityTriageTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.execute("INSERT INTO county VALUES (?,?)", ("08051", COUNTIES["08051"]))
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def add_batch(self, rows, *, url, name="triage.csv", kind="original", parent=None,
                  selected=False, fips="08051"):
        payload = csv_bytes([observation(fips=fips, source_url=url, **row) for row in rows])
        batch_id = ingest_csv(self.db, payload, file_name=name, version_label=name,
                              selected=selected, lineage_kind=kind,
                              parent_batch_id=parent, return_result=False)
        return [dict(row) for row in self.db.execute(
            'SELECT c."Role claim ID" AS id,c."County code" AS county_fips,c."Name as published" AS published_name,c."Evidence record ID" AS evidence_id,c."Linked profile" AS person_id,e."Source ID" AS source_id '
            'FROM profile_research_role c JOIN research_evidence e ON e."Evidence record ID"=c."Evidence record ID" '
            'WHERE e."Import batch ID"=? ORDER BY e."Evidence location"', (batch_id,))]

    def preview(self):
        plan = identity.build_identity_plan(self.db)
        return plan, identity_triage.build_identity_triage_report(self.db, plan)

    def test_full_backlog_is_classified_with_exact_reconciliation_and_evidence(self):
        self.add_batch([{"full_name": "Synthetic Rowan Example", "title": "Fixture Treasurer"}],
                       url="https://example.gov/treasurer")
        self.add_batch([{"full_name": "Synthetic Avery Example", "title": "Fixture Director"}],
                       url="https://example.org/directory")
        self.add_batch([
            {"full_name": "Synthetic Jordan Example", "title": "Fixture Clerk"},
            {"full_name": "Synthetic Jordan Example", "title": "Fixture Recorder"},
        ], url="https://example.gov/clerk")
        self.add_batch([{"full_name": "Synthetic Taylor Example", "title": "Fixture Manager"}],
                       url="https://example.gov/manager", name="original.csv")
        parent_batch = self.db.execute(
            "SELECT id FROM research_scrapes WHERE original_file_name='original.csv'").fetchone()[0]
        self.add_batch([{"full_name": "Synthetic Taylor Example", "title": "Fixture Lead"}],
                       url="https://example.gov/manager", name="alternative.csv", kind="alternative",
                       parent=parent_batch)
        self.add_batch([{"full_name": "Vacant Position", "title": "Fixture Assistant"}],
                       url="https://example.gov/positions")

        plan, report = self.preview()
        summary = report["summary"]
        self.assertEqual(summary["role_claims_unassigned_before"], 7)
        # Both Jordan claims share an office label, so they merge into one profile.
        self.assertEqual(summary["automatically_resolvable"], 4)
        self.assertEqual(summary["source_authority_review"], 1)
        self.assertEqual(summary["genuinely_ambiguous"], 0)
        self.assertEqual(summary["version_or_lineage_dependent"], 1)
        self.assertEqual(summary["ineligible"], 1)
        self.assertEqual(summary["starting_unresolved_claims"], 6)
        self.assertEqual(summary["unresolved_after_supported_actions"], 2)
        self.assertEqual(sum(report["counts_by_current_reason"].values()), 7)
        self.assertEqual(sum(row["total_unassigned_accounted"]
                             for row in report["counts_by_county"].values()), 7)
        self.assertEqual(len(report["cases"]), 7)
        self.assertTrue(all(case["evidence"]["evidence_id"] for case in report["cases"]))
        authority_case = next(case for case in report["cases"]
                              if case["disposition"] == "source_authority_review")
        self.assertEqual(authority_case["evidence"]["source_authority_status"], "unknown")
        self.assertTrue(authority_case["evidence"]["source_url"].endswith("example.org/directory"))
        self.assertEqual(report["summary"]["cross_county_candidate_search"], False)
        self.assertEqual(plan["summary"]["claims_associated"], 4)

    def test_existing_person_candidate_is_separate_from_genuine_ambiguity(self):
        first = self.add_batch([{"full_name": "Synthetic Morgan Example", "title": "Fixture Treasurer"}],
                               url="https://example.gov/treasurer")[0]
        plan = identity.build_identity_plan(self.db)
        identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        existing_person_id = self.db.execute('SELECT "Profile ID" AS id FROM profile_research').fetchone()[0]
        second = self.add_batch([{"full_name": "Synthetic Morgan Example", "title": "Fixture Clerk"}],
                                url="https://example.gov/clerk")[0]
        plan, report = self.preview()
        # The shared office label aligns the new claim with the existing profile.
        association = plan["counties"][0]["associations"][0]
        self.assertEqual(association["claim_id"], second["id"])
        self.assertEqual(association["person_id"], existing_person_id)
        self.assertEqual(association["method"], "same_name_detail_alignment")
        self.assertEqual(association["aligned_details"], ["office"])
        self.assertEqual(plan["summary"]["claims_associated"], 1)
        self.assertEqual(plan["summary"]["new_research_people"], 0)

    def test_unresolved_only_preview_apply_and_exact_replay_write_no_events(self):
        self.add_batch([
            {"full_name": "Synthetic Casey Example", "title": "Fixture Treasurer"},
            {"full_name": "Synthetic Casey Example", "title": "Fixture Clerk"},
        ], url="https://example.org/directory")
        plan, report = self.preview()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "triage.json"
            file_hash = identity_triage.write_triage_report(
                report, path, repository_root=Path(__file__).resolve().parents[1])
            reread = identity_triage.read_triage_report(
                path, repository_root=Path(__file__).resolve().parents[1])
            self.assertEqual(reread["triage_sha256"], report["triage_sha256"])
            self.assertEqual(len(file_hash), 64)
        before = (self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0],
                  self.db.execute("SELECT count(*) FROM research_history").fetchone()[0])
        first = identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        second = identity.apply_identity_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        after = (self.db.execute("SELECT count(*) FROM research_runs").fetchone()[0],
                 self.db.execute("SELECT count(*) FROM research_history").fetchone()[0])
        self.assertEqual(first["status"], "no_changes")
        self.assertEqual(second["status"], "no_changes")
        self.assertEqual(after, before)
        self.assertEqual(identity.verify_identity_application(self.db, plan)["status"], "no_changes_verified")

    def test_cli_hash_checks_report_and_verifies_exact_no_change_replay(self):
        self.add_batch([
            {"full_name": "Synthetic Casey Example", "title": "Fixture Treasurer"},
            {"full_name": "Synthetic Casey Example", "title": "Fixture Clerk"},
        ], url="https://example.org/directory")
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "research.sqlite"
            report_path = Path(directory) / "triage.json"
            disk_db = sqlite3.connect(database)
            try:
                self.db.backup(disk_db)
            finally:
                disk_db.close()

            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["preview-identity-triage", str(database),
                                       "--output", str(report_path)]), 0)
            preview = json.loads(output.getvalue())
            self.assertEqual(preview["status"], "previewed")
            self.assertEqual(preview["automatically_resolvable"], 0)

            with report_path.open("a", encoding="utf-8") as handle:
                handle.write(" ")
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["apply-identity-triage", str(database), "--report", str(report_path),
                                       "--expect-report-sha256", preview["report_file_sha256"]]), 2)
            self.assertIn("does not match", output.getvalue())

            report_path.write_text(report_path.read_text(encoding="utf-8").rstrip() + "\n",
                                   encoding="utf-8", newline="\n")
            correct_hash = hashlib.sha256(report_path.read_bytes()).hexdigest()
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["apply-identity-triage", str(database), "--report", str(report_path),
                                       "--expect-report-sha256", correct_hash]), 0)
            self.assertEqual(json.loads(output.getvalue())["status"], "no_changes")
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["verify-identity-triage", str(database), "--report", str(report_path),
                                       "--expect-report-sha256", correct_hash]), 0)
            self.assertEqual(json.loads(output.getvalue())["status"], "no_changes_verified")

    def test_statewide_triage_scales_to_twenty_thousand_claims(self):
        def alpha(index):
            chars = ""
            value = index
            while True:
                chars = chr(ord("A") + value % 26) + chars
                value = value // 26 - 1
                if value < 0:
                    return chars

        rows = [{"full_name": f"Synthetic Person{alpha(index)} Example", "title": "Fixture Position"}
                for index in range(20000)]
        self.add_batch(rows, url="https://fixture.example.gov/directory", name="volume-20000.csv")
        plan, report = self.preview()
        self.assertEqual(plan["summary"]["role_claims_evaluated"], 20000)
        self.assertEqual(plan["summary"]["claims_associated"], 20000,
                         {"unresolved": plan["counties"][0]["unresolved"][:3],
                          "rejected": plan["counties"][0]["rejected"][:3]})
        self.assertEqual(report["summary"]["role_claims_unassigned_before"], 20000)
        self.assertEqual(report["summary"]["automatically_resolvable"], 20000)
        self.assertEqual(report["summary"]["ineligible"], 0)
        self.assertEqual(report["counts_by_county"]["08051"]["total_unassigned_accounted"], 20000)


if __name__ == "__main__":
    unittest.main()
