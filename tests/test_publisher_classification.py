"""Synthetic publisher-classification plan and audit tests."""

import json
import tempfile
import unittest
from pathlib import Path

from research.db import connect, migrate
from research.operator import classify_publisher
from research.publisher import apply_plan, build_plan, verify_plan

NOW = "2026-11-15T12:00:00+00:00"


class PublisherClassificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = connect(Path(self.tmp.name) / "synthetic.sqlite")
        migrate(self.db)
        self.db.execute("INSERT INTO county VALUES ('08001','Adams')")
        self.db.execute("INSERT INTO research_runs(id,kind,provenance,actor,started_at,ended_at,recorded_at) "
                        "VALUES('run_synth','mapping','synthetic','fixture',?,?,?)", (NOW, NOW, NOW))
        self.db.executemany('INSERT INTO research_sources("Source ID","Original source URL","Previous source category","Recorded on") VALUES(?,?,?,?)',
                            [("source_prior", "https://example.invalid/government", "official", NOW),
                             ("source_unknown", "https://example.invalid/unresolved", "unknown", NOW),
                             ("source_partner", "https://example.invalid/partner", "partner", NOW)])
        for source_id in ("source_prior", "source_unknown", "source_partner"):
            url = self.db.execute('SELECT "Original source URL" AS original_url FROM research_sources WHERE "Source ID"=?', (source_id,)).fetchone()[0]
            self.db.execute('INSERT INTO research_evidence("Evidence record ID","Source ID","Source title as observed","Source URL as observed","Evidence location","Research run ID","Recorded on") '
                            "VALUES(?,?,?,?,?,'run_synth',?)",
                            ("evidence_" + source_id, source_id, "Synthetic evidence", url, "paragraph 1", NOW))
        detail = {"before": {"official_status": "unknown"}, "after": {"official_status": "official"},
                  "supporting_evidence_id": "evidence_source_prior", "basis": "Synthetic prior review",
                  "operator": "synthetic-reviewer"}
        self.db.execute("INSERT INTO research_history(id,run_id,kind,entity_type,entity_id,occurred_at,recorded_at,provenance,detail_json) "
                        "VALUES('event_prior','run_synth','source_classified','sources','source_prior',?,?, 'reconstructed',?)",
                        (NOW, NOW, json.dumps(detail)))
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_plan_maps_only_audited_official_and_keeps_unresolved_exception(self):
        plan = build_plan(self.db)
        self.assertEqual(plan["summary"]["proposed"], 1)
        self.assertEqual(plan["summary"]["unofficial_proposed"], 0)
        self.assertEqual(plan["summary"]["exception_counts"]["publisher_not_established_from_retained_evidence"], 2)
        self.assertEqual(plan["entries"][0]["source_id"], "source_prior")
        result = apply_plan(self.db, plan, expected_sha256=plan["plan_sha256"], actor="synthetic-operator")
        self.assertEqual(result["applied"], 1)
        self.assertEqual(verify_plan(self.db, plan)["mismatches"], 0)
        self.assertEqual(apply_plan(self.db, plan, expected_sha256=plan["plan_sha256"])["status"], "already_applied")
        audit = self.db.execute("SELECT detail_json FROM research_history WHERE kind='source_publisher_classified'").fetchone()
        detail = json.loads(audit[0])
        self.assertEqual(detail["before"], {"publisher_classification": "unresolved", "official_status": "official"})
        self.assertEqual(detail["after"], {"publisher_classification": "official", "official_status": "official"})

    def test_stale_plan_aborts_and_unofficial_operator_preserves_partner_status(self):
        plan = build_plan(self.db)
        self.db.execute("UPDATE research_sources SET \"Original source URL\"='https://example.invalid/changed' WHERE \"Source ID\"='source_unknown'")
        self.db.commit()
        with self.assertRaisesRegex(ValueError, "changed after preview"):
            apply_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        result = classify_publisher(self.db, source_id="source_partner", classification="unofficial",
                                    actor="synthetic-operator", basis="Publisher explicitly identified in synthetic evidence.",
                                    evidence_id="evidence_source_partner")
        self.assertTrue(result["changed"])
        row = self.db.execute("SELECT \"Previous source category\" AS official_status,\"Publisher type\" AS publisher_classification FROM research_sources WHERE \"Source ID\"='source_partner'").fetchone()
        self.assertEqual(tuple(row), ("partner", "unofficial"))


if __name__ == "__main__":
    unittest.main()
