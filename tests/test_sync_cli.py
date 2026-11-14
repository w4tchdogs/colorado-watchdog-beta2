"""Synthetic coverage for the local Profiles synchronization operator commands."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from research.db import connect, migrate
from research.mapping import canonical_json
from research.submission import get_submission, submit_prepared
from research import __main__ as cli


SITE = "synthetic-site"
KEY = "synthetic-r8-key"
REQUEST_ID = "6b5f57a2-84b7-4a4d-b300-33aea9feeb19"


def generated():
    change = {
        "op": "create_person",
        "entity": "people",
        "clientRef": "research-person-001",
        "fields": {"display_name": "Synthetic Example Person"},
    }
    return {
        "request": {
            "contractVersion": "m2-sync/v1",
            "requestId": REQUEST_ID,
            "intent": "commit",
            "changes": [change],
        },
        "items": [{
            "item_index": 0,
            "client_ref": "research-person-001",
            "website_entity": "people",
            "local_entity_type": None,
            "local_entity_id": None,
            "evidence_id": None,
            "claim_id": None,
            "request_item_json": canonical_json(change),
        }],
        "eligible_count": 1,
        "excluded": [{"entity_type": "role_claim", "entity_id": "claim-synthetic-2",
                      "reason": "identity_unresolved"}],
        "truncated": False,
    }


class SyncCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name, "fictional.sqlite")
        self.db = connect(self.path)
        migrate(self.db)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def run_command(self, command, **kwargs):
        args = SimpleNamespace(command=command, database=self.path, **kwargs)
        return cli._sync_command(args, self.path)

    def test_preview_is_read_only_deterministic_and_explains_exclusions(self):
        plan = generated()
        before = self.db.execute("SELECT count(*) FROM sync_submissions").fetchone()[0]
        with patch.object(cli.sync, "build_changeset", return_value=plan):
            first, _ = self.run_command("sync-preview", site_key=SITE, max_changes=200)
            second, _ = self.run_command("sync-preview", site_key=SITE, max_changes=200)
        self.assertEqual(first["changeset_fingerprint"], second["changeset_fingerprint"])
        self.assertEqual(first["excluded"][0]["reason"], "identity_unresolved")
        self.assertEqual(first["safety"]["private_information"], "never_emitted")
        self.assertEqual(self.db.execute("SELECT count(*) FROM sync_submissions").fetchone()[0], before)
        encoded = json.dumps(first, sort_keys=True)
        self.assertNotIn("private_note", encoded)
        self.assertNotIn("raw_research", encoded)

    def test_prepare_requires_fingerprint_and_is_idempotent(self):
        plan = generated()
        with patch.object(cli.sync, "build_changeset", return_value=plan):
            preview, _ = self.run_command("sync-preview", site_key=SITE, max_changes=200)
            with self.assertRaisesRegex(ValueError, "fingerprint"):
                self.run_command("sync-prepare", site_key=SITE, idempotency_key=KEY,
                                 select="all", expect_fingerprint="0" * 64, max_changes=200)
            first, _ = self.run_command("sync-prepare", site_key=SITE, idempotency_key=KEY,
                                        select="all", expect_fingerprint=preview["changeset_fingerprint"],
                                        max_changes=200)
            again, _ = self.run_command("sync-prepare", site_key=SITE, idempotency_key=KEY,
                                        select="all", expect_fingerprint=preview["changeset_fingerprint"],
                                        max_changes=200)
        self.assertTrue(first["created"])
        self.assertFalse(again["created"])
        self.assertEqual(first["submission_id"], again["submission_id"])
        with self.assertRaisesRegex(ValueError, "different local research lineage"):
            with patch.object(cli.sync, "build_changeset", return_value={**plan, "items": []}):
                self.run_command("sync-prepare", site_key=SITE, idempotency_key=KEY,
                                 select="all", expect_fingerprint=preview["changeset_fingerprint"],
                                 max_changes=200)

    def test_status_hides_stored_response_and_reconcile_requires_stored_receipt(self):
        plan = generated()
        with patch.object(cli.sync, "build_changeset", return_value=plan):
            preview, _ = self.run_command("sync-preview", site_key=SITE, max_changes=200)
            prepared, _ = self.run_command("sync-prepare", site_key=SITE, idempotency_key=KEY,
                                            select="all", expect_fingerprint=preview["changeset_fingerprint"],
                                            max_changes=200)
        sid = prepared["submission_id"]
        with self.assertRaisesRegex(ValueError, "uncertain"):
            self.run_command("sync-reconcile", submission_id=sid)
        self.db.close()
        self.db = connect(self.path)

        def transport(*_args):
            receipt = {"status": "committed", "batchId": "synthetic-batch-1", "items": [{
                "itemIndex": 0, "clientRef": "research-person-001", "entity": "people",
                "websiteId": "synthetic-website-person-1", "version": 1, "outcome": "created",
            }]}
            return 200, json.dumps(receipt).encode()

        submit_prepared(self.db, sid, transport)
        record = get_submission(self.db, sid)
        self.assertEqual(record["state"], "acknowledged")
        status, _ = self.run_command("sync-status", submission_id=sid)
        self.assertNotIn("response", status)
        result, _ = self.run_command("sync-reconcile", submission_id=sid)
        replay, _ = self.run_command("sync-reconcile", submission_id=sid)
        self.assertEqual(result["state"], "committed")
        self.assertTrue(replay["replayed"])


if __name__ == "__main__":
    unittest.main()
