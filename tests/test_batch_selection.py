"""Synthetic audit and reversal coverage for batch selection operations."""

import json
import unittest

from research.batch_selection import (
    apply_plan, build_reversal_plan, build_selection_plan,
)
from research.db import connect, migrate
from research.mapping import COUNTIES
from research.store import ingest_csv
from tests.research_fixtures import csv_bytes, observation


class BatchSelectionTests(unittest.TestCase):
    def setUp(self):
        self.db = connect()
        migrate(self.db)
        self.db.executemany("INSERT INTO counties VALUES (?,?)",
                            [(fips, COUNTIES[fips]) for fips in ("08001", "08003")])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def batch(self, *, parent=None, lineage="original", selected=False, name="Synthetic Rowan Example"):
        fips = "08001"
        rows = [observation(fips, full_name=name)]
        return ingest_csv(self.db, csv_bytes(rows), file_name=f"{name}.csv", version_label=name,
                          lineage_kind=lineage, parent_batch_id=parent, selected=selected)

    def selections(self, family_id):
        return [row[0] for row in self.db.execute(
            "SELECT id FROM scrape_batches WHERE family_id=? AND selected=1", (family_id,))]

    def test_unselected_family_selects_and_reversal_restores_no_selection(self):
        batch = self.batch()
        family = self.db.execute("SELECT family_id FROM scrape_batches WHERE id=?", (batch,)).fetchone()[0]
        plan = build_selection_plan(self.db, batch_id=batch, actor="synthetic operator",
                                    rationale="Synthetic review selected this version")
        self.assertIsNone(plan["before_batch_id"])
        self.assertEqual(plan["after_batch_id"], batch)
        result = apply_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.selections(family), [batch])
        audit = self.db.execute("SELECT detail_json FROM research_events WHERE id=?", (result["event_id"],)).fetchone()
        detail = json.loads(audit[0])
        self.assertIsNone(detail["before_batch_id"])
        self.assertEqual(detail["after_batch_id"], batch)
        self.assertEqual(detail["operator"], "synthetic operator")
        self.assertIn("Synthetic review", detail["rationale"])
        repeated = apply_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(repeated["status"], "already_applied")
        self.assertEqual(self.db.execute("SELECT count(*) FROM research_events WHERE kind='batch_selection_changed'").fetchone()[0], 1)

        reversal = build_reversal_plan(self.db, event_id=result["event_id"], actor="synthetic operator",
                                       rationale="Undo the synthetic selection")
        self.assertIsNone(reversal["after_batch_id"])
        undone = apply_plan(self.db, reversal, expected_sha256=reversal["plan_sha256"])
        self.assertEqual(undone["status"], "applied")
        self.assertEqual(self.selections(family), [])
        self.assertEqual(self.db.execute("SELECT kind FROM research_events WHERE id=?",
                                         (undone["event_id"],)).fetchone()[0], "batch_selection_reversed")
        self.assertEqual(apply_plan(self.db, reversal, expected_sha256=reversal["plan_sha256"])["status"],
                         "already_applied")

    def test_replacement_and_reversal_restore_previous_batch(self):
        original = self.batch(selected=True)
        replacement = self.batch(parent=original, lineage="alternative", name="Synthetic Replacement Example")
        family = self.db.execute("SELECT family_id FROM scrape_batches WHERE id=?", (original,)).fetchone()[0]
        plan = build_selection_plan(self.db, batch_id=replacement, actor="synthetic operator",
                                    rationale="Synthetic alternate version approved")
        self.assertEqual(plan["before_batch_id"], original)
        self.assertEqual(plan["after_batch_id"], replacement)
        result = apply_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        self.assertEqual(self.selections(family), [replacement])
        reversal = build_reversal_plan(self.db, event_id=result["event_id"], actor="synthetic operator",
                                      rationale="Restore the original synthetic batch")
        apply_plan(self.db, reversal, expected_sha256=reversal["plan_sha256"])
        self.assertEqual(self.selections(family), [original])

    def test_stale_plan_repeated_old_request_and_late_reversal_are_rejected(self):
        original = self.batch(selected=True)
        alt = self.batch(parent=original, lineage="alternative", name="Synthetic Alternate Example")
        plan = build_selection_plan(self.db, batch_id=alt, actor="synthetic operator", rationale="First decision")
        # A newly added family member makes a plan stale even when selected flags did not change.
        self.batch(parent=original, lineage="corrected", name="Synthetic Corrected Example")
        with self.assertRaisesRegex(ValueError, "changed after preview"):
            apply_plan(self.db, plan, expected_sha256=plan["plan_sha256"])
        current_plan = build_selection_plan(self.db, batch_id=alt, actor="synthetic operator",
                                            rationale="Fresh plan after family membership changed")
        first = apply_plan(self.db, current_plan, expected_sha256=current_plan["plan_sha256"])
        later = build_selection_plan(self.db, batch_id=original, actor="synthetic operator", rationale="Later decision")
        apply_plan(self.db, later, expected_sha256=later["plan_sha256"])
        with self.assertRaisesRegex(ValueError, "later family decision"):
            build_reversal_plan(self.db, event_id=first["event_id"], actor="synthetic operator",
                                rationale="Stale reversal")
        with self.assertRaisesRegex(ValueError, "digest"):
            apply_plan(self.db, {**later, "rationale": "tampered"}, expected_sha256=later["plan_sha256"])


if __name__ == "__main__":
    unittest.main()
