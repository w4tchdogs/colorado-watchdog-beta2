"""Synthetic tests for the evidence-led organizational foundation."""

import unittest
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from research.db import connect, migrate
from research.mapping import FIELDS_17, COUNTIES
from research.store import ingest_csv
from research.structure import (apply_structure_plan, build_structure_plan,
                                plan_sha256, _check_same_county)
from tests.research_fixtures import csv_bytes


def _observation(county="08107", **changes):
    values = dict.fromkeys(FIELDS_17, "")
    values.update(
        county_fips=county, county=COUNTIES[county], full_name="Synthetic Rowan Example",
        source_title="Fictional county personnel list", source_url=f"https://example.invalid/{county}/staff",
        source_date="2025-03", checked_date="2026-11-12",
        display_group="Synthetic grouping", grouping_basis="Official county structure",
        listing_status="Listed in official source",
        private_note="SYNTHETIC ONLY; no real person or county structure.",
    )
    values.update(changes)
    return [values[field] for field in FIELDS_17]


class StructureFoundationTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.executemany("INSERT INTO counties VALUES (?,?)",
                            [(fips, COUNTIES[fips]) for fips in ("08107", "08031", "08123")])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def ingest(self, rows, *, version="v1", lineage="original", parent=None, selected=False):
        return ingest_csv(
            self.db, csv_bytes(rows), file_name=f"{version}.csv", version_label=version,
            provenance="synthetic", lineage_kind=lineage, parent_batch_id=parent, selected=selected,
        )

    def fixture_rows(self):
        return [
            _observation(department="Community Development Department", division="Public Health",
                         title="Director", full_name="Synthetic Alex Example"),
            _observation(department="Community Development Department", division="Public Health",
                         title="Director", full_name="Synthetic Blake Example"),
            _observation(department="Community Development Department", division="Public Health",
                         title="Compliance Specialist", listing_status="Explicitly former"),
            _observation(department="Fifth Judicial District Attorney", division="",
                         title="Deputy District Attorney"),
            _observation(department="County Clerk", display_group="Directory Staff Menu",
                         grouping_basis="Directory display fallback", title="Clerk"),
            _observation(department="Unverified Unit", display_group="Unverified Unit",
                         grouping_basis="Needs editorial review", title="Coordinator"),
            _observation(department="Planning Department", division="", title=""),
            _observation(department="Clerk and Recorder", division="", title="Clerk"),
            _observation(department="Historic Office", division="", title="Director",
                         listing_status="Explicitly former"),
        ]

    def test_county_local_units_navigation_partners_and_exact_position_types(self):
        self.ingest(self.fixture_rows())
        plan = build_structure_plan(self.db)
        self.assertEqual(plan["summary"]["counties_processed"], 1)
        self.assertEqual(plan["summary"]["claims_evaluated"], 9)
        by_label = {unit["source_label"]: unit for unit in plan["units"]}
        self.assertEqual(by_label["Community Development Department"]["kind"], "department")
        self.assertEqual(by_label["Public Health"]["kind"], "division")
        self.assertEqual(by_label["Public Health"]["parent_relation"], "administrative")
        self.assertEqual(by_label["Fifth Judicial District Attorney"]["kind"], "partner")
        self.assertEqual(by_label["Directory Staff Menu"]["kind"], "navigation")
        self.assertEqual(by_label["Unverified Unit"]["kind"], "unknown")
        self.assertEqual(by_label["Clerk and Recorder"]["kind"], "unknown")
        director = [target for target in plan["targets"] if target["documented_title"] == "Director"]
        self.assertEqual(len(director), 1)
        self.assertEqual(len(director[0]["claim_ids"]), 2)
        titles = {target["documented_title"] for target in plan["targets"]}
        self.assertNotIn("Compliance Specialist", titles)
        self.assertIn("Deputy District Attorney", titles)
        regional_target = next(target for target in plan["targets"]
                               if target["documented_title"] == "Deputy District Attorney")
        self.assertEqual(next(unit for unit in plan["units"] if unit["id"] == regional_target["unit_id"])["kind"],
                         "partner")
        navigation_claim = next(claim for claim in plan["claim_links"] if claim["unit_kind"] == "navigation")
        self.assertIsNone(navigation_claim["target_id"])  # navigation fallback does not establish an organization
        self.assertNotIn("Coordinator", titles)  # editorial-review association stays unresolved
        self.assertNotIn("Director", {target["documented_title"] for target in plan["targets"]
                                      if target["unit_id"] == by_label["Historic Office"]["id"]})

    def test_nonadditive_version_history_and_former_roles_remain_evidence(self):
        original = self.ingest(self.fixture_rows()[:1], version="original", selected=False)
        revised = self.ingest([_observation(department="Community Development Department",
                                            division="Public Health", title="Director",
                                            full_name="Synthetic Alternate Example")],
                              version="revised", lineage="corrected", parent=original, selected=True)
        plan = build_structure_plan(self.db)
        self.assertEqual(plan["input"]["batch_count"], 2)
        self.assertEqual({version["lineage_kind"] for version in plan["input"]["batch_versions"]},
                         {"original", "corrected"})
        self.assertEqual(sum(link["selected"] for link in plan["claim_links"]), 1)
        self.assertEqual(plan["summary"]["claims_evaluated"], 2)
        self.assertEqual(len(plan["targets"]), 1)
        self.assertEqual(self.db.execute("SELECT count(*) FROM role_claims").fetchone()[0], 2)

    def test_apply_and_exact_rerun_are_idempotent_and_leave_coverage_and_identity_alone(self):
        self.ingest(self.fixture_rows())
        plan = build_structure_plan(self.db)
        digest = plan_sha256(plan)
        first = apply_structure_plan(self.db, plan, expected_sha256=digest, actor="synthetic-test")
        event_count = self.db.execute("SELECT count(*) FROM research_events").fetchone()[0]
        second = apply_structure_plan(self.db, plan, expected_sha256=digest, actor="synthetic-test")
        self.assertEqual(first["status"], "applied")
        self.assertEqual(second["status"], "already_applied")
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], event_count)
        self.assertEqual(self.db.execute('SELECT count(*) FROM role_claims WHERE "Linked office or unit" IS NOT NULL').fetchone()[0], 9)
        self.assertEqual(self.db.execute('SELECT count(*) FROM role_claims WHERE "Linked position" IS NOT NULL').fetchone()[0], 4)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_people").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM possible_matches").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM source_visits").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM unit_coverage WHERE status<>'not_started'").fetchone()[0], 0)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_incremental_application_audits_only_new_decisions(self):
        self.ingest(self.fixture_rows(), version="initial")
        first_plan = build_structure_plan(self.db)
        first = apply_structure_plan(self.db, first_plan,
                                     expected_sha256=plan_sha256(first_plan), actor="synthetic-test")

        self.ingest([_observation(department="Community Development Department", division="Public Health",
                                  title="Deputy Director", full_name="Synthetic Casey Example",
                                  source_url="https://example.invalid/08107/second-staff")],
                    version="incremental")
        event_count_before = self.db.execute("SELECT count(*) FROM research_events").fetchone()[0]
        incremental = build_structure_plan(self.db)
        self.assertEqual(len(incremental["event_changes"]["claims"]), 1)
        self.assertLess(incremental["summary"]["incremental_audit_events"],
                        len(incremental["claim_links"]))

        applied = apply_structure_plan(self.db, incremental,
                                       expected_sha256=plan_sha256(incremental), actor="synthetic-test")
        event_count_after = self.db.execute("SELECT count(*) FROM research_events").fetchone()[0]
        self.assertEqual(applied["status"], "applied")
        self.assertEqual(event_count_after - event_count_before, applied["audit_events"])
        self.assertEqual(self.db.execute(
            "SELECT count(*) FROM research_events WHERE run_id=? AND kind='role_claim_structure_linked'",
            (applied["run_id"],)).fetchone()[0], 1)

        repeated = apply_structure_plan(self.db, incremental,
                                        expected_sha256=plan_sha256(incremental), actor="synthetic-test")
        self.assertEqual(repeated["status"], "already_applied")
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], event_count_after)
        self.assertEqual(first["status"], "applied")

    def test_changed_preview_is_rejected_before_writes(self):
        self.ingest(self.fixture_rows()[:1])
        plan = build_structure_plan(self.db)
        self.ingest([_observation(department="Another Department", division="", title="Analyst")],
                    version="added")
        with self.assertRaisesRegex(ValueError, "changed after the preview"):
            apply_structure_plan(self.db, plan, expected_sha256=plan_sha256(plan), actor="synthetic-test")
        self.assertEqual(self.db.execute("SELECT count(*) FROM org_units").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events").fetchone()[0], 2)

    def test_application_rolls_back_on_conflicting_name_record(self):
        self.ingest(self.fixture_rows()[:1])
        plan = build_structure_plan(self.db)
        unit = plan["units"][0]
        name = plan["names"][0]
        self.db.execute('INSERT INTO org_units("Office or unit ID","County code","Office or unit label as published","Organization type") VALUES (?,?,?,?)',
                        (unit["id"], unit["county_fips"], unit["source_label"], unit["kind"]))
        self.db.execute("INSERT INTO org_names VALUES (?,?,?,?,?,?,?)",
                        (name["id"], unit["id"], "Contradictory synthetic name", "published",
                         name["evidence_id"], None, None))
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "Conflicting existing organization name"):
            apply_structure_plan(self.db, plan, expected_sha256=plan_sha256(plan), actor="synthetic-test")
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_runs WHERE note LIKE 'org-position-foundation/%'").fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM role_claims WHERE "Linked office or unit" IS NOT NULL').fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM role_targets").fetchone()[0], 0)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_cross_county_parent_is_rejected(self):
        self.ingest([_observation(department="Community Department", division="Public Health")])
        self.ingest([_observation(county="08031", department="Community Department", division="Public Health")],
                    version="other-county")
        plan = build_structure_plan(self.db)
        applied = apply_structure_plan(self.db, plan, expected_sha256=plan_sha256(plan), actor="synthetic-test")
        children = [unit for unit in plan["units"] if unit["kind"] == "division"]
        parents = [unit for unit in plan["units"] if unit["kind"] == "department"]
        self.assertEqual(len(children), 2)
        self.assertEqual(len(parents), 2)
        with self.assertRaisesRegex(ValueError, "Cross-county"):
            _check_same_county(self.db, children[0]["id"], parents[1]["id"])
        self.assertEqual(applied["counties_processed"], 2)

    def test_private_cli_preview_apply_and_verify_require_explicit_plan_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory, "research.sqlite")
            plan_path = Path(directory, "private-plan.json")
            db = connect(database)
            migrate(db)
            db.execute("INSERT INTO counties VALUES (?,?)", ("08107", COUNTIES["08107"]))
            db.commit()
            ingest_csv(db, csv_bytes(self.fixture_rows()), file_name="fictional.csv",
                       version_label="fictional-v1", provenance="synthetic")
            db.close()

            command = [sys.executable, "-B", "-m", "research"]
            preview = subprocess.run(command + ["preview-structure", str(database),
                                                "--output", str(plan_path)],
                                     capture_output=True, text=True, check=False)
            self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
            preview_result = json.loads(preview.stdout)
            self.assertEqual(preview_result["status"], "previewed")
            raw_plan = plan_path.read_text(encoding="utf-8")
            self.assertNotIn("Synthetic Rowan Example", raw_plan)
            self.assertIn("Fifth Judicial District Attorney", raw_plan)

            apply_args = ["apply-structure", str(database), "--plan", str(plan_path),
                          "--expect-plan-sha256", preview_result["plan_sha256"],
                          "--actor", "synthetic-test"]
            missing_apply_flag = subprocess.run(command + apply_args, capture_output=True, text=True)
            self.assertNotEqual(missing_apply_flag.returncode, 0)
            applied = subprocess.run(command + apply_args + ["--apply"],
                                     capture_output=True, text=True, check=False)
            self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)
            self.assertEqual(json.loads(applied.stdout)["status"], "applied")

            verified = subprocess.run(command + ["verify-structure", str(database),
                                                 "--plan", str(plan_path)],
                                      capture_output=True, text=True, check=False)
            self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)
            self.assertEqual(json.loads(verified.stdout)["status"], "verified")


if __name__ == "__main__":
    unittest.main()
