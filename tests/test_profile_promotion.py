"""Synthetic acceptance tests for reviewed local Profile promotion."""

import copy
import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from research.__main__ import main
from research.db import connect, migrate
from research.promotion import apply_reviewed_plan, build_preview

NOW = "2026-11-17T12:00:00+00:00"
MANIFEST = "a" * 64


def fixture_db():
    db = connect()
    migrate(db)
    db.execute('INSERT INTO county VALUES (?,?)', ("08001", "Adams"))
    db.execute("INSERT INTO research_runs(id,kind,provenance,recorded_at) VALUES (?,?,?,?)",
               ("seed-run", "screening", "synthetic", NOW))
    db.executemany(
        'INSERT INTO research_sources("Source ID","Original source URL","Document type","Recorded on","Publisher type") VALUES (?,?,?,?,?)',
        [("identity-source", "https://example.test/official/identity", "official_page", NOW, "official"),
         ("role-source", "https://example.test/community/roles", "public_document", NOW, "unofficial")],
    )
    db.execute('INSERT INTO research_evidence("Evidence record ID","Source ID","Source title as observed",'
               '"Source URL as observed","Evidence location","Research run ID","Recorded on") '
               'VALUES (?,?,?,?,?,?,?)',
               ("identity-evidence", "identity-source", "Official identity list",
                "https://example.test/official/identity", "page 1", "seed-run", NOW))
    db.execute('INSERT INTO research_scrapes(id,county_fips,family_id,lineage_kind,selected,version_label,original_file_name,'
               'file_sha256,mapping_version,mapping_json,provenance_type,run_id,recorded_at) '
               'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
               ("batch-original", "08001", "batch-original", "original", 0, "v1", "synthetic.csv",
                "b" * 64, "legacy-17/v1", "{}", "synthetic", "seed-run", NOW))
    people = [("research-office", "Synthetic Office Person"),
              ("research-duties", "Synthetic Duties Person"),
              ("research-invalid", "Synthetic Invalid Person")]
    db.executemany('INSERT INTO profile_research("Profile ID","County code","Full name","Identity review status","Evidence for identity") '
                   'VALUES (?,?,?,?,?)',
                   [(person_id, "08001", name, "evidence_supported", "identity-evidence")
                    for person_id, name in people])

    def add_claim(claim_id, evidence_id, person_id, name, *, office=None, title=None, duties=None, linked=True):
        fingerprint = hashlib.sha256(claim_id.encode()).hexdigest()
        original = json.dumps({"claim": claim_id}, separators=(",", ":"))
        db.execute('INSERT INTO research_evidence("Evidence record ID","Source ID","Source title as observed",'
                   '"Source URL as observed","Evidence location","Import batch ID","Original record",'
                   '"Original record fingerprint","Where the record appeared","Research run ID","Recorded on") '
                   'VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                   (evidence_id, "role-source", "County personnel listing",
                    "https://example.test/community/roles", f"record:{claim_id}", "batch-original",
                    original, fingerprint, "[]", "seed-run", NOW))
        db.execute('INSERT INTO profile_research_role("Role claim ID","County code","Evidence record ID",'
                   '"Linked profile","Name as published","Position as published","Job description or duties",'
                   '"Listing status","Office or department as published") VALUES (?,?,?,?,?,?,?,?,?)',
                   (claim_id, "08001", evidence_id, person_id if linked else None,
                    name, title, duties, "Listed", office))

    add_claim("claim-office", "role-evidence-office", "research-office", people[0][1],
              office="Adams County Clerk's Office")
    add_claim("claim-duties", "role-evidence-duties", "research-duties", people[1][1],
              duties="Maintains county election records")
    add_claim("claim-unlinked", "role-evidence-unlinked", "research-invalid", people[2][1],
              title="Synthetic Reviewer", linked=False)
    db.commit()
    return db


def make_plan(claim_ids):
    candidates = {
        "claim-office": ("research-office", "Synthetic Office Person", {
            "role_claim_ids": ["claim-office"], "office_or_department": "Adams County Clerk's Office",
            "position_title": None, "duties": None, "employment_start_date": None,
            "employment_end_date": None,
            "citations": [{"claim_id": "claim-office", "verified_on": "2026-11-16"}],
        }),
        "claim-duties": ("research-duties", "Synthetic Duties Person", {
            "role_claim_ids": ["claim-duties"], "office_or_department": None, "position_title": None,
            "duties": "Maintains county election records", "employment_start_date": None,
            "employment_end_date": None,
            "citations": [{"claim_id": "claim-duties", "verified_on": "2026-11-16"}],
        }),
        "claim-unlinked": ("research-invalid", "Synthetic Invalid Person", {
            "role_claim_ids": ["claim-unlinked"], "office_or_department": None,
            "position_title": "Synthetic Reviewer", "duties": None, "employment_start_date": None,
            "employment_end_date": None,
            "citations": [{"claim_id": "claim-unlinked", "verified_on": "2026-11-16"}],
        }),
    }
    profiles = []
    for claim_id in claim_ids:
        person_id, name, role = candidates[claim_id]
        profiles.append({"research_profile_id": person_id, "full_name": name,
                         "reviewer_notes": None, "roles": [copy.deepcopy(role)]})
    return {"format": "colorado-watchdog/profile-promotion/v1", "county_code": "08001",
            "batch_id": "batch-original", "manifest_sha256": MANIFEST,
            "reviewed_by": "Synthetic reviewer", "reviewed_on": "2026-11-17",
            "profiles": profiles}


class PromotionCase(unittest.TestCase):
    def setUp(self):
        self.db = fixture_db()
        self.plan = make_plan(["claim-office", "claim-duties"])

    def tearDown(self):
        self.db.close()

    def counts(self):
        return {table: self.db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                for table in ("profile", "profile_county", "profile_role", "profile_evidence",
                              "profile_evidence_citation", "profile_evidence_role", "research_history",
                              "research_runs")}

    def test_preview_and_atomic_first_apply_for_office_only_and_duties_only(self):
        before = self.counts()
        preview = build_preview(self.db, self.plan)
        self.assertEqual((preview["county_code"], preview["county_name"]), ("08001", "Adams"))
        self.assertEqual((preview["profile_count"], preview["role_count"], preview["role_claim_count"]), (2, 2, 2))
        self.assertFalse(preview["batch_selected"])
        self.assertEqual(self.counts(), before)
        applied = apply_reviewed_plan(self.db, self.plan, expected_sha256=preview["plan_sha256"])
        self.assertEqual(applied["status"], "applied")
        self.assertEqual(self.db.execute('SELECT selected FROM research_scrapes WHERE id="batch-original"').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_county').fetchone()[0], 2)
        roles = list(self.db.execute('SELECT "Office or department","Position title","Job description or duties" FROM profile_role ORDER BY "Role ID"'))
        self.assertIn(("Adams County Clerk's Office", None, None), [tuple(row) for row in roles])
        self.assertIn((None, None, "Maintains county election records"), [tuple(row) for row in roles])
        self.assertEqual(self.db.execute('SELECT count(*) FROM profile_revisions').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM website_requests').fetchone()[0], 0)

    def test_stale_source_and_tampered_plan_reject_without_writes(self):
        preview = build_preview(self.db, self.plan)
        before = self.counts()
        self.db.execute('UPDATE research_sources SET "Publisher type"="official" WHERE "Source ID"="role-source"')
        self.db.commit()
        changed = self.counts()
        with self.assertRaisesRegex(ValueError, "stale|exact source"):
            apply_reviewed_plan(self.db, self.plan, expected_sha256=preview["plan_sha256"])
        self.assertEqual(self.counts(), changed)

        fresh = build_preview(self.db, self.plan)
        tampered = copy.deepcopy(self.plan)
        tampered["reviewed_by"] = "Different reviewer"
        unchanged = self.counts()
        with self.assertRaisesRegex(ValueError, "stale|exact source"):
            apply_reviewed_plan(self.db, tampered, expected_sha256=fresh["plan_sha256"])
        self.assertEqual(self.counts(), unchanged)

    def test_unlinked_identity_wrong_county_and_missing_role_reject(self):
        before = self.counts()
        with self.assertRaisesRegex(ValueError, "already link|linked to"):
            build_preview(self.db, make_plan(["claim-unlinked"]))
        wrong_county = copy.deepcopy(self.plan)
        wrong_county["county_code"] = "08031"
        with self.assertRaisesRegex(ValueError, "batch is missing|county"):
            build_preview(self.db, wrong_county)
        no_role = copy.deepcopy(self.plan)
        no_role["profiles"][0]["roles"][0]["office_or_department"] = None
        with self.assertRaisesRegex(ValueError, "office, title, or job description"):
            build_preview(self.db, no_role)
        self.assertEqual(self.counts(), before)

    def test_mid_write_failure_rolls_back_entire_county_batch(self):
        preview = build_preview(self.db, self.plan)
        before = self.counts()

        def fail_after_profile_inserts(db):
            raise RuntimeError("synthetic injected failure")

        with self.assertRaisesRegex(RuntimeError, "injected failure"):
            apply_reviewed_plan(self.db, self.plan, expected_sha256=preview["plan_sha256"],
                                after_write=fail_after_profile_inserts)
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_exact_rerun_reuses_stable_ids_and_detects_row_drift(self):
        preview = build_preview(self.db, self.plan)
        first = apply_reviewed_plan(self.db, self.plan, expected_sha256=preview["plan_sha256"])
        after_first = self.counts()
        second = apply_reviewed_plan(self.db, self.plan, expected_sha256=preview["plan_sha256"])
        self.assertEqual(second["status"], "replayed")
        self.assertEqual(self.counts(), after_first)
        self.db.execute('UPDATE profile_role SET "Office or department"="tampered"')
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "differs from the reviewed plan"):
            apply_reviewed_plan(self.db, self.plan, expected_sha256=preview["plan_sha256"])

    def test_cli_preview_and_apply_use_explicit_private_plan_and_review_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db_path, plan_path = root / "profiles.sqlite", root / "promotion.json"
            destination = connect(db_path)
            self.db.backup(destination)
            destination.close()
            plan_path.write_text(json.dumps(self.plan), encoding="utf-8")
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["preview-profile-promotion", str(db_path), "--plan", str(plan_path)]), 0)
            preview = json.loads(output.getvalue())
            self.assertEqual(preview["status"], "previewed")
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["apply-profile-promotion", str(db_path), "--plan", str(plan_path),
                                       "--expect-plan-sha256", preview["plan_sha256"], "--apply"]), 0)
            self.assertEqual(json.loads(output.getvalue())["status"], "applied")


if __name__ == "__main__":
    unittest.main()
