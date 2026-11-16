"""Synthetic tests for the source page type plan, apply and verify commands."""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from research import source_types
from research.__main__ import main
from research.db import connect, migrate

NOW = "2026-11-13T12:00:00+00:00"
ROOT = Path(__file__).resolve().parents[1]


class SourceTypeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "research.sqlite"
        self.db = connect(self.database)
        migrate(self.db)
        self.db.executemany(
            "INSERT INTO sources(id,original_url,page_type,official_status,publisher_classification,recorded_at) "
            "VALUES (?,?,?,?,?,?)",
            [("s_page", "https://example.invalid/staff", None, "official", "official", NOW),
             ("s_pdf", "https://example.invalid/files/Org%20Chart.PDF?v=2", None, "official", "official", NOW),
             ("s_dotted", "https://example.invalid/v1.2/staff", None, "official", "official", NOW),
             ("s_unknown", "https://example.invalid/other", None, "unknown", "unresolved", NOW),
             ("s_set", "https://example.invalid/set", "other_public", "official", "official", NOW)],
        )
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temporary.cleanup()

    def run_cli(self, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main([*argv])
        return code, json.loads(out.getvalue())

    def test_url_rule(self):
        self.assertEqual(source_types.classify_url("https://x.invalid/a.pdf"), "public_document")
        self.assertEqual(source_types.classify_url("https://x.invalid/a.pdf?x=1"), "public_document")
        self.assertEqual(source_types.classify_url("https://x.invalid/v1.2/staff"), "official_page")
        self.assertEqual(source_types.classify_url("https://x.invalid/"), "official_page")

    def test_plan_covers_only_unset_official_sources(self):
        plan = source_types.build_page_type_plan(self.db)
        found = {e["source_id"]: e["page_type"] for e in plan["entries"]}
        self.assertEqual(found, {"s_page": "official_page", "s_pdf": "public_document",
                                 "s_dotted": "official_page"})
        self.assertEqual(plan["summary"]["skipped_by_reason"],
                         {"already_has_page_type": 1, "not_classified_official": 1})

    def test_cli_preview_is_read_only_then_apply_verify_and_replay_refused(self):
        plan_path = self.root / "plan.json"
        before = self.database.read_bytes()
        code, preview = self.run_cli("preview-source-types", str(self.database),
                                     "--output", str(plan_path))
        self.assertEqual(code, 0)
        self.assertEqual(preview["planned"], 3)
        self.assertEqual(self.database.read_bytes(), before)
        sha = preview["plan_sha256"]
        code, applied = self.run_cli("apply-source-types", str(self.database),
                                     "--plan", str(plan_path), "--expect-plan-sha256", sha)
        self.assertEqual((code, applied["updated"]), (0, 3))
        rows = dict(self.db.execute("SELECT id,page_type FROM sources").fetchall())
        self.assertEqual(rows["s_pdf"], "public_document")
        self.assertEqual(rows["s_set"], "other_public")
        self.assertIsNone(rows["s_unknown"])
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM research_events WHERE kind='source_page_type_set'").fetchone()[0], 3)
        code, verified = self.run_cli("verify-source-types", str(self.database),
                                      "--plan", str(plan_path), "--expect-plan-sha256", sha)
        self.assertEqual((code, verified["status"], verified["mismatched"]), (0, "verified", 0))
        code, replay = self.run_cli("apply-source-types", str(self.database),
                                    "--plan", str(plan_path), "--expect-plan-sha256", sha)
        self.assertEqual(code, 2)

    def test_wrong_hash_and_tampered_plan_are_refused(self):
        plan_path = self.root / "plan.json"
        _, preview = self.run_cli("preview-source-types", str(self.database),
                                  "--output", str(plan_path))
        code, _ = self.run_cli("apply-source-types", str(self.database),
                               "--plan", str(plan_path), "--expect-plan-sha256", "0" * 64)
        self.assertEqual(code, 2)
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        plan["entries"][0]["page_type"] = "other_public"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        code, _ = self.run_cli("apply-source-types", str(self.database),
                               "--plan", str(plan_path), "--expect-plan-sha256", preview["plan_sha256"])
        self.assertEqual(code, 2)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM sources WHERE page_type IS NULL AND official_status='official'").fetchone()[0], 3)

    def test_drift_rolls_back_everything(self):
        plan = source_types.build_page_type_plan(self.db)
        self.db.execute("UPDATE sources SET page_type='other_public' WHERE id='s_pdf'")
        self.db.commit()
        with self.assertRaises(ValueError):
            source_types.apply_page_type_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertIsNone(self.db.execute(
            "SELECT page_type FROM sources WHERE id='s_page'").fetchone()[0])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM research_events").fetchone()[0], 0)

    def test_plan_inside_checkout_is_refused(self):
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            self.run_cli("preview-source-types", str(self.database),
                         "--output", str(ROOT / "plan-should-not-exist.json"))
        self.assertFalse((ROOT / "plan-should-not-exist.json").exists())


if __name__ == "__main__":
    unittest.main()
