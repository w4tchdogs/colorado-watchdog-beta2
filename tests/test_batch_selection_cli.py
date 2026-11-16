"""CLI round trip for reviewed batch selection and no-selection reversal."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from research import __main__ as cli
from research.db import connect, migrate
from research.mapping import COUNTIES
from research.store import ingest_csv
from tests.research_fixtures import csv_bytes, observation


class BatchSelectionCliTests(unittest.TestCase):
    def test_preview_apply_and_reverse_use_private_hashed_plans(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            database = root / "synthetic.sqlite"
            plan_path = root / "selection-plan.json"
            reverse_path = root / "reversal-plan.json"
            db = connect(database)
            migrate(db)
            db.execute("INSERT INTO counties VALUES ('08001',?)", (COUNTIES["08001"],))
            db.commit()
            batch_id = ingest_csv(db, csv_bytes([observation("08001")]), file_name="synthetic.csv",
                                  version_label="synthetic-unselected", provenance="synthetic")
            db.close()

            def invoke(command, *args):
                stream = io.StringIO()
                with contextlib.redirect_stdout(stream):
                    code = cli.main([command, str(database), *args])
                self.assertEqual(code, 0, stream.getvalue())
                return json.loads(stream.getvalue())

            preview = invoke("preview-batch-selection", "--batch-id", batch_id,
                             "--actor", "fixture-operator", "--reason", "Synthetic reviewed test",
                             "--output", str(plan_path))
            self.assertIsNone(preview["before_batch_id"])
            self.assertEqual(preview["replaced_batch_id"], None)
            applied = invoke("apply-batch-selection", "--plan", str(plan_path),
                             "--expect-plan-sha256", preview["plan_sha256"])
            self.assertEqual(applied["status"], "applied")
            reverse = invoke("preview-batch-selection-reversal", "--event-id", applied["event_id"],
                             "--actor", "fixture-operator", "--reason", "Synthetic restore to none",
                             "--output", str(reverse_path))
            self.assertIsNone(reverse["after_batch_id"])
            restored = invoke("apply-batch-selection-reversal", "--plan", str(reverse_path),
                              "--expect-plan-sha256", reverse["plan_sha256"])
            self.assertEqual(restored["status"], "applied")
            db = connect(database)
            self.assertEqual(db.execute("SELECT count(*) FROM scrape_batches WHERE selected=1").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM research_events WHERE kind LIKE 'batch_selection_%'").fetchone()[0], 2)
            db.close()


if __name__ == "__main__":
    unittest.main()
